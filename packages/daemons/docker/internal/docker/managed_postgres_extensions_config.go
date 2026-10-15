package docker

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/opfield/opfield/docker-daemon/internal/pgext"
)

// managedPostgresExtensionsCapability: the daemon lists and changes the
// curated PostgreSQL extensions of a managed database
// (postgres_extensions_list_v1, postgres_extension_apply_v1) and honours
// postgresConfig.sharedPreloadLibraries and postgresConfig.extensionBundles
// (packages/daemons/postgres-image/README.md).
const managedPostgresExtensionsCapability = "managed_postgres_extensions_v1"

// Refusal codes of the extension commands and settings: the controller maps
// them to UI copy. Errors read "<CODE>: <sentence>".
const (
	extensionNotAllowedCode       = "EXTENSION_NOT_ALLOWED"
	extensionNotAvailableCode     = "EXTENSION_NOT_AVAILABLE"
	extensionNeedsBundleCode      = "EXTENSION_NEEDS_BUNDLE"
	extensionNeedsImageUpdateCode = "EXTENSION_NEEDS_IMAGE_UPDATE"
	extensionNeedsPreloadCode     = "EXTENSION_NEEDS_PRELOAD"
	extensionHasDependentsCode    = "EXTENSION_HAS_DEPENDENTS"
	extensionNotPrimaryCode       = "EXTENSION_NOT_PRIMARY"
	extensionNeedsStorageCode     = "EXTENSION_NEEDS_STORAGE"
	extensionBundleUnavailable    = "EXTENSION_BUNDLE_UNAVAILABLE"
	extensionBundleInvalidCode    = "EXTENSION_BUNDLE_INVALID"
	extensionFailedCode           = "EXTENSION_FAILED"
)

func extensionError(code, format string, args ...any) error {
	return fmt.Errorf("%s: %s", code, fmt.Sprintf(format, args...))
}

var (
	postgresCatalogMu       sync.RWMutex
	postgresCatalogOverride *pgext.Catalog
)

// postgresExtensionCatalog is the compiled-in extension catalog (tests swap
// it with setPostgresExtensionCatalog).
func postgresExtensionCatalog() (*pgext.Catalog, error) {
	postgresCatalogMu.RLock()
	override := postgresCatalogOverride
	postgresCatalogMu.RUnlock()
	if override != nil {
		return override, nil
	}
	return pgext.Default()
}

// setPostgresExtensionCatalog replaces the catalog until the returned restore
// runs (tests).
func setPostgresExtensionCatalog(catalog *pgext.Catalog) (restore func()) {
	postgresCatalogMu.Lock()
	previous := postgresCatalogOverride
	postgresCatalogOverride = catalog
	postgresCatalogMu.Unlock()
	return func() {
		postgresCatalogMu.Lock()
		postgresCatalogOverride = previous
		postgresCatalogMu.Unlock()
	}
}

// curatedPostgresImages are the PostgreSQL images a managed database may run:
// every catalog version's official image and, once pinned, Opfield's image of
// it (pgext/catalog/versions.json). Without a readable catalog none is.
func curatedPostgresImages() map[string]struct{} {
	images := map[string]struct{}{}
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return images
	}
	for _, reference := range catalog.PostgresImages() {
		images[reference] = struct{}{}
	}
	return images
}

// managedPostgresPreloadLibraries are the canonical shared_preload_libraries
// of a command (nil when none or not PostgreSQL; an invalid list is refused
// by validatePostgresExtensionConfig before it is used).
func managedPostgresPreloadLibraries(input managedDatabaseCommand) []string {
	if input.Type != "postgres" || input.PostgresConfig == nil || len(input.PostgresConfig.SharedPreloadLibraries) == 0 {
		return nil
	}
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return nil
	}
	libraries, err := catalog.CanonicalPreload(input.PostgresConfig.SharedPreloadLibraries)
	if err != nil {
		return nil
	}
	return libraries
}

// managedPostgresPreloadKey is what the record keeps of the preload libraries
// a container was created with ("" = none).
func managedPostgresPreloadKey(input managedDatabaseCommand) string {
	return strings.Join(managedPostgresPreloadLibraries(input), ",")
}

// managedPostgresExtensionBundleIDs are the bundle ids a command asks for.
func managedPostgresExtensionBundleIDs(input managedDatabaseCommand) []string {
	if input.Type != "postgres" || input.PostgresConfig == nil {
		return nil
	}
	return input.PostgresConfig.ExtensionBundles
}

// managedPostgresExtensionFlags are the server flags of the preload
// libraries: shared_preload_libraries and the settings they need (pg_cron's
// database). Command-line settings win over
// postgresql.auto.conf, so they hold on set members too.
func managedPostgresExtensionFlags(input managedDatabaseCommand) []string {
	libraries := managedPostgresPreloadLibraries(input)
	if len(libraries) == 0 {
		return nil
	}
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return nil
	}
	flags := []string{"-c", "shared_preload_libraries=" + strings.Join(libraries, ",")}
	settings := catalog.PreloadSettings(libraries, input.DatabaseName)
	keys := make([]string, 0, len(settings))
	for key := range settings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		flags = append(flags, "-c", key+"="+settings[key])
	}
	return flags
}

// validatePostgresExtensionConfig refuses preload libraries and bundles the
// image cannot serve: every name must be in the curated catalog, anything but
// a contrib library needs Opfield's image, a bundle needs a pinned build for
// the image's major and Debian release, and a library from a bundle needs that
// bundle in the command.
func validatePostgresExtensionConfig(input managedDatabaseCommand) error {
	if input.PostgresConfig == nil {
		return nil
	}
	libraries, bundles := input.PostgresConfig.SharedPreloadLibraries, input.PostgresConfig.ExtensionBundles
	if len(libraries) == 0 && len(bundles) == 0 {
		return nil
	}
	if input.Type != "postgres" {
		return errors.New("extension settings are supported only for PostgreSQL")
	}
	if len(libraries) > 32 || len(bundles) > 32 {
		return errors.New("too many extension settings")
	}
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return fmt.Errorf("the extension catalog is unreadable: %w", err)
	}
	canonical, err := catalog.CanonicalPreload(libraries)
	if err != nil {
		return extensionError(extensionNotAllowedCode, "%v", err)
	}
	image := catalog.Image(input.Image)
	needsOpfieldImage := len(bundles) > 0
	for _, name := range canonical {
		if library, _ := catalog.PreloadLibrary(name); library.Delivery != pgext.DeliveryContrib {
			needsOpfieldImage = true
		}
	}
	if needsOpfieldImage && image.Kind != pgext.ImageOpfield {
		return extensionError(extensionNeedsImageUpdateCode, "this extension needs Opfield's PostgreSQL image; update the database's image first")
	}
	closure, err := catalog.BundleClosure(bundles, image.Version.Major, image.Version.Debian)
	if err != nil {
		var unavailable *pgext.BundleUnavailableError
		if errors.As(err, &unavailable) {
			return extensionError(extensionBundleUnavailable, "%v", err)
		}
		return extensionError(extensionNotAllowedCode, "%v", err)
	}
	for _, name := range canonical {
		library, _ := catalog.PreloadLibrary(name)
		if library.Delivery != pgext.DeliveryBundle {
			continue
		}
		if !slices.ContainsFunc(closure, func(bundle pgext.Bundle) bool { return slices.Contains(bundle.PreloadLibraries, name) }) {
			return extensionError(extensionNeedsBundleCode, "preload library %s comes from a bundle the database does not install", name)
		}
	}
	return nil
}
