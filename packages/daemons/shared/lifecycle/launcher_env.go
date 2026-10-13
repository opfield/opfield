package lifecycle

import "os"

// The launcher and its daemon child talk through environment variables, and the
// two can be different releases: a launcher copy older than the daemon it
// starts, or a launcher rolling back to a daemon older than itself. The
// launcher therefore sets every variable under both names and the daemon reads
// the Opfield name first.
const (
	// legacy-name: GATEWAY_DAEMON_LAUNCHER_* environment of pre-Opfield launchers and daemons — remove once every node reports none
	legacyLauncherManagedEnv  = "GATEWAY_DAEMON_LAUNCHER_MANAGED"
	legacyLauncherReadyFDEnv  = "GATEWAY_DAEMON_LAUNCHER_READY_FD"
	legacyLauncherOwnerFDEnv  = "GATEWAY_DAEMON_LAUNCHER_OWNER_FD"
	legacyLauncherStateDirEnv = "GATEWAY_DAEMON_LAUNCHER_STATE_DIR"
	legacyLauncherResumeFDEnv = "GATEWAY_DAEMON_LAUNCHER_RESUME_FD"
)

// launcherEnv reads a launcher variable under its Opfield name, else its
// pre-Opfield one.
func launcherEnv(name, legacy string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	// legacy-name: GATEWAY_DAEMON_LAUNCHER_* set by a pre-Opfield launcher copy — remove once every node reports none
	return os.Getenv(legacy)
}

func launcherManagedFromEnvironment() string {
	return launcherEnv(LauncherManagedEnv, legacyLauncherManagedEnv)
}

// launcherEnvPairs are the environment entries setting one launcher variable
// under both names.
func launcherEnvPairs(name, legacy, value string) []string {
	// legacy-name: GATEWAY_DAEMON_LAUNCHER_* read by a pre-Opfield daemon the launcher rolls back to — remove once every node reports none
	return []string{name + "=" + value, legacy + "=" + value}
}
