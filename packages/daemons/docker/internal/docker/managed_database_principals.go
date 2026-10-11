package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	mobyclient "github.com/moby/moby/client"
)

func validateManagedDatabaseBindingInput(input managedDatabaseBindingCommand) error {
	if !managedDatabaseIDPattern.MatchString(input.BindingID) {
		return errors.New("invalid database binding identifier")
	}
	if !managedDatabaseName.MatchString(input.Username) || !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("database binding names must be safe SQL identifiers")
	}
	if len(input.Password) < 16 || len(input.Password) > 512 || len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("database binding passwords must be between 16 and 512 characters")
	}
	return nil
}

func validateManagedDatabasePrincipalV2Input(input managedDatabasePrincipalV2Command) error {
	if !managedDatabaseIDPattern.MatchString(input.OperationID) {
		return errors.New("invalid managed database principal operation identifier")
	}
	if !managedDatabaseName.MatchString(input.PrincipalName) ||
		!managedDatabaseName.MatchString(input.ApplicationPrincipalName) ||
		!managedDatabaseName.MatchString(input.OwnerUsername) ||
		!managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("managed database principal names must be safe identifiers")
	}
	if len(input.Password) < 16 || len(input.Password) > 512 || len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("managed database principal passwords must be between 16 and 512 characters")
	}
	return nil
}

func validateManagedDatabaseOwnerSeparationInput(input managedDatabaseOwnerSeparationCommand) error {
	if !managedDatabaseIDPattern.MatchString(input.OperationID) {
		return errors.New("invalid managed database owner separation operation identifier")
	}
	if !managedDatabaseName.MatchString(input.DatabaseName) ||
		!managedDatabaseName.MatchString(input.ApplicationPrincipalName) ||
		!managedDatabaseName.MatchString(input.CurrentOwnerUsername) ||
		!managedDatabaseName.MatchString(input.PendingOwnerUsername) {
		return errors.New("managed database owner separation names must be safe identifiers")
	}
	if len(input.CurrentOwnerPassword) < 16 || len(input.CurrentOwnerPassword) > 512 ||
		len(input.PendingOwnerPassword) < 16 || len(input.PendingOwnerPassword) > 512 {
		return errors.New("managed database owner separation passwords must be between 16 and 512 characters")
	}
	return nil
}

func validateClickHousePrincipalInput(input clickHousePrincipalCommand) error {
	if input.PrincipalType != "reader" && input.PrincipalType != "writer" && input.PrincipalType != "binding" {
		return errors.New("unsupported ClickHouse principal type")
	}
	if !managedDatabaseName.MatchString(input.Username) || !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("ClickHouse principal names must be safe SQL identifiers")
	}
	if len(input.Password) < 16 || len(input.Password) > 512 || len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("ClickHouse principal passwords must be between 16 and 512 characters")
	}
	return nil
}

// postgresQueryPrincipalCommand provisions the non-superuser, read-only role
// the control plane runs read-scoped interactive queries as.
type postgresQueryPrincipalCommand struct {
	Username      string `json:"username"`
	Password      string `json:"password"`
	DatabaseName  string `json:"databaseName"`
	OwnerUsername string `json:"ownerUsername"`
	OwnerPassword string `json:"ownerPassword"`
}

func validatePostgresQueryPrincipalInput(input postgresQueryPrincipalCommand) error {
	if !managedDatabaseName.MatchString(input.Username) || !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("PostgreSQL query principal names must be safe SQL identifiers")
	}
	// Applying the reader attributes to the owner would demote it, and pg_
	// names are reserved for PostgreSQL's predefined roles.
	if input.Username == input.OwnerUsername || strings.HasPrefix(strings.ToLower(input.Username), "pg_") {
		return errors.New("PostgreSQL query principal must be a dedicated role")
	}
	if len(input.Password) < 16 || len(input.Password) > 512 || len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("PostgreSQL query principal passwords must be between 16 and 512 characters")
	}
	return nil
}

// applyPostgresQueryPrincipal converges the reader as the owner, then proves
// it can log in and holds no write or administrative attribute. Passwords
// travel only through stdin and the exec environment, never process args.
func (m *managedDatabaseManager) applyPostgresQueryPrincipal(ctx context.Context, record managedDatabaseRecord, input postgresQueryPrincipalCommand) error {
	if record.Type != "postgres" {
		return errors.New("query principals are supported only for PostgreSQL")
	}
	if err := m.runManagedDatabaseExec(
		ctx,
		record.ContainerID,
		postgresQueryPrincipalApplyCommand(input),
		postgresQueryPrincipalApplySQL(input),
		[]string{"PGPASSWORD=" + input.OwnerPassword},
	); err != nil {
		return err
	}
	return m.runManagedDatabaseExec(
		ctx,
		record.ContainerID,
		postgresQueryPrincipalProbeCommand(input),
		"",
		[]string{"PGPASSWORD=" + input.Password},
	)
}

func postgresQueryPrincipalApplyCommand(input postgresQueryPrincipalCommand) []string {
	return []string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName}
}

// postgresQueryPrincipalProbeSQL fails with a division by zero when the
// session is not read-only by default or the role can write or administer.
// The divisor depends on row data, so PostgreSQL cannot fold it at plan time.
const postgresQueryPrincipalProbeSQL = `SELECT 1 / (CASE WHEN r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR current_setting('transaction_read_only') <> 'on' THEN 0 ELSE 1 END) FROM pg_roles r WHERE r.rolname = current_user`

func postgresQueryPrincipalProbeCommand(input postgresQueryPrincipalCommand) []string {
	return []string{"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", input.Username, "-d", input.DatabaseName, "-tAc", postgresQueryPrincipalProbeSQL}
}

