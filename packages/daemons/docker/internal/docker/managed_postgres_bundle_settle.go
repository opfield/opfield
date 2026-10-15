package docker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	mobyclient "github.com/moby/moby/client"
)

// Keeping a running database's extension bundles in step with its settings:
// install, link into the running server, and remove what it no longer uses.

// settlePostgresExtensionBundles brings a running database's volume to the
// bundles of the command: installs the missing ones, removes the ones it no
// longer asks for (kept while an extension they provide is still created in
// the database) and links the change into the running container.
func (m *managedDatabaseManager) settlePostgresExtensionBundles(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	if record.Type != "postgres" {
		return nil
	}
	installed, err := m.installPostgresExtensionBundles(ctx, record, input)
	if err != nil {
		return err
	}
	pruned := m.prunePostgresExtensionBundles(ctx, *record, input)
	if !installed && !pruned {
		return nil
	}
	if err := m.wirePostgresExtensionBundles(ctx, record.ContainerID); err != nil {
		if installed {
			return err
		}
		m.logger.Warn("unlink removed PostgreSQL extension bundles", "id", record.ID, "error", err)
	}
	return nil
}

// wirePostgresExtensionBundles runs the image's opfield-extensions in the
// running container; a stopped container wires at its next start.
func (m *managedDatabaseManager) wirePostgresExtensionBundles(ctx context.Context, containerID string) error {
	if containerID == "" {
		return nil
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect the database container: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return nil
	}
	if err := m.runManagedDatabaseExec(ctx, containerID, []string{pgBundleWireCommand, "wire"}, "", nil); err != nil {
		return fmt.Errorf("link the extension bundles into the running server: %w", err)
	}
	return nil
}

// prunePostgresExtensionBundles removes bundle directories the command no
// longer asks for and other builds of the ones it does; it reports whether it
// removed one. A bundle an extension created in the database still uses is
// kept (also when that cannot be checked): removing it would break the
// database at its next start.
func (m *managedDatabaseManager) prunePostgresExtensionBundles(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand) bool {
	root := filepath.Join(record.MountPath, pgExtensionsDirName)
	entries, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	closure, err := postgresBundleClosure(input)
	if err != nil {
		return false
	}
	current := map[string]string{}
	for _, bundle := range closure {
		current[bundle.ID] = bundle.Dir(pgBundleArch)
	}
	removed := false
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".staging-") {
			_ = os.RemoveAll(filepath.Join(root, name))
			continue
		}
		if !entry.IsDir() || strings.HasPrefix(name, ".") {
			continue
		}
		if dir, wanted := current[name]; wanted {
			versions, err := os.ReadDir(filepath.Join(root, name))
			if err != nil {
				continue
			}
			for _, version := range versions {
				if version.Name() != dir {
					if err := os.RemoveAll(filepath.Join(root, name, version.Name())); err == nil {
						removed = true
					}
				}
			}
			continue
		}
		if inUse, err := m.postgresBundleInUse(ctx, record, input, name); err != nil || inUse {
			if err != nil {
				m.logger.Warn("keep a PostgreSQL extension bundle whose use could not be checked", "id", record.ID, "bundle", name, "error", err)
			}
			continue
		}
		if err := os.RemoveAll(filepath.Join(root, name)); err != nil {
			m.logger.Warn("remove a PostgreSQL extension bundle", "id", record.ID, "bundle", name, "error", err)
			continue
		}
		removed = true
	}
	return removed
}

// postgresBundleInUse reports whether an extension the bundle serves is
// created in the application database.
func (m *managedDatabaseManager) postgresBundleInUse(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand, bundleID string) (bool, error) {
	catalog, err := postgresExtensionCatalog()
	if err != nil {
		return true, err
	}
	var names []string
	for _, extension := range catalog.Extensions() {
		if extension.BundleID() == bundleID {
			names = append(names, extension.Name)
		}
	}
	if len(names) == 0 {
		return false, nil
	}
	query := "SELECT count(*) FROM pg_extension WHERE extname IN (" + pgSQLLiterals(names) + ")"
	out, err := m.pgExecOutputEnv(ctx, record.ContainerID,
		[]string{"psql", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName, "-c", query},
		"", []string{"PGPASSWORD=" + input.OwnerPassword})
	if err != nil {
		return true, err
	}
	return strings.TrimSpace(out) != "0", nil
}

func pgSQLLiterals(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, pgLiteral(value))
	}
	return strings.Join(quoted, ", ")
}

// installedPostgresBundles are the verified bundle builds in the volume for a
// major, Debian release and architecture.
func installedPostgresBundles(record managedDatabaseRecord, major, debian, arch string) []map[string]string {
	root := filepath.Join(record.MountPath, pgExtensionsDirName)
	entries, err := os.ReadDir(root)
	if err != nil {
		return []map[string]string{}
	}
	suffix := fmt.Sprintf("-pg%s-%s-%s", major, debian, arch)
	out := []map[string]string{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		versions, _ := os.ReadDir(filepath.Join(root, entry.Name()))
		var matching []string
		for _, version := range versions {
			if strings.HasSuffix(version.Name(), suffix) {
				if _, err := os.Stat(filepath.Join(root, entry.Name(), version.Name(), pgBundleStampName)); err == nil {
					matching = append(matching, strings.TrimSuffix(version.Name(), suffix))
				}
			}
		}
		if len(matching) > 0 {
			slices.Sort(matching)
			out = append(out, map[string]string{"id": entry.Name(), "version": matching[len(matching)-1]})
		}
	}
	return out
}
