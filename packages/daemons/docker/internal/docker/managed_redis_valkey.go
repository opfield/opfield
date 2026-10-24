package docker

import (
	"context"
	"path/filepath"
	"strings"

	mobyclient "github.com/moby/moby/client"
)

// A managed key-value store (engine type "redis") runs Valkey from the
// valkey-bundle image, or Redis when it was created before Opfield 2.12 and
// has not been moved to Valkey yet (managed_redis_move.go). Both speak the
// Redis protocol and use the same data layout under /data, the same uid 999
// and the redis-cli name (a symlink to valkey-cli in the bundle), so only the
// server command and the modules differ.

// managedCapabilityValkey: the node runs Valkey key-value stores and moves a
// Redis store to Valkey when an update brings a Valkey image.
const managedCapabilityValkey = "managed_redis_valkey_v1"

// managedValkeyImages are the curated valkey-bundle images (upstream
// references; the GHCR mirror of one maps back to it).
var managedValkeyImages = map[string]struct{}{
	"docker.io/valkey/valkey-bundle@sha256:dd30c59c2b2a598e83308095220a31d6d93d64c40a839c702cb1e98c8e220660": {},
}

// managedRedisRunsValkey reports whether a key-value store image is Valkey.
func managedRedisRunsValkey(image string) bool {
	if upstream, ok := thirdPartyUpstreamReference(image); ok {
		image = upstream
	}
	_, ok := managedValkeyImages[image]
	return ok
}

// managedValkeyModules are the bundle's modules a store loads, in load order
// (Search can index JSON documents, so JSON loads first). The bundle's
// entrypoint adds a --loadmodule for every module of /usr/lib/valkey the
// config file does not name; a module left out is named in a comment so that
// it is not loaded. The LDAP authentication module is always left out: stores
// authenticate with their ACL file.
var managedValkeyModules = []string{
	"/usr/lib/valkey/libjson.so",
	managedValkeySearchModule,
	"/usr/lib/valkey/libvalkey_bloom.so",
}

// managedValkeySearchModule needs AVX2 (x86-64-v3): on an older CPU it dies
// with SIGILL at load, so a store there runs without Search (cpu_level.go).
const managedValkeySearchModule = "/usr/lib/valkey/libsearch.so"

const managedValkeyUnloadedModules = "# Not loaded: loadmodule /usr/lib/valkey/libvalkey_ldap.so\n"

// managedValkeyNodeModules are the modules a store loads on this node.
func managedValkeyNodeModules() []string {
	modules := make([]string, 0, len(managedValkeyModules))
	for _, module := range managedValkeyModules {
		if module == managedValkeySearchModule && !valkeySearchRuns() {
			continue
		}
		modules = append(modules, module)
	}
	return modules
}

func managedValkeyModuleConfig() string {
	var config strings.Builder
	for _, module := range managedValkeyNodeModules() {
		config.WriteString("loadmodule " + module + "\n")
	}
	if !valkeySearchRuns() {
		config.WriteString("# Not loaded (this CPU has no AVX2, x86-64-v3): loadmodule " + managedValkeySearchModule + "\n")
	}
	config.WriteString(managedValkeyUnloadedModules)
	return config.String()
}

// managedRedisServerCommand is the server binary of a key-value store
// container. The valkey-bundle entrypoint drops root and adds its modules only
// for valkey-server; the Redis image does both for redis-server.
func managedRedisServerCommand(image string) string {
	if managedRedisRunsValkey(image) {
		return "valkey-server"
	}
	return "redis-server"
}

// managedRedisDataPath is the data directory of a key-value store, mounted as
// /data: redis-data for Redis, valkey-data for Valkey.
func managedRedisDataPath(record managedDatabaseRecord, image string) string {
	if managedRedisRunsValkey(image) {
		return filepath.Join(record.MountPath, "valkey-data")
	}
	return filepath.Join(record.MountPath, "redis-data")
}

// managedRedisContainerRunsValkey reports whether the container of a key-value
// store was created from a Valkey image, and whether it exists.
func (m *managedDatabaseManager) managedRedisContainerRunsValkey(ctx context.Context, containerID string) (valkey bool, exists bool, err error) {
	if containerID == "" {
		return false, false, nil
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return false, false, nil
		}
		return false, false, err
	}
	if inspect.Container.Config == nil {
		return false, true, nil
	}
	return managedRedisRunsValkey(inspect.Container.Config.Image), true, nil
}