// postgresQueryPrincipalApplySQL creates or updates the reader. BYPASSRLS
// keeps its reads equal to the superuser path it replaces and grants no write
// privilege. PostgreSQL 14+ grants pg_read_all_data; older servers get
// SELECT on the tables and sequences that exist now, so re-apply after
// schema changes there.
func postgresQueryPrincipalApplySQL(input postgresQueryPrincipalCommand) string {
	body := fmt.Sprintf(`
DECLARE
  reader text := %s;
  reader_password text := %s;
  database_name text := %s;
  schema_name name;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = reader AND rolsuper) THEN
    RAISE EXCEPTION 'query principal %% is an existing superuser', reader;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = reader) THEN
    EXECUTE format('CREATE ROLE %%I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %%L', reader, reader_password);
  ELSE
    EXECUTE format('ALTER ROLE %%I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %%L', reader, reader_password);
  END IF;
  EXECUTE format('ALTER ROLE %%I SET default_transaction_read_only = on', reader);
  EXECUTE format('GRANT CONNECT ON DATABASE %%I TO %%I', database_name, reader);
  IF current_setting('server_version_num')::int >= 140000 THEN
    EXECUTE format('GRANT pg_read_all_data TO %%I', reader);
  ELSE
    FOR schema_name IN
      SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
    LOOP
      EXECUTE format('GRANT USAGE ON SCHEMA %%I TO %%I', schema_name, reader);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %%I TO %%I', schema_name, reader);
      EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %%I TO %%I', schema_name, reader);
    END LOOP;
  END IF;
END
`,
		quoteSQLLiteral(input.Username),
		quoteSQLLiteral(input.Password),
		quoteSQLLiteral(input.DatabaseName),
	)
	return postgresDollarQuotedDO(body)
}

// postgresDollarQuotedDO wraps a PL/pgSQL body. Passwords are the only
// free-form values in these bodies, so pick a dollar-quote tag the body cannot
// contain; a password can then never close the block early.
func postgresDollarQuotedDO(body string) string {
	tag := "$gateway$"
	for suffix := 0; strings.Contains(body, tag); suffix++ {
		tag = fmt.Sprintf("$gateway%d$", suffix)
	}
	return "RESET ROLE;\nDO " + tag + body + tag + ";\n"
}

// postgresQueryWriterCommand provisions the non-superuser role the control
// plane runs write-scoped interactive queries as. It reaches the application's
// tables and sequences only through membership in the application role.
type postgresQueryWriterCommand struct {
	Username                 string `json:"username"`
	Password                 string `json:"password"`
	DatabaseName             string `json:"databaseName"`
	ApplicationPrincipalName string `json:"applicationPrincipalName"`
	OwnerUsername            string `json:"ownerUsername"`
	OwnerPassword            string `json:"ownerPassword"`
}

func validatePostgresQueryWriterInput(input postgresQueryWriterCommand) error {
	if !managedDatabaseName.MatchString(input.Username) ||
		!managedDatabaseName.MatchString(input.ApplicationPrincipalName) ||
		!managedDatabaseName.MatchString(input.OwnerUsername) ||
		!managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("PostgreSQL query writer names must be safe SQL identifiers")
	}
	// The writer must be its own role, and it must never join the control
	// owner (a superuser) or a predefined pg_ role.
	if input.Username == input.OwnerUsername || input.Username == input.ApplicationPrincipalName ||
		input.ApplicationPrincipalName == input.OwnerUsername ||
		strings.HasPrefix(strings.ToLower(input.Username), "pg_") ||
		strings.HasPrefix(strings.ToLower(input.ApplicationPrincipalName), "pg_") {
		return errors.New("PostgreSQL query writer must be a dedicated role joined only to the application role")
	}
	if len(input.Password) < 16 || len(input.Password) > 512 || len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("PostgreSQL query writer passwords must be between 16 and 512 characters")
	}
	return nil
}

// applyPostgresQueryWriter converges the writer as the owner, then proves it
// can log in, holds the application role's privileges and can reach no
// administrative attribute. Passwords travel only through stdin and the exec
// environment, never process args.
func (m *managedDatabaseManager) applyPostgresQueryWriter(ctx context.Context, record managedDatabaseRecord, input postgresQueryWriterCommand) error {
	if record.Type != "postgres" {
		return errors.New("query principals are supported only for PostgreSQL")
	}
	if err := m.runManagedDatabaseExec(
		ctx,
		record.ContainerID,
		postgresQueryWriterApplyCommand(input),
		postgresQueryWriterApplySQL(input),
		[]string{"PGPASSWORD=" + input.OwnerPassword},
	); err != nil {
		return err
	}
	return m.runManagedDatabaseExec(
		ctx,
		record.ContainerID,
		postgresQueryWriterProbeCommand(input),
		"",
		[]string{"PGPASSWORD=" + input.Password},
	)
}

func postgresQueryWriterApplyCommand(input postgresQueryWriterCommand) []string {
	return []string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName}
}

// postgresAdministrativeRoleSQL matches a role that is itself administrative
// or is a predefined role that reads or writes server files or runs programs.
const postgresAdministrativeRoleSQL = `(s.rolsuper OR s.rolcreaterole OR s.rolcreatedb OR s.rolreplication OR s.rolbypassrls OR s.rolname IN ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))`

// postgresQueryWriterProbeSQL fails with a division by zero when the session
// role, or any role it can reach through membership (SET ROLE included), is
// administrative, or when the application role's privileges are not in
// effect. The divisor depends on row data, so it cannot be folded at plan time.
func postgresQueryWriterProbeSQL(applicationPrincipalName string) string {
	return `SELECT 1 / (CASE WHEN NOT pg_has_role(r.oid, ` + quoteSQLLiteral(applicationPrincipalName) + `::name, 'USAGE') OR EXISTS (SELECT 1 FROM pg_roles s WHERE ` + postgresAdministrativeRoleSQL + ` AND pg_has_role(r.oid, s.oid, 'MEMBER')) THEN 0 ELSE 1 END) FROM pg_roles r WHERE r.rolname = session_user`
}

