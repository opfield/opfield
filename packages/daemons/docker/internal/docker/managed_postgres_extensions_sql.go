package docker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/moby/moby/api/pkg/stdcopy"
	mobyclient "github.com/moby/moby/client"
)

// The SQL of the extension commands: the server's state of the curated names,
// the DDL with the application role's grants, and psql's errors mapped to the
// refusal codes.

// postgresServerExtensionsSQL reads the server's state of the curated names in
// one JSON line.
func postgresServerExtensionsSQL(names []string) string {
	return `SELECT json_build_object(
  'serverVersionNum', current_setting('server_version_num')::int,
  'preload', current_setting('shared_preload_libraries'),
  'readOnly', pg_is_in_recovery(),
  'available', (SELECT coalesce(json_agg(json_build_object('name', a.name, 'default', a.default_version, 'installed', e.extversion)), '[]'::json)
    FROM pg_available_extensions a LEFT JOIN pg_extension e ON e.extname = a.name
    WHERE a.name IN (` + pgSQLLiterals(names) + `)))`
}

func splitPreloadSetting(value string) []string {
	out := []string{}
	for _, part := range strings.Split(value, ",") {
		part = strings.Trim(strings.TrimSpace(part), `"`)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// postgresExtensionPSQL is the psql invocation of the extension commands:
// the control superuser on the local socket, errors with their SQLSTATE.
func postgresExtensionPSQL(owner, database string) []string {
	return []string{"psql", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", owner, "-d", database}
}

// runPostgresExtensionSQL runs a script and returns its output and, when it
// failed, PostgreSQL's error output.
func (m *managedDatabaseManager) runPostgresExtensionSQL(ctx context.Context, containerID, owner, password, database, script string) (string, string, error) {
	created, err := m.client.cli.ExecCreate(ctx, containerID, mobyclient.ExecCreateOptions{
		Cmd: postgresExtensionPSQL(owner, database), Env: []string{"PGPASSWORD=" + password},
		AttachStdin: true, AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return "", "", errors.New("managed database engine command could not start")
	}
	attached, err := m.client.cli.ExecAttach(ctx, created.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return "", "", errors.New("managed database engine command could not attach")
	}
	defer attached.Close()
	if _, err := attached.Conn.Write([]byte(script)); err != nil {
		return "", "", errors.New("managed database engine command could not receive input")
	}
	if err := attached.CloseWrite(); err != nil {
		return "", "", errors.New("managed database engine command could not close input")
	}
	var stdout, stderr bytes.Buffer
	_, _ = stdcopy.StdCopy(&pgTruncatingBuffer{buf: &stdout, max: maxPGExecOutput}, &pgTruncatingBuffer{buf: &stderr, max: 64 << 10}, attached.Reader)
	inspect, err := m.client.cli.ExecInspect(ctx, created.ID, mobyclient.ExecInspectOptions{})
	if err != nil {
		return "", "", fmt.Errorf("managed database engine command state unknown: %w", err)
	}
	if inspect.ExitCode != 0 {
		return stdout.String(), stderr.String(), errPostgresExtensionSQL
	}
	return stdout.String(), stderr.String(), nil
}

var errPostgresExtensionSQL = errors.New("the SQL failed")

var postgresErrorLine = regexp.MustCompile(`(?m)^(?:psql:[^\n]*?)?ERROR:\s+([0-9A-Z]{5}):\s*(.*)$`)
var postgresDetailLine = regexp.MustCompile(`(?m)^DETAIL:\s+(.*)$`)

// postgresExtensionSQLError maps psql's verbose error output to a coded error.
func postgresExtensionSQLError(stderr string) error {
	match := postgresErrorLine.FindStringSubmatch(stderr)
	if match == nil {
		message := strings.TrimSpace(pgFirstLine(stderr))
		if message == "" {
			message = "PostgreSQL refused the change"
		}
		return extensionError(extensionFailedCode, "%s", message)
	}
	state, message := match[1], strings.TrimSpace(match[2])
	var details []string
	for _, detail := range postgresDetailLine.FindAllStringSubmatch(stderr, -1) {
		details = append(details, strings.TrimSpace(detail[1]))
	}
	if len(details) > 0 {
		message += " (" + strings.Join(details, "; ") + ")"
	}
	switch {
	case state == "2BP01":
		return extensionError(extensionHasDependentsCode, "%s", message)
	case state == "25006":
		return extensionError(extensionNotPrimaryCode, "%s", message)
	case strings.Contains(message, "shared_preload_libraries"):
		return extensionError(extensionNeedsPreloadCode, "%s", message)
	case state == "58P01":
		return extensionError(extensionNotAvailableCode, "%s", message)
	default:
		return extensionError(extensionFailedCode, "%s", message)
	}
}

// postgresExtensionDDL is the change script: the DDL, then the grants that let
// the application role use what the curated extensions created.
func postgresExtensionDDL(input postgresExtensionApplyCommand, curated []string) string {
	name := pgIdentifier(input.Name)
	var ddl string
	switch input.Action {
	case "enable":
		ddl = "CREATE EXTENSION IF NOT EXISTS " + name + " CASCADE;"
	case "disable":
		ddl = "DROP EXTENSION IF EXISTS " + name + " RESTRICT;"
	default:
		ddl = "ALTER EXTENSION " + name + " UPDATE;"
	}
	script := "RESET ROLE;\nSET lock_timeout = '30s';\n" + ddl + "\n"
	if input.Action != "disable" && input.ApplicationPrincipalName != "" {
		script += postgresExtensionGrantsSQL(input.ApplicationPrincipalName, curated)
	}
	return script
}

// postgresExtensionGrantsSQL grants the application role the schemas the
// curated extensions created (pg_cron's cron, PostGIS topology, …) with their tables, sequences and routines; objects in other
// schemas follow their PUBLIC grants. The query writer reaches them through
// the application role.
func postgresExtensionGrantsSQL(application string, curated []string) string {
	body := fmt.Sprintf(`
DECLARE
  application_role text := %s;
  schema_name name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RETURN;
  END IF;
  FOR schema_name IN
    SELECT DISTINCT n.nspname
    FROM pg_extension e
    JOIN pg_depend d ON d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid
      AND d.classid = 'pg_namespace'::regclass AND d.deptype = 'e'
    JOIN pg_namespace n ON n.oid = d.objid
    WHERE e.extname IN (%s)
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %%I TO %%I', schema_name, application_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %%I TO %%I', schema_name, application_role);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %%I TO %%I', schema_name, application_role);
    EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %%I TO %%I', schema_name, application_role);
  END LOOP;
END
`, pgLiteral(application), pgSQLLiterals(curated))
	return "DO $opfield$" + body + "$opfield$;\n"
}
