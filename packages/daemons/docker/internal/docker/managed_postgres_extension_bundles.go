package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/docker-daemon/internal/pgext"
)

// Downloadable extension bundles (packages/daemons/postgres-image/bundle): the
// daemon copies a pinned bundle image's files into the database's own volume,
// <mount>/extensions/<id>/<version>-pg<major>-<debian>-<arch>/files, so they
// count against the database's storage, removes the image, and has the
// image's opfield-extensions script link them into the container (at every
// start through the entrypoint, and right away after a live install).

const (
	pgExtensionsDirName       = "extensions"
	pgExtensionsContainerDir  = pgContainerDataDir + "/" + pgExtensionsDirName
	pgBundleStampName         = ".opfield-installed"
	pgBundleManifestName      = "opfield-bundle.json"
	pgBundleWireCommand       = "/usr/local/bin/opfield-extensions"
	pgBundleSpaceReserveBytes = 16 << 20
	pgBundleMaxManifestBytes  = 32 << 20
	pgBundleMaxFiles          = 100000
)

// pgBundleArch is the architecture bundles are installed for (tests set it).
var pgBundleArch = runtime.GOARCH

// pgBundleStamp marks a verified bundle directory.
type pgBundleStamp struct {
	Reference string `json:"reference"`
	Version   string `json:"version"`
	Arch      string `json:"arch"`
}

// postgresBundleClosure resolves the bundles a command asks for against the
// image it names.
func postgresBundleClosure(input managedDatabaseCommand) ([]pgext.Bundle, error) {
	ids := managedPostgresExtensionBundleIDs(input)
	if len(ids) == 0 {
		return nil, nil
	}
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return nil, err
	}
	image := catalog.Image(input.Image)
	return catalog.BundleClosure(ids, image.Version.Major, image.Version.Debian)
}

func pgBundleDir(record managedDatabaseRecord, bundle pgext.Bundle, arch string) string {
	return filepath.Join(record.MountPath, pgExtensionsDirName, bundle.ID, bundle.Dir(arch))
}

// ensurePostgresExtensionBundles installs the bundles a command asks for that
// the volume does not hold yet, refusing up front when the volume lacks the
// space, and records the set. Only PostgreSQL commands with bundles do work.
func (m *managedDatabaseManager) ensurePostgresExtensionBundles(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	_, err := m.installPostgresExtensionBundles(ctx, record, input)
	return err
}

// installPostgresExtensionBundles is ensurePostgresExtensionBundles reporting
// whether it installed one.
func (m *managedDatabaseManager) installPostgresExtensionBundles(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) (bool, error) {
	if input.Type != "postgres" {
		return false, nil
	}
	closure, err := postgresBundleClosure(input)
	if err != nil {
		return false, err
	}
	if len(closure) == 0 {
		record.PostgresExtensionBundles = nil
		return false, nil
	}
	arch := pgBundleArch
	var missing []pgext.Bundle
	need := int64(0)
	for _, bundle := range closure {
		if pgBundleInstalled(pgBundleDir(*record, bundle, arch), bundle, arch) {
			continue
		}
		missing = append(missing, bundle)
		need += bundle.SizeBytes[arch]
	}
	if len(missing) > 0 {
		if used, total, ok := managedDatabaseDiskUsage(record.MountPath); ok && total-used < need+pgBundleSpaceReserveBytes {
			return false, extensionError(extensionNeedsStorageCode, "needs %d MB, %d MB free — grow the storage",
				(need+pgBundleSpaceReserveBytes+(1<<20)-1)>>20, max(total-used, 0)>>20)
		}
	}
	for _, bundle := range missing {
		if err := m.installPostgresBundle(ctx, *record, bundle, arch); err != nil {
			return false, err
		}
	}
	record.PostgresExtensionBundles = make([]string, 0, len(closure))
	for _, bundle := range closure {
		record.PostgresExtensionBundles = append(record.PostgresExtensionBundles, bundle.ID)
	}
	return len(missing) > 0, nil
}