func postgresQueryWriterProbeCommand(input postgresQueryWriterCommand) []string {
	return []string{"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", input.Username, "-d", input.DatabaseName, "-tAc", postgresQueryWriterProbeSQL(input.ApplicationPrincipalName)}
}

// postgresQueryWriterApplySQL creates or updates the writer and grants it the
// application role with INHERIT, so it reads and writes the application's
// objects exactly as the application does while running under its own session
// user (which keeps pg_cancel_backend working for its own queries). The
// application role is refused when membership would hand over superuser,
// role, database or replication administration, BYPASSRLS, or server file and
// program access.
func postgresQueryWriterApplySQL(input postgresQueryWriterCommand) string {
	body := fmt.Sprintf(`
DECLARE
  writer text := %s;
  writer_password text := %s;
  application_owner text := %s;
  database_name text := %s;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_owner) THEN
    RAISE EXCEPTION 'application role %% does not exist', application_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles s WHERE %s AND pg_has_role(application_owner::name, s.oid, 'MEMBER')) THEN
    RAISE EXCEPTION 'application role %% can reach administrative privileges', application_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer AND rolsuper) THEN
    RAISE EXCEPTION 'query writer %% is an existing superuser', writer;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer) THEN
    EXECUTE format('CREATE ROLE %%I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %%L', writer, writer_password);
  ELSE
    EXECUTE format('ALTER ROLE %%I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %%L', writer, writer_password);
  END IF;
  EXECUTE format('GRANT %%I TO %%I', application_owner, writer);
  EXECUTE format('GRANT CONNECT ON DATABASE %%I TO %%I', database_name, writer);
END
`,
		quoteSQLLiteral(input.Username),
		quoteSQLLiteral(input.Password),
		quoteSQLLiteral(input.ApplicationPrincipalName),
		quoteSQLLiteral(input.DatabaseName),
		postgresAdministrativeRoleSQL,
	)
	return postgresDollarQuotedDO(body)
}

func (m *managedDatabaseManager) createBindingPrincipal(ctx context.Context, record managedDatabaseRecord, input managedDatabaseBindingCommand) error {
	var command []string
	var stdin string
	var env []string
	switch record.Type {
	case "postgres":
		stdin = postgresBindingCreateSQL(input)
		command = []string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName}
	case "redis":
		// Redis accepts the ACL password only as a command argument; the script
		// feeds it to redis-cli through stdin, and the owner password stays in
		// the exec environment, so neither is a process argument. Binding users
		// may use normal data commands, but must never administer the server or
		// mutate ACLs (which would let one binding take over another).
		command = []string{"sh", "-ec", redisBindingACLCommand()}
		env = []string{
			"REDISCLI_AUTH=" + input.OwnerPassword,
			"GATEWAY_DB_BINDING_USER=" + input.Username,
			"GATEWAY_DB_BINDING_PASSWORD=" + input.Password,
		}
	case "clickhouse":
		stdin = clickHouseBindingCreateSQL(input)
		command = []string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"}
		env = []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}
	default:
		return errors.New("unsupported managed database engine")
	}
	return m.runManagedDatabaseExec(ctx, record.ContainerID, command, stdin, env)
}

func (m *managedDatabaseManager) applyClickHousePrincipal(ctx context.Context, record managedDatabaseRecord, input clickHousePrincipalCommand) error {
	if record.Type != "clickhouse" {
		return errors.New("ClickHouse principals are unsupported for this database engine")
	}
	return m.runManagedDatabaseExec(
		ctx,
		record.ContainerID,
		[]string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"},
		clickHousePrincipalSQL(input)+"\n",
		[]string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword},
	)
}

func (m *managedDatabaseManager) applyBindingPrincipalV2(ctx context.Context, record managedDatabaseRecord, input managedDatabasePrincipalV2Command) error {
	switch record.Type {
	case "postgres":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName},
			postgresBindingPrincipalV2ApplySQL(input),
			[]string{"PGPASSWORD=" + input.OwnerPassword},
		)
	case "redis":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"sh", "-ec", redisBindingPrincipalV2ApplyCommand()},
			"",
			[]string{
				"REDISCLI_AUTH=" + input.OwnerPassword,
				"GATEWAY_DB_PRINCIPAL=" + input.PrincipalName,
				"GATEWAY_DB_PRINCIPAL_PASSWORD=" + input.Password,
			},
		)
	case "clickhouse":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"},
			clickHouseBindingPrincipalV2ApplySQL(input)+"\n",
			[]string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword},
		)
	default:
		return errors.New("unsupported managed database engine")
	}
}

func (m *managedDatabaseManager) probeBindingPrincipalV2(ctx context.Context, record managedDatabaseRecord, input managedDatabasePrincipalV2Command) error {
	switch record.Type {
	case "postgres":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", input.PrincipalName, "-d", input.DatabaseName, "-tAc", "SELECT current_user = " + quoteSQLLiteral(input.ApplicationPrincipalName)},
			"",
			[]string{"PGPASSWORD=" + input.Password},
		)
	case "redis":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"sh", "-ec", `result="$(redis-cli --no-auth-warning --user "$GATEWAY_DB_PRINCIPAL" PING 2>&1 | tr -d '\r\n')"
[ "$result" = "PONG" ] || { echo "$result" >&2; exit 1; }`},
			"",
			[]string{"REDISCLI_AUTH=" + input.Password, "GATEWAY_DB_PRINCIPAL=" + input.PrincipalName},
		)
	case "clickhouse":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"clickhouse-client", "--user", input.PrincipalName, "--database", input.DatabaseName, "--query", "SELECT 1"},
			"",
			[]string{"CLICKHOUSE_PASSWORD=" + input.Password},
		)
	default:
		return errors.New("unsupported managed database engine")
	}
}

