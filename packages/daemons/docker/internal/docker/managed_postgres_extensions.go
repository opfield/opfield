package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/docker-daemon/internal/pgext"
)

// The curated PostgreSQL extensions of a managed database: the list the
// Extensions tab shows and the DDL that turns one on, off or to its newest
// version. DDL runs in the application database as the control superuser and
// on a set's serving primary only (copies follow through WAL); names outside
// the curated catalog are refused.

const (
	postgresExtensionsListAction = "postgres_extensions_list_v1"
	postgresExtensionApplyAction = "postgres_extension_apply_v1"
)

type postgresExtensionsListCommand struct {
	OwnerUsername string `json:"ownerUsername"`
	OwnerPassword string `json:"ownerPassword"`
	DatabaseName  string `json:"databaseName"`
}

type postgresExtensionApplyCommand struct {
	OperationID              string `json:"operationId"`
	Action                   string `json:"action"`
	Name                     string `json:"name"`
	OwnerUsername            string `json:"ownerUsername"`
	OwnerPassword            string `json:"ownerPassword"`
	DatabaseName             string `json:"databaseName"`
	ApplicationPrincipalName string `json:"applicationPrincipalName"`
}

// postgresExtensionRow is one curated extension as this database sees it.
type postgresExtensionRow struct {
	Name             string   `json:"name"`
	Delivery         string   `json:"delivery"`
	Bundle           *string  `json:"bundle"`
	BundleSizeBytes  int64    `json:"bundleSizeBytes"`
	PreloadLibraries []string `json:"preloadLibraries"`
	AvailableVersion *string  `json:"availableVersion"`
	InstalledVersion *string  `json:"installedVersion"`
	Status           string   `json:"status"`
}

type postgresExtensionsList struct {
	AllowlistVersion           int                    `json:"allowlistVersion"`
	ServerVersionNum           int                    `json:"serverVersionNum"`
	Major                      string                 `json:"major"`
	Debian                     string                 `json:"debian"`
	Arch                       string                 `json:"arch"`
	ImageKind                  string                 `json:"imageKind"`
	SharedPreloadLibraries     []string               `json:"sharedPreloadLibraries"`
	ConfiguredPreloadLibraries []string               `json:"configuredPreloadLibraries"`
	InstalledBundles           []map[string]string    `json:"installedBundles"`
	Volume                     map[string]int64       `json:"volume"`
	Extensions                 []postgresExtensionRow `json:"extensions"`
}

// postgresServerExtensions is what the server reports for the curated names.
type postgresServerExtensions struct {
	ServerVersionNum int    `json:"serverVersionNum"`
	Preload          string `json:"preload"`
	ReadOnly         bool   `json:"readOnly"`
	Available        []struct {
		Name      string  `json:"name"`
		Default   *string `json:"default"`
		Installed *string `json:"installed"`
	} `json:"available"`
}

func validatePostgresExtensionCredentials(owner, password, database string) error {
	if !managedDatabaseName.MatchString(owner) || !managedDatabaseName.MatchString(database) {
		return errors.New("database and owner names must be safe SQL identifiers")
	}
	if len(password) < 16 || len(password) > 512 {
		return errors.New("the owner password must be between 16 and 512 characters")
	}
	return nil
}

// postgresExtensionStatus is a row's status: enabled, update_available,
// available, needs_bundle, needs_image_update or unavailable.
func postgresExtensionStatus(extension pgext.Extension, available, installed *string, imageKind string, bundlePinned, bundleInstalled bool) string {
	switch {
	case installed != nil && available != nil && *installed != *available:
		return "update_available"
	case installed != nil:
		return "enabled"
	case available != nil && (extension.BundleID() == "" || bundleInstalled):
		return "available"
	case extension.Delivery != pgext.DeliveryContrib && imageKind != pgext.ImageOpfield:
		return "needs_image_update"
	case extension.BundleID() != "" && bundlePinned && !bundleInstalled:
		return "needs_bundle"
	default:
		return "unavailable"
	}
}

func (m *managedDatabaseManager) postgresServerExtensions(ctx context.Context, record managedDatabaseRecord, owner, password, database string, names []string) (postgresServerExtensions, error) {
	var state postgresServerExtensions
	out, stderr, err := m.runPostgresExtensionSQL(ctx, record.ContainerID, owner, password, database, postgresServerExtensionsSQL(names)+";\n")
	if errors.Is(err, errPostgresExtensionSQL) {
		return state, postgresExtensionSQLError(stderr)
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &state); err != nil {
		return state, fmt.Errorf("read the server's extensions: %w", err)
	}
	return state, nil
}

// postgresContainerImage is the image reference the database's container runs.
func (m *managedDatabaseManager) postgresContainerImage(ctx context.Context, record managedDatabaseRecord) (string, error) {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect the database container: %w", err)
	}
	if inspect.Container.Config == nil {
		return "", errors.New("the database container has no configuration")
	}
	return inspect.Container.Config.Image, nil
}

