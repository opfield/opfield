package docker

import (
	"context"
	"strings"
	"sync"
	"time"

	mobyclient "github.com/moby/moby/client"
)

// pg_cron writes a row into cron.job_run_details for every run and never
// deletes one. A database that preloads pg_cron gets a pg_cron job of its own
// that deletes the rows older than 7 days, once per container start: an
// existing job of that name is left as it is (the user may change its
// schedule or retention), a deleted one comes back at the next start.

const (
	pgCronPurgeJobName = "opfield-purge-job-run-details"
	pgCronPurgeSQL     = `DO $opfield$
BEGIN
  IF pg_is_in_recovery() OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = '` + pgCronPurgeJobName + `') THEN
    PERFORM cron.schedule('` + pgCronPurgeJobName + `', '17 3 * * *',
      $job$DELETE FROM cron.job_run_details WHERE coalesce(end_time, start_time) < now() - interval '7 days'$job$);
  END IF;
END
$opfield$;
SELECT CASE WHEN pg_is_in_recovery() THEN 'standby'
  WHEN NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN 'absent'
  ELSE 'scheduled' END;
`
)

// pgCronPurgeChecked maps a container to its start whose purge job is in
// place or could not be made.
var pgCronPurgeChecked sync.Map

// pgCronSettings reads the preload libraries and pg_cron's database from a
// PostgreSQL container's command line.
func pgCronSettings(cmd []string) (preloaded bool, database string) {
	database = "postgres"
	for _, arg := range cmd {
		if value, ok := strings.CutPrefix(arg, "shared_preload_libraries="); ok {
			for _, library := range splitPreloadSetting(value) {
				if library == "pg_cron" {
					preloaded = true
				}
			}
		}
		if value, ok := strings.CutPrefix(arg, "cron.database_name="); ok && value != "" {
			database = value
		}
	}
	return preloaded, database
}

func pgContainerEnv(env []string, key string) string {
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, key+"="); ok {
			return value
		}
	}
	return ""
}

// ensurePGCronPurge schedules the purge job on a running PostgreSQL that
// preloads pg_cron: a set member as the node-local role (only the primary
// writes; the job reaches the copies by replication), a single server as its
// owner.
func (m *managedDatabaseManager) ensurePGCronPurge(ctx context.Context, record managedDatabaseRecord) {
	if record.Type != "postgres" || record.ContainerID == "" || m.client == nil || m.client.cli == nil {
		return
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running || inspect.Container.Config == nil {
		return
	}
	key, started := record.ContainerID, inspect.Container.State.StartedAt
	if checked, ok := pgCronPurgeChecked.Load(key); ok && checked == started {
		return
	}
	preloaded, database := pgCronSettings(inspect.Container.Config.Cmd)
	if !preloaded {
		pgCronPurgeChecked.Store(key, started)
		return
	}
	command := []string{"psql", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-h", "/var/run/postgresql", "-d", database}
	var env []string
	if record.AvailabilitySetID != "" {
		command = append(command, "-U", pgLocalRole)
	} else {
		owner := pgContainerEnv(inspect.Container.Config.Env, "POSTGRES_USER")
		if owner == "" {
			pgCronPurgeChecked.Store(key, started)
			return
		}
		command = append(command, "-U", owner)
		env = []string{"PGPASSWORD=" + pgContainerEnv(inspect.Container.Config.Env, "POSTGRES_PASSWORD")}
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	output, err := m.pgExecOutputEnv(callCtx, record.ContainerID, command, pgCronPurgeSQL, env)
	if err != nil {
		// Tried once per start: an owner whose password changed since the
		// container was made cannot sign in this way.
		pgCronPurgeChecked.Store(key, started)
		m.logger.Debug("could not schedule the pg_cron history purge", "id", record.ID, "error", err)
		return
	}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	switch strings.TrimSpace(lines[len(lines)-1]) {
	case "scheduled":
		pgCronPurgeChecked.Store(key, started)
	default:
		// A copy, or pg_cron not created yet: looked at again later.
	}
}