func (m *managedDatabaseManager) dropBindingPrincipalV2(ctx context.Context, record managedDatabaseRecord, input managedDatabasePrincipalV2Command) error {
	switch record.Type {
	case "postgres":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName},
			postgresBindingPrincipalV2DropSQL(input),
			[]string{"PGPASSWORD=" + input.OwnerPassword},
		)
	case "redis":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"sh", "-ec", redisBindingPrincipalV2DropCommand()},
			"",
			[]string{"REDISCLI_AUTH=" + input.OwnerPassword, "GATEWAY_DB_PRINCIPAL=" + input.PrincipalName},
		)
	case "clickhouse":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"},
			"DROP USER IF EXISTS "+quoteSQLIdentifier(input.PrincipalName)+";\n",
			[]string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword},
		)
	default:
		return errors.New("unsupported managed database engine")
	}
}

func (m *managedDatabaseManager) prepareOwnerSeparation(ctx context.Context, record managedDatabaseRecord, input managedDatabaseOwnerSeparationCommand) error {
	if record.Type != "postgres" {
		return errors.New("owner separation preparation is required only for PostgreSQL")
	}
	return m.runManagedDatabaseExec(
		ctx,
		record.ContainerID,
		[]string{"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", input.CurrentOwnerUsername, "-d", input.DatabaseName},
		postgresOwnerSeparationPrepareSQL(input),
		[]string{"PGPASSWORD=" + input.CurrentOwnerPassword},
	)
}

func (m *managedDatabaseManager) finalizeOwnerSeparation(ctx context.Context, record managedDatabaseRecord, input managedDatabaseOwnerSeparationCommand) error {
	switch record.Type {
	case "postgres":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", input.PendingOwnerUsername, "-d", input.DatabaseName},
			"RESET ROLE; ALTER ROLE "+quoteSQLIdentifier(input.CurrentOwnerUsername)+" NOLOGIN PASSWORD NULL;\n",
			[]string{"PGPASSWORD=" + input.PendingOwnerPassword},
		)
	case "redis":
		return m.runManagedDatabaseExec(
			ctx,
			record.ContainerID,
			[]string{"sh", "-ec", redisOwnerRotateCommand()},
			"",
			[]string{
				"GATEWAY_DB_CURRENT_OWNER_PASSWORD=" + input.CurrentOwnerPassword,
				"GATEWAY_DB_PENDING_OWNER_PASSWORD=" + input.PendingOwnerPassword,
			},
		)
	case "clickhouse":
		return m.rotateClickHouseOwner(ctx, record, input)
	default:
		return errors.New("unsupported managed database engine")
	}
}

func (m *managedDatabaseManager) rotateClickHouseOwner(ctx context.Context, record managedDatabaseRecord, input managedDatabaseOwnerSeparationCommand) error {
	if input.CurrentOwnerUsername != input.PendingOwnerUsername {
		return errors.New("ClickHouse owner rotation must preserve the managed owner username")
	}
	overridePath := clickHouseOwnerOverridePath(record)
	pendingConfig := clickHouseOwnerOverrideConfig(input.PendingOwnerUsername, input.PendingOwnerPassword)
	if err := m.probeClickHouseOwner(ctx, record.ContainerID, input.PendingOwnerUsername, input.PendingOwnerPassword, input.DatabaseName); err == nil {
		return writeClickHouseOwnerOverride(overridePath, pendingConfig)
	}

	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return errors.New("managed ClickHouse owner rotation could not inspect the database container")
	}
	bound := false
	if inspect.Container.HostConfig != nil {
		for _, bind := range inspect.Container.HostConfig.Binds {
			if bind == overridePath+":"+clickHouseOwnerOverrideContainerPath+":ro" {
				bound = true
				break
			}
		}
	}
	previousConfig, previousErr := os.ReadFile(overridePath)
	previousExists := previousErr == nil
	if previousErr != nil && !errors.Is(previousErr, os.ErrNotExist) {
		return errors.New("managed ClickHouse owner rotation could not read its persistent credential override")
	}
	if err := writeClickHouseOwnerOverride(overridePath, pendingConfig); err != nil {
		return errors.New("managed ClickHouse owner rotation could not persist its credential override")
	}
	rollback := func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		currentConfig := clickHouseOwnerOverrideConfig(input.CurrentOwnerUsername, input.CurrentOwnerPassword)
		if previousExists {
			_ = writeClickHouseOwnerOverride(overridePath, string(previousConfig))
		} else {
			_ = writeClickHouseOwnerOverride(overridePath, currentConfig)
		}
		if !bound {
			_ = m.copyClickHouseOwnerOverride(rollbackCtx, record.ContainerID, currentConfig)
		}
		_ = m.client.RestartContainer(rollbackCtx, record.ContainerID, 30)
		_ = m.waitForClickHouseOwner(rollbackCtx, record.ContainerID, input.CurrentOwnerUsername, input.CurrentOwnerPassword, input.DatabaseName)
	}
	if !bound {
		if err := m.copyClickHouseOwnerOverride(ctx, record.ContainerID, pendingConfig); err != nil {
			rollback()
			return errors.New("managed ClickHouse owner rotation could not stage its credential override")
		}
	}
	// ClickHouse rereads its users configuration on SYSTEM RELOAD CONFIG, so
	// the running server takes the new password without a restart (one right
	// after a create would stop the engine before the database is handed
	// over). A server that does not take it is restarted as before.
	if err := m.reloadClickHouseOwner(ctx, record.ContainerID, input); err == nil {
		return nil
	}
	if err := m.client.RestartContainer(ctx, record.ContainerID, 30); err != nil {
		rollback()
		return errors.New("managed ClickHouse owner rotation could not restart the database")
	}
	if err := m.waitForClickHouseOwner(ctx, record.ContainerID, input.PendingOwnerUsername, input.PendingOwnerPassword, input.DatabaseName); err != nil {
		rollback()
		return err
	}
	return nil
}