// listPostgresExtensions answers postgres_extensions_list_v1.
func (m *managedDatabaseManager) listPostgresExtensions(ctx context.Context, record managedDatabaseRecord, input postgresExtensionsListCommand) (string, error) {
	if record.Type != "postgres" {
		return "", errors.New("extensions are supported only for PostgreSQL")
	}
	if err := validatePostgresExtensionCredentials(input.OwnerUsername, input.OwnerPassword, input.DatabaseName); err != nil {
		return "", err
	}
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return "", err
	}
	reference, err := m.postgresContainerImage(ctx, record)
	if err != nil {
		return "", err
	}
	image := catalog.Image(reference)
	state, err := m.postgresServerExtensions(ctx, record, input.OwnerUsername, input.OwnerPassword, input.DatabaseName, catalog.Names())
	if err != nil {
		return "", err
	}
	major := image.Version.Major
	if major == "" && state.ServerVersionNum > 0 {
		major = fmt.Sprint(state.ServerVersionNum / 10000)
	}
	debian := image.Version.Debian
	if debian == "" {
		debian = catalog.Debian(major)
	}
	installedBundles := installedPostgresBundles(record, major, debian, pgBundleArch)
	result := postgresExtensionsList{
		AllowlistVersion:           catalog.AllowlistVersion(),
		ServerVersionNum:           state.ServerVersionNum,
		Major:                      major,
		Debian:                     debian,
		Arch:                       pgBundleArch,
		ImageKind:                  image.Kind,
		SharedPreloadLibraries:     splitPreloadSetting(state.Preload),
		ConfiguredPreloadLibraries: splitPreloadSetting(record.PostgresPreloadLibraries),
		InstalledBundles:           installedBundles,
		Volume:                     map[string]int64{"freeBytes": 0, "totalBytes": 0},
		Extensions:                 []postgresExtensionRow{},
	}
	if used, total, ok := managedDatabaseDiskUsage(record.MountPath); ok {
		result.Volume = map[string]int64{"freeBytes": total - used, "totalBytes": total}
	}
	server := map[string]int{}
	for index, row := range state.Available {
		server[row.Name] = index
	}
	for _, extension := range catalog.Extensions() {
		row := postgresExtensionRow{Name: extension.Name, Delivery: extension.Delivery, Bundle: extension.Bundle, PreloadLibraries: extension.PreloadLibraries}
		if row.PreloadLibraries == nil {
			row.PreloadLibraries = []string{}
		}
		if index, ok := server[extension.Name]; ok {
			row.AvailableVersion, row.InstalledVersion = state.Available[index].Default, state.Available[index].Installed
		}
		bundlePinned, bundleInstalled := false, false
		if id := extension.BundleID(); id != "" {
			if bundle, ok := catalog.Bundle(id, major, debian); ok {
				bundlePinned = true
				row.BundleSizeBytes = bundle.SizeBytes[pgBundleArch]
			}
			for _, installed := range installedBundles {
				bundleInstalled = bundleInstalled || installed["id"] == id
			}
		}
		row.Status = postgresExtensionStatus(extension, row.AvailableVersion, row.InstalledVersion, image.Kind, bundlePinned, bundleInstalled)
		result.Extensions = append(result.Extensions, row)
	}
	data, err := json.Marshal(result)
	return string(data), err
}

// applyPostgresExtension answers postgres_extension_apply_v1.
func (m *managedDatabaseManager) applyPostgresExtension(ctx context.Context, record managedDatabaseRecord, input postgresExtensionApplyCommand) (string, error) {
	if record.Type != "postgres" {
		return "", errors.New("extensions are supported only for PostgreSQL")
	}
	if err := validatePostgresExtensionCredentials(input.OwnerUsername, input.OwnerPassword, input.DatabaseName); err != nil {
		return "", err
	}
	if input.ApplicationPrincipalName != "" && !managedDatabaseName.MatchString(input.ApplicationPrincipalName) {
		return "", errors.New("the application role name must be a safe SQL identifier")
	}
	if input.Action != "enable" && input.Action != "disable" && input.Action != "update" {
		return "", fmt.Errorf("extension action %q is not enable, disable or update", input.Action)
	}
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return "", err
	}
	extension, ok := catalog.Extension(input.Name)
	if !ok {
		return "", extensionError(extensionNotAllowedCode, "%q is not an extension Opfield offers", input.Name)
	}
	state, err := m.postgresServerExtensions(ctx, record, input.OwnerUsername, input.OwnerPassword, input.DatabaseName, []string{extension.Name})
	if err != nil {
		return "", err
	}
	if state.ReadOnly {
		return "", extensionError(extensionNotPrimaryCode, "this server is a read-only copy; extensions change on the primary")
	}
	var available, installed *string
	for _, row := range state.Available {
		available, installed = row.Default, row.Installed
	}
	switch input.Action {
	case "enable":
		if installed != nil {
			return postgresExtensionApplied(ctx, m, record, input, catalog)
		}
		if available == nil {
			return "", m.postgresExtensionUnavailable(ctx, record, extension, catalog)
		}
		// A baked extension built on a bundle's (h3_postgis on PostGIS) is
		// listed by the server before that bundle is installed.
		if id := extension.BundleID(); id != "" && !postgresBundlePresent(record, id) {
			return "", extensionError(extensionNeedsBundleCode, "%s needs the %s bundle installed on the database first", extension.Name, id)
		}
		loaded := splitPreloadSetting(state.Preload)
		var missing []string
		for _, library := range extension.PreloadLibraries {
			if !containsString(loaded, library) {
				missing = append(missing, library)
			}
		}
		if len(missing) > 0 {
			return "", extensionError(extensionNeedsPreloadCode, "%s needs %s in shared_preload_libraries; restart the database with it first", extension.Name, strings.Join(missing, ", "))
		}
	case "disable":
		if installed == nil {
			return postgresExtensionApplied(ctx, m, record, input, catalog)
		}
	case "update":
		if installed == nil {
			return "", extensionError(extensionNotAvailableCode, "%s is not enabled", extension.Name)
		}
		if available == nil || *installed == *available {
			return postgresExtensionApplied(ctx, m, record, input, catalog)
		}
	}
	_, stderr, err := m.runPostgresExtensionSQL(ctx, record.ContainerID, input.OwnerUsername, input.OwnerPassword, input.DatabaseName, postgresExtensionDDL(input, catalog.Names()))
	if errors.Is(err, errPostgresExtensionSQL) {
		return "", postgresExtensionSQLError(stderr)
	}
	if err != nil {
		return "", err
	}
	m.logger.Info("changed a PostgreSQL extension", "id", record.ID, "action", input.Action, "extension", extension.Name, "operation", input.OperationID)
	return postgresExtensionApplied(ctx, m, record, input, catalog)
}