func pgBundleInstalled(dir string, bundle pgext.Bundle, arch string) bool {
	data, err := os.ReadFile(filepath.Join(dir, pgBundleStampName))
	if err != nil {
		return false
	}
	var stamp pgBundleStamp
	return json.Unmarshal(data, &stamp) == nil && stamp.Reference == bundle.Reference && stamp.Arch == arch
}

// pgExtensionsRoot creates the volume's extensions directory, refusing one the
// daemon did not create (a link, or a directory of the postgres user).
func pgExtensionsRoot(record managedDatabaseRecord) (string, error) {
	root := filepath.Join(record.MountPath, pgExtensionsDirName)
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(root, 0o755); err != nil {
			return "", fmt.Errorf("create the extensions directory: %w", err)
		}
		return root, os.Chmod(root, 0o755)
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || pgOwnedByPostgres(info) {
		return "", extensionError(extensionBundleInvalidCode, "the volume's extensions directory was not created by Opfield")
	}
	return root, nil
}

func pgOwnedByPostgres(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == pgPostgresUID
}

// installPostgresBundle pulls a pinned bundle, copies its verified files into
// the volume and removes the image and the helper container again.
func (m *managedDatabaseManager) installPostgresBundle(ctx context.Context, record managedDatabaseRecord, bundle pgext.Bundle, arch string) error {
	root, err := pgExtensionsRoot(record)
	if err != nil {
		return err
	}
	reference, err := m.client.EnsureThirdPartyImage(ctx, bundle.Reference)
	if err != nil {
		return extensionError(extensionBundleInvalidCode, "the %s bundle could not be downloaded: %v", bundle.ID, err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		if err := m.client.RemoveImage(cleanup, reference, true); err != nil {
			m.logger.Warn("remove a downloaded extension bundle image", "bundle", bundle.ID, "error", err)
		}
	}()
	created, err := m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     &container.Config{Image: reference, Cmd: []string{"/opfield-bundle"}, NetworkDisabled: true},
		HostConfig: &container.HostConfig{NetworkMode: "none"},
	})
	if err != nil {
		return fmt.Errorf("open the %s bundle: %w", bundle.ID, err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		_, _ = m.client.cli.ContainerRemove(cleanup, created.ID, mobyclient.ContainerRemoveOptions{Force: true})
	}()
	manifest, err := m.readPostgresBundleManifest(ctx, created.ID)
	if err != nil {
		return extensionError(extensionBundleInvalidCode, "the %s bundle has no readable manifest: %v", bundle.ID, err)
	}
	if err := checkPostgresBundleManifest(manifest, bundle, arch); err != nil {
		return extensionError(extensionBundleInvalidCode, "%v", err)
	}
	staging, err := os.MkdirTemp(root, ".staging-"+bundle.ID+"-")
	if err != nil {
		return fmt.Errorf("stage the %s bundle: %w", bundle.ID, err)
	}
	defer os.RemoveAll(staging)
	if err := os.Chmod(staging, 0o755); err != nil {
		return err
	}
	files, err := m.client.cli.CopyFromContainer(ctx, created.ID, mobyclient.CopyFromContainerOptions{SourcePath: "/files"})
	if err != nil {
		return fmt.Errorf("read the %s bundle: %w", bundle.ID, err)
	}
	extractErr := extractPostgresBundleFiles(files.Content, filepath.Join(staging, "files"), manifest)
	files.Content.Close()
	if extractErr != nil {
		return extensionError(extensionBundleInvalidCode, "the %s bundle failed verification: %v", bundle.ID, extractErr)
	}
	stamp, _ := json.Marshal(pgBundleStamp{Reference: bundle.Reference, Version: bundle.Version, Arch: arch})
	if err := os.WriteFile(filepath.Join(staging, pgBundleStampName), stamp, 0o644); err != nil {
		return err
	}
	parent := filepath.Join(root, bundle.ID)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	final := filepath.Join(parent, bundle.Dir(arch))
	if err := os.RemoveAll(final); err != nil {
		return err
	}
	if err := os.Rename(staging, final); err != nil {
		return fmt.Errorf("install the %s bundle: %w", bundle.ID, err)
	}
	m.logger.Info("installed a PostgreSQL extension bundle", "id", record.ID, "bundle", bundle.ID, "version", bundle.Version, "bytes", manifest.SizeBytes)
	return nil
}