// clickHouseOwnerReloadTimeout bounds the wait for a reloaded owner password
// before the rotation falls back to a restart; the server applies a reload at
// once. Tests shorten it.
var clickHouseOwnerReloadTimeout = 15 * time.Second

// reloadClickHouseOwner asks the running server, as the current owner, to
// reread the staged owner override and waits briefly until the pending owner
// signs in.
func (m *managedDatabaseManager) reloadClickHouseOwner(ctx context.Context, containerID string, input managedDatabaseOwnerSeparationCommand) error {
	if err := m.runManagedDatabaseExec(
		ctx,
		containerID,
		[]string{"clickhouse-client", "--host", "127.0.0.1", "--user", input.CurrentOwnerUsername, "--query", "SYSTEM RELOAD CONFIG"},
		"",
		[]string{"CLICKHOUSE_PASSWORD=" + input.CurrentOwnerPassword},
	); err != nil {
		return err
	}
	reloadCtx, cancel := context.WithTimeout(ctx, clickHouseOwnerReloadTimeout)
	defer cancel()
	return m.waitForClickHouseOwner(reloadCtx, containerID, input.PendingOwnerUsername, input.PendingOwnerPassword, input.DatabaseName)
}

func (m *managedDatabaseManager) copyClickHouseOwnerOverride(ctx context.Context, containerID, config string) error {
	var archive bytes.Buffer
	w := tar.NewWriter(&archive)
	if err := w.WriteHeader(&tar.Header{
		Name: filepath.Base(clickHouseOwnerOverrideContainerPath),
		Mode: 0644,
		Size: int64(len(config)),
	}); err != nil {
		return err
	}
	if _, err := io.WriteString(w, config); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	_, err := m.client.cli.CopyToContainer(ctx, containerID, mobyclient.CopyToContainerOptions{
		DestinationPath: filepath.Dir(clickHouseOwnerOverrideContainerPath),
		Content:         bytes.NewReader(archive.Bytes()),
	})
	return err
}

func (m *managedDatabaseManager) probeClickHouseOwner(ctx context.Context, containerID, username, password, databaseName string) error {
	return m.runManagedDatabaseExec(
		ctx,
		containerID,
		[]string{"clickhouse-client", "--host", "127.0.0.1", "--user", username, "--database", databaseName, "--query", "SELECT 1"},
		"",
		[]string{"CLICKHOUSE_PASSWORD=" + password},
	)
}

func (m *managedDatabaseManager) waitForClickHouseOwner(ctx context.Context, containerID, username, password, databaseName string) error {
	readyCtx, cancel := context.WithTimeout(ctx, managedDatabaseReadinessTimeout)
	defer cancel()
	for {
		if err := m.probeClickHouseOwner(readyCtx, containerID, username, password, databaseName); err == nil {
			return nil
		}
		timer := time.NewTimer(managedDatabaseReadinessInterval)
		select {
		case <-readyCtx.Done():
			timer.Stop()
			return errors.New("managed ClickHouse owner rotation did not become ready before timeout")
		case <-timer.C:
		}
	}
}

func postgresBindingPrincipalV2ApplySQL(input managedDatabasePrincipalV2Command) string {
	principal := quoteSQLIdentifier(input.PrincipalName)
	application := quoteSQLIdentifier(input.ApplicationPrincipalName)
	return fmt.Sprintf(
		"RESET ROLE; DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN EXECUTE 'CREATE ROLE ' || quote_ident(%s) || ' LOGIN NOINHERIT PASSWORD ' || quote_literal(%s); ELSE EXECUTE 'ALTER ROLE ' || quote_ident(%s) || ' LOGIN NOINHERIT PASSWORD ' || quote_literal(%s); END IF; END $$; REASSIGN OWNED BY %s TO %s; DROP OWNED BY %s; GRANT %s TO %s; ALTER ROLE %s IN DATABASE %s SET role TO %s; GRANT CONNECT ON DATABASE %s TO %s;\n",
		quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.Password), quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.Password), principal, application, principal, application, principal, principal, quoteSQLIdentifier(input.DatabaseName), quoteSQLLiteral(input.ApplicationPrincipalName), quoteSQLIdentifier(input.DatabaseName), principal,
	)
}

func postgresBindingPrincipalV2DropSQL(input managedDatabasePrincipalV2Command) string {
	return fmt.Sprintf(
		"RESET ROLE; DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN EXECUTE 'ALTER ROLE ' || quote_ident(%s) || ' NOLOGIN'; PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = %s AND pid <> pg_backend_pid(); EXECUTE 'REASSIGN OWNED BY ' || quote_ident(%s) || ' TO ' || quote_ident(%s); EXECUTE 'DROP OWNED BY ' || quote_ident(%s); EXECUTE 'DROP ROLE ' || quote_ident(%s); END IF; END $$;\n",
		quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.ApplicationPrincipalName), quoteSQLLiteral(input.PrincipalName), quoteSQLLiteral(input.PrincipalName),
	)
}