// postgresBundlePresent reports whether the volume holds a verified build of
// a bundle.
func postgresBundlePresent(record managedDatabaseRecord, id string) bool {
	versions, err := os.ReadDir(filepath.Join(record.MountPath, pgExtensionsDirName, id))
	if err != nil {
		return false
	}
	for _, version := range versions {
		if _, err := os.Stat(filepath.Join(record.MountPath, pgExtensionsDirName, id, version.Name(), pgBundleStampName)); err == nil {
			return true
		}
	}
	return false
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// postgresExtensionUnavailable explains why the server does not offer an
// extension: Opfield's image is missing, its bundle is not installed, or this
// version has none.
func (m *managedDatabaseManager) postgresExtensionUnavailable(ctx context.Context, record managedDatabaseRecord, extension pgext.Extension, catalog *pgext.Catalog) error {
	reference, err := m.postgresContainerImage(ctx, record)
	if err != nil {
		return err
	}
	image := catalog.Image(reference)
	if extension.Delivery != pgext.DeliveryContrib && image.Kind != pgext.ImageOpfield {
		return extensionError(extensionNeedsImageUpdateCode, "%s needs Opfield's PostgreSQL image; update the database's image first", extension.Name)
	}
	if id := extension.BundleID(); id != "" {
		if _, pinned := catalog.Bundle(id, image.Version.Major, image.Version.Debian); pinned {
			return extensionError(extensionNeedsBundleCode, "%s needs the %s bundle installed on the database first", extension.Name, id)
		}
	}
	return extensionError(extensionNotAvailableCode, "%s is not available for this PostgreSQL version", extension.Name)
}

// postgresExtensionApplied reports the extension's state after a change.
func postgresExtensionApplied(ctx context.Context, m *managedDatabaseManager, record managedDatabaseRecord, input postgresExtensionApplyCommand, catalog *pgext.Catalog) (string, error) {
	state, err := m.postgresServerExtensions(ctx, record, input.OwnerUsername, input.OwnerPassword, input.DatabaseName, catalog.Names())
	if err != nil {
		return "", err
	}
	result := struct {
		Status           string   `json:"status"`
		Name             string   `json:"name"`
		InstalledVersion *string  `json:"installedVersion"`
		AvailableVersion *string  `json:"availableVersion"`
		Installed        []string `json:"installed"`
	}{Status: "ok", Name: input.Name, Installed: []string{}}
	for _, row := range state.Available {
		if row.Installed != nil {
			result.Installed = append(result.Installed, row.Name)
		}
		if row.Name == input.Name {
			result.InstalledVersion, result.AvailableVersion = row.Installed, row.Default
		}
	}
	data, err := json.Marshal(result)
	return string(data), err
}

// handlePostgresExtensionAction runs the two extension actions; handled is
// false for any other action.
func (m *managedDatabaseManager) handlePostgresExtensionAction(ctx context.Context, action, id, configJSON string) (bool, string, error) {
	switch action {
	case postgresExtensionsListAction:
		var input postgresExtensionsListCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return true, "", fmt.Errorf("parse the extensions list command: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return true, "", err
		}
		detail, err := m.listPostgresExtensions(ctx, record, input)
		return true, detail, err
	case postgresExtensionApplyAction:
		var input postgresExtensionApplyCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return true, "", fmt.Errorf("parse the extension command: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return true, "", err
		}
		detail, err := m.applyPostgresExtension(ctx, record, input)
		return true, detail, err
	}
	return false, "", nil
}