func postgresOwnerSeparationPrepareSQL(input managedDatabaseOwnerSeparationCommand) string {
	return fmt.Sprintf(
		`RESET ROLE;
DO $gateway$
DECLARE
  legacy_owner text := %s;
  application_owner text := %s;
  control_owner text := %s;
  control_password text := %s;
  database_name text := %s;
  legacy_oid oid;
  obj record;
BEGIN
  SELECT oid INTO legacy_oid FROM pg_roles WHERE rolname = legacy_owner;
  IF legacy_oid IS NULL THEN
    RAISE EXCEPTION 'legacy managed database owner %% does not exist', legacy_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = control_owner) THEN
    EXECUTE format('CREATE ROLE %%I LOGIN SUPERUSER PASSWORD %%L', control_owner, control_password);
  ELSE
    EXECUTE format('ALTER ROLE %%I LOGIN SUPERUSER PASSWORD %%L', control_owner, control_password);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_owner) THEN
    EXECUTE format('CREATE ROLE %%I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', application_owner);
  END IF;

  EXECUTE format('ALTER DATABASE %%I OWNER TO %%I', database_name, application_owner);

  FOR obj IN
    SELECT n.oid, n.nspname
    FROM pg_namespace n
    WHERE n.nspowner = legacy_oid
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER SCHEMA %%I OWNER TO %%I', obj.nspname, application_owner);
  END LOOP;

  FOR obj IN
    SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relowner = legacy_oid
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      CASE obj.relkind
        WHEN 'S' THEN 'ALTER SEQUENCE %%I.%%I OWNER TO %%I'
        WHEN 'v' THEN 'ALTER VIEW %%I.%%I OWNER TO %%I'
        WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %%I.%%I OWNER TO %%I'
        WHEN 'f' THEN 'ALTER FOREIGN TABLE %%I.%%I OWNER TO %%I'
        ELSE 'ALTER TABLE %%I.%%I OWNER TO %%I'
      END,
      obj.nspname,
      obj.relname,
      application_owner
    );
  END LOOP;

  FOR obj IN
    SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proowner = legacy_oid
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER ROUTINE %%I.%%I(%%s) OWNER TO %%I', obj.nspname, obj.proname, obj.args, application_owner);
  END LOOP;

  FOR obj IN
    SELECT t.oid, n.nspname, t.typname, t.typtype
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typowner = legacy_oid
      AND t.typrelid = 0
      AND t.typelem = 0
      AND t.typtype <> 'p'
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      CASE WHEN obj.typtype = 'd' THEN 'ALTER DOMAIN %%I.%%I OWNER TO %%I' ELSE 'ALTER TYPE %%I.%%I OWNER TO %%I' END,
      obj.nspname,
      obj.typname,
      application_owner
    );
  END LOOP;

  FOR obj IN
    SELECT c.oid, n.nspname, c.collname
    FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
    WHERE c.collowner = legacy_oid AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER COLLATION %%I.%%I OWNER TO %%I', obj.nspname, obj.collname, application_owner);
  END LOOP;

  FOR obj IN
    SELECT c.oid, n.nspname, c.conname
    FROM pg_conversion c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conowner = legacy_oid AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER CONVERSION %%I.%%I OWNER TO %%I', obj.nspname, obj.conname, application_owner);
  END LOOP;

  FOR obj IN
    SELECT d.oid, n.nspname, d.dictname
    FROM pg_ts_dict d JOIN pg_namespace n ON n.oid = d.dictnamespace
    WHERE d.dictowner = legacy_oid AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER TEXT SEARCH DICTIONARY %%I.%%I OWNER TO %%I', obj.nspname, obj.dictname, application_owner);
  END LOOP;

  FOR obj IN
    SELECT c.oid, n.nspname, c.cfgname
    FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
    WHERE c.cfgowner = legacy_oid AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER TEXT SEARCH CONFIGURATION %%I.%%I OWNER TO %%I', obj.nspname, obj.cfgname, application_owner);
  END LOOP;

  FOR obj IN SELECT stxname, n.nspname FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace WHERE s.stxowner = legacy_oid
  LOOP
    EXECUTE format('ALTER STATISTICS %%I.%%I OWNER TO %%I', obj.nspname, obj.stxname, application_owner);
  END LOOP;

  FOR obj IN SELECT oid FROM pg_largeobject_metadata WHERE lomowner = legacy_oid
  LOOP
    EXECUTE format('ALTER LARGE OBJECT %%s OWNER TO %%I', obj.oid, application_owner);
  END LOOP;

  FOR obj IN SELECT pubname FROM pg_publication WHERE pubowner = legacy_oid
  LOOP
    EXECUTE format('ALTER PUBLICATION %%I OWNER TO %%I', obj.pubname, application_owner);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE d.defaclrole = legacy_oid AND (n.oid IS NULL OR (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'))
  ) THEN
    RAISE EXCEPTION 'legacy managed database owner has default privileges that require explicit migration';
  END IF;

  EXECUTE format('ALTER ROLE %%I IN DATABASE %%I SET role TO %%L', legacy_owner, database_name, application_owner);
END
$gateway$;
`,
		quoteSQLLiteral(input.CurrentOwnerUsername),
		quoteSQLLiteral(input.ApplicationPrincipalName),
		quoteSQLLiteral(input.PendingOwnerUsername),
		quoteSQLLiteral(input.PendingOwnerPassword),
		quoteSQLLiteral(input.DatabaseName),
	)
}

func clickHouseBindingPrincipalV2ApplySQL(input managedDatabasePrincipalV2Command) string {
	principal := quoteSQLIdentifier(input.PrincipalName)
	application := quoteSQLIdentifier(input.ApplicationPrincipalName)
	database := quoteSQLIdentifier(input.DatabaseName)
	return fmt.Sprintf(
		"CREATE ROLE IF NOT EXISTS %s; GRANT ALL ON %s.* TO %s; GRANT SELECT ON information_schema.* TO %s; GRANT SELECT(name) ON system.databases TO %s; GRANT SELECT(name, engine, total_rows, total_bytes, database, sorting_key, primary_key, partition_key, create_table_query) ON system.tables TO %s; GRANT SELECT(name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key, database, table, position) ON system.columns TO %s; GRANT SELECT ON system.parts TO %s; %s GRANT SELECT ON system.merges TO %s; GRANT SELECT ON system.mutations TO %s; GRANT SELECT ON system.events TO %s; GRANT SELECT ON system.disks TO %s; CREATE USER IF NOT EXISTS %s IDENTIFIED WITH sha256_password BY %s; ALTER USER %s IDENTIFIED WITH sha256_password BY %s; REVOKE ALL ON *.* FROM %s; GRANT %s TO %s; SET DEFAULT ROLE %s TO %s;",
		application, database, application, application, application, application, application, application, clickHouseBindingProcessPrivilegesSQL(input.ApplicationPrincipalName), application, application, application, application, principal, quoteSQLLiteral(input.Password), principal, quoteSQLLiteral(input.Password), principal, application, principal, application, principal,
	)
}

// The Redis ACL scripts pass the ">password" rule as redis-cli's last argument
// through stdin (-x) from the printf shell builtin, so the password never
// appears in a process argument list. ACL rules apply left to right, so
// setting the password last is equivalent. printf adds no newline, which -x
// would otherwise keep as part of the password.

func redisBindingPrincipalV2ApplyCommand() string {
	return fmt.Sprintf(`redis_major="$(redis-cli --no-auth-warning --user default INFO server 2>/dev/null | sed -n 's/^redis_version:\([0-9][0-9]*\)\..*/\1/p')"
set -- redis-cli --no-auth-warning --user default -x ACL SETUSER "$GATEWAY_DB_PRINCIPAL" reset on
for acl_rule in %s; do
  set -- "$@" "$acl_rule"
done
case "$redis_major" in
  [7-9]|[1-9][0-9]*)
    for acl_rule in %s; do
      set -- "$@" "$acl_rule"
    done
    ;;
esac
result="$(printf '%%s' ">$GATEWAY_DB_PRINCIPAL_PASSWORD" | "$@" 2>&1 | tr -d '\r\n')"
[ "$result" = "OK" ] || { echo "$result" >&2; exit 1; }
saved="$(redis-cli --no-auth-warning --user default ACL SAVE 2>&1 | tr -d '\r\n')"
[ "$saved" = "OK" ] || { echo "$saved" >&2; exit 1; }`, redisBindingACLShellWords(redisBindingACLBaseRules()), redisBindingACLShellWords(redisBindingACLModernRules()))
}

func redisBindingPrincipalV2DropCommand() string {
	return `result="$(redis-cli --no-auth-warning --user default ACL DELUSER "$GATEWAY_DB_PRINCIPAL")"
case "$result" in
  0|1) ;;
  *) echo "unexpected ACL DELUSER result: $result" >&2; exit 1 ;;
esac
saved="$(redis-cli --no-auth-warning --user default ACL SAVE 2>&1 | tr -d '\r\n')"
[ "$saved" = "OK" ] || { echo "$saved" >&2; exit 1; }`
}

func redisACLFileSnapshotCommand() string {
	return `set -eu
set -f
umask 077
tmp=/data/users.acl.gateway-tmp
redis-cli --no-auth-warning --user default --raw ACL LIST >"$tmp"
test -s "$tmp"
chown 999:999 "$tmp"
chmod 0600 "$tmp"
mv "$tmp" /data/users.acl`
}

func redisACLFileRestoreCommand() string {
	return `set -eu
set -f
while IFS= read -r line; do
  [ -n "$line" ] || continue
  set -- $line
  [ "$1" = user ]
  shift
  redis-cli --no-auth-warning --user default ACL SETUSER "$@" >/dev/null
done </data/users.acl`
}

func redisOwnerRotateCommand() string {
	return `pending_probe="$(REDISCLI_AUTH="$GATEWAY_DB_PENDING_OWNER_PASSWORD" redis-cli --no-auth-warning --user default PING 2>&1 | tr -d '\r\n')"
if [ "$pending_probe" = "PONG" ]; then
  export REDISCLI_AUTH="$GATEWAY_DB_PENDING_OWNER_PASSWORD"
else
  export REDISCLI_AUTH="$GATEWAY_DB_CURRENT_OWNER_PASSWORD"
fi
rotated="$(printf '%s' ">$GATEWAY_DB_PENDING_OWNER_PASSWORD" | redis-cli --no-auth-warning --user default -x ACL SETUSER default reset on '~*' '&*' '+@all' 2>&1 | tr -d '\r\n')"
[ "$rotated" = "OK" ] || { echo "$rotated" >&2; exit 1; }
export REDISCLI_AUTH="$GATEWAY_DB_PENDING_OWNER_PASSWORD"
saved="$(redis-cli --no-auth-warning --user default ACL SAVE 2>&1 | tr -d '\r\n')"
[ "$saved" = "OK" ] || { echo "$saved" >&2; exit 1; }`
}

func redisBindingACLBaseRules() []string {
	return []string{
		"~*", "&*", "+@read", "+@write", "+@connection", "+@transaction", "+@pubsub",
		"+eval", "+evalsha", "-script", "-@dangerous",
	}
}

func redisBindingACLModernRules() []string {
	return []string{
		"+eval_ro", "+evalsha_ro", "+fcall", "+fcall_ro", "+script|load", "+script|exists",
		"-function", "-script|flush", "-script|kill", "-script|debug",
	}
}

func redisBindingACLShellWords(rules []string) string {
	return "'" + strings.Join(rules, "' '") + "'"
}

func redisBindingACLCommand() string {
	return fmt.Sprintf(`redis_major="$(redis-cli --no-auth-warning --user default INFO server 2>/dev/null | sed -n 's/^redis_version:\([0-9][0-9]*\)\..*/\1/p')"
set -- redis-cli --no-auth-warning --user default -x ACL SETUSER "$GATEWAY_DB_BINDING_USER" reset on
for acl_rule in %s; do
  set -- "$@" "$acl_rule"
done
case "$redis_major" in
  [7-9]|[1-9][0-9]*)
    for acl_rule in %s; do
      set -- "$@" "$acl_rule"
    done
    ;;
esac
printf '%%s' ">$GATEWAY_DB_BINDING_PASSWORD" | "$@"`, redisBindingACLShellWords(redisBindingACLBaseRules()), redisBindingACLShellWords(redisBindingACLModernRules()))
}

func (m *managedDatabaseManager) removeBindingPrincipal(ctx context.Context, record managedDatabaseRecord, input managedDatabaseBindingCommand) error {
	var command []string
	var stdin string
	var env []string
	switch record.Type {
	case "postgres":
		stdin = postgresBindingRemoveSQL(input)
		command = []string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName}
	case "redis":
		command = []string{"sh", "-ec", `redis-cli --no-auth-warning --user default ACL DELUSER "$GATEWAY_DB_BINDING_USER" >/dev/null || true`}
		env = []string{"REDISCLI_AUTH=" + input.OwnerPassword, "GATEWAY_DB_BINDING_USER=" + input.Username}
	case "clickhouse":
		stdin = clickHouseBindingRemoveSQL(input)
		command = []string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"}
		env = []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}
	default:
		return errors.New("unsupported managed database engine")
	}
	return m.runManagedDatabaseExec(ctx, record.ContainerID, command, stdin, env)
}

func postgresBindingCreateSQL(input managedDatabaseBindingCommand) string {
	return fmt.Sprintf(
		"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN EXECUTE 'CREATE ROLE ' || quote_ident(%s) || ' LOGIN PASSWORD ' || quote_literal(%s); ELSE EXECUTE 'ALTER ROLE ' || quote_ident(%s) || ' LOGIN PASSWORD ' || quote_literal(%s); END IF; END $$; GRANT ALL PRIVILEGES ON DATABASE %s TO %s; GRANT USAGE, CREATE ON SCHEMA public TO %s;\n",
		quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Password), quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Password), quoteSQLIdentifier(input.DatabaseName), quoteSQLIdentifier(input.Username), quoteSQLIdentifier(input.Username),
	)
}

func postgresBindingRemoveSQL(input managedDatabaseBindingCommand) string {
	return fmt.Sprintf(
		"DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN EXECUTE 'REASSIGN OWNED BY ' || quote_ident(%s) || ' TO ' || quote_ident(%s); EXECUTE 'DROP OWNED BY ' || quote_ident(%s); EXECUTE 'DROP ROLE ' || quote_ident(%s); END IF; END $$;\n",
		quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Username), quoteSQLLiteral(input.OwnerUsername), quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Username),
	)
}

func clickHouseBindingCreateSQL(input managedDatabaseBindingCommand) string {
	return clickHousePrincipalSQL(clickHousePrincipalCommand{
		PrincipalType: "binding",
		Username:      input.Username,
		Password:      input.Password,
		DatabaseName:  input.DatabaseName,
		OwnerUsername: input.OwnerUsername,
		OwnerPassword: input.OwnerPassword,
	}) + "\n"
}

func clickHousePrincipalSQL(input clickHousePrincipalCommand) string {
	if input.PrincipalType == "reader" {
		return clickHouseReaderPrincipalSQL(input)
	}
	return clickHouseWriterPrincipalSQL(input)
}

func clickHouseReaderPrincipalSQL(input clickHousePrincipalCommand) string {
	principal := quoteSQLIdentifier(input.Username)
	return fmt.Sprintf(
		"CREATE USER IF NOT EXISTS %s IDENTIFIED WITH sha256_password BY %s; ALTER USER %s IDENTIFIED WITH sha256_password BY %s; REVOKE ALL ON *.* FROM %s; GRANT SELECT ON %s.* TO %s; GRANT SELECT ON information_schema.* TO %s; GRANT SELECT(name) ON system.databases TO %s; GRANT SELECT(name, engine, total_rows, total_bytes, database, sorting_key, primary_key, partition_key, create_table_query) ON system.tables TO %s; GRANT SELECT(name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key, database, table, position) ON system.columns TO %s;",
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLIdentifier(input.DatabaseName),
		principal,
		principal,
		principal,
		principal,
		principal,
	)
}

func clickHouseWriterPrincipalSQL(input clickHousePrincipalCommand) string {
	principal := quoteSQLIdentifier(input.Username)
	return fmt.Sprintf(
		"CREATE USER IF NOT EXISTS %s IDENTIFIED WITH sha256_password BY %s; ALTER USER %s IDENTIFIED WITH sha256_password BY %s; REVOKE ALL ON *.* FROM %s; GRANT ALL ON %s.* TO %s; GRANT SELECT ON information_schema.* TO %s; GRANT SELECT(name) ON system.databases TO %s; GRANT SELECT(name, engine, total_rows, total_bytes, database, sorting_key, primary_key, partition_key, create_table_query) ON system.tables TO %s; GRANT SELECT(name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key, database, table, position) ON system.columns TO %s; GRANT SELECT ON system.parts TO %s; %s GRANT SELECT ON system.merges TO %s; GRANT SELECT ON system.mutations TO %s; GRANT SELECT ON system.events TO %s; GRANT SELECT ON system.disks TO %s;",
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLIdentifier(input.DatabaseName),
		principal,
		principal,
		principal,
		principal,
		principal,
		principal,
		clickHouseBindingProcessPrivilegesSQL(input.Username),
		principal,
		principal,
		principal,
		principal,
	)
}

func clickHouseBindingProcessPrivilegesSQL(username string) string {
	principal := quoteSQLIdentifier(username)
	return fmt.Sprintf("REVOKE SELECT ON system.processes FROM %s; GRANT SELECT(memory_usage) ON system.processes TO %s;", principal, principal)
}

func clickHouseBindingRemoveSQL(input managedDatabaseBindingCommand) string {
	return fmt.Sprintf("DROP USER IF EXISTS %s;\n", quoteSQLIdentifier(input.Username))
}

func quoteSQLIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func quoteSQLLiteral(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
}

// runManagedDatabaseExec runs a fixed engine client command. It deliberately
// suppresses command output: output can contain a query fragment, and callers
// only need a stable operational error, never a credential-bearing diagnostic.
