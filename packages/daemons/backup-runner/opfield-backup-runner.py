#!/usr/bin/env python3
"""Fixed native Opfield backup runner. It accepts no caller-provided commands or paths."""
import base64
import contextlib
import ftplib
import hashlib
import hmac
import io
import json
import os
import paramiko
import pathlib
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
import urllib.parse
import urllib.request

CONFIG = pathlib.Path("/run/opfield-backup/config.json")
# legacy-name: config mount of Docker daemons before 2.12.1 — remove once every node reports none
LEGACY_CONFIG = pathlib.Path("/run/gateway-backup/config.json")
WORK = pathlib.Path("/work")
RESULT = WORK / "result.json"
STARTED_AT = time.time()
# Leaves time to detach replication, restore masterauth and report a result
# before the executor enforces the run's deadline.
DEADLINE_RESERVE_SECONDS = 30
# A restore target that asks the staged Redis for a full copy this many times
# could not load the earlier copies (for example an RDB format newer than it reads).
REDIS_FULL_SYNC_ATTEMPTS = 3
# The staged Redis listens as soon as it starts and answers LOADING while it
# reads the dump. Refusing connections this long means it exited.
REDIS_STAGE_START_SECONDS = 60


class BackupError(Exception):
    pass


def main():
    operation = sys.argv[1] if len(sys.argv) == 2 else ""
    if operation == "storage-copy":
        return storage_copy_main()
    config = load_config()
    # The executor stops a cancelled or overdue runner with SIGTERM and waits
    # before it kills it: raising here runs the cleanup of the current step.
    signal.signal(signal.SIGTERM, stop_requested)
    try:
        if operation == "preflight":
            preflight(config)
            result(config, "completed", "preflight")
        elif operation == "backup":
            manifest = backup(config)
            result(config, "completed", "completed", manifest=manifest, bytes_written=sum(manifest["sizes"].values()))
        elif operation == "restore":
            restore(config)
            result(config, "completed", "completed")
        else:
            raise BackupError("unsupported operation")
    except Exception as error:
        result(config, "failed", operation or "validation", error=sanitize(str(error)))
        return 1
    return 0


def stop_requested(_signum, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise BackupError("the run was stopped: it was cancelled or reached its time limit")


def config_file():
    """The run config: the Opfield mount, else the one Docker daemons before 2.12.1 mount."""
    return CONFIG if CONFIG.exists() or not LEGACY_CONFIG.exists() else LEGACY_CONFIG


def load_config():
    path = config_file()
    st = path.stat()
    if st.st_mode & 0o077:
        raise BackupError("backup config permissions are unsafe")
    config = json.loads(path.read_text())
    required = {"runId", "version", "direction", "engine", "destination", "limits", "toolImage"}
    if set(config) - (required | {"source", "staging", "restoreTarget", "restoreArtifact", "redisStaging", "redisStageImage", "redisStageAdvertiseHost", "deadlineAt"}):
        raise BackupError("backup config has unrecognized fields")
    if required - set(config) or config["version"] != 1:
        raise BackupError("backup config is incomplete")
    if config["direction"] not in {"backup", "restore"} or config["engine"] not in {"postgres", "redis", "clickhouse"}:
        raise BackupError("backup config engine or direction is invalid")
    if config["direction"] == "restore" and not config.get("restoreTarget"):
        raise BackupError("restore target is required")
    if config["direction"] == "backup" and not config.get("source"):
        raise BackupError("backup source is required")
    return config


def result(config, status, phase, manifest=None, bytes_written=0, error=None):
    payload = {"runId": config.get("runId", ""), "status": status, "phase": phase, "bytes": bytes_written}
    if manifest:
        payload["manifest"] = manifest
    if error:
        payload["error"] = error
    WORK.mkdir(mode=0o700, exist_ok=True)
    temp = RESULT.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, separators=(",", ":")))
    os.chmod(temp, 0o600)
    temp.replace(RESULT)


def run_deadline(config):
    """Absolute time (epoch seconds) by which this run must finish."""
    deadline = STARTED_AT + int(config.get("limits", {}).get("timeoutSeconds", 3600))
    value = config.get("deadlineAt")
    if isinstance(value, str) and value:
        try:
            from datetime import datetime
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            deadline = min(deadline, parsed)
        except ValueError:
            raise BackupError("backup deadline is invalid")
    return deadline


def remaining_seconds(config, minimum=1):
    """Time left for a wait inside the run, keeping a reserve for cleanup."""
    return max(minimum, run_deadline(config) - time.time() - DEADLINE_RESERVE_SECONDS)


def run(args, env=None, input_text=None):
    completed = subprocess.run(args, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, check=False)
    if completed.returncode:
        raise BackupError(command_failure(args[0], completed.stderr or completed.stdout))
    return completed.stdout


@contextlib.contextmanager
def cleanup_after(cleanup):
    """Runs `cleanup` when the block ends. When the block failed, the run reports that failure: the cleanup then often
    finds nothing to remove (rclone: `... is a directory or doesn't exist`), and its own error must not replace the cause,
    such as a full storage that refused the write (stand rc.6, O-2)."""
    try:
        yield
    except BaseException:
        try:
            cleanup()
        except Exception:
            pass
        raise
    cleanup()


@contextlib.contextmanager
def discard_on_failure(cleanup):
    """Runs `cleanup` only when the block fails, then reports the original failure. A failed or stopped backup removes
    the files it already uploaded under its own prefix, so a destination that keeps failing does not fill up with
    partial dumps. A killed runner cannot clean up: Opfield's sweep of unfinished runs removes those later."""
    try:
        yield
    except BaseException:
        try:
            cleanup()
        except Exception:
            pass
        raise


def discard_uploads(endpoint, owned_prefix, keys):
    """Removes the files of this run: everything under its own prefix on S3, else each file it started to upload."""
    if endpoint["provider"] == "s3":
        delete_prefix(endpoint, owned_prefix)
        return
    for key in keys:
        try:
            delete_object(endpoint, key)
        except Exception:
            pass


def command_failure(program, output):
    """The failed tool and the last lines it printed, which name the actual cause."""
    lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
    detail = " ".join(lines[-3:])[:512]
    name = os.path.basename(program)
    return f"{name} failed: {detail}" if detail else f"{name} failed with no output"


def safe_part(value):
    if not isinstance(value, str):
        raise BackupError("unsafe backup storage path")
    value = value.strip("/")
    if (
        not value
        or "\\" in value
        or any(ord(character) < 32 for character in value)
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise BackupError("unsafe backup storage path")
    return value


def db_args(endpoint, executable):
    args = [executable, "-h", endpoint["host"], "-p", str(endpoint["port"])]
    if endpoint.get("username"):
        args.extend(["-U", endpoint["username"]])
    return args


POSTGRES_TOOLS = pathlib.Path("/usr/lib/postgresql")


def postgres_major(endpoint):
    version = run(db_args(endpoint, "psql") + ["-Atqc", "SHOW server_version_num"], postgres_env(endpoint)).strip()
    return int(version) // 10000


def postgres_tool(name, major):
    # A dump written by a newer pg_dump does not restore into an older server: it carries settings that
    # server rejects. Use the client of the server's own major; the image default only covers the newest.
    candidate = POSTGRES_TOOLS / str(major) / "bin" / name
    return str(candidate) if candidate.exists() else name


def postgres_restore_tool(target, artifact):
    tool = postgres_tool("pg_restore", postgres_major(target))
    if tool == "pg_restore": return tool
    try:
        run([tool, "--list", str(artifact)])
    except BackupError:
        # An archive written by a newer pg_dump can only be read by that newer pg_restore.
        return "pg_restore"
    return tool


SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"


def tls_verification(endpoint):
    """Explicit per-connection verification; None keeps the behavior of endpoints that do not carry it (managed relay routes)."""
    value = endpoint.get("tlsVerifyCertificate")
    return value if isinstance(value, bool) else None


def write_ca(endpoint, name):
    ca = WORK / name; ca.write_text(endpoint["caPem"]); os.chmod(ca, 0o600)
    return ca


def is_ip_address(value):
    try:
        socket.inet_pton(socket.AF_INET6 if ":" in value else socket.AF_INET, value)
        return True
    except OSError:
        return False


def postgres_database(endpoint):
    """The connection's database name, checked so libpq never reads it as a connection string.

    libpq expands a dbname that contains "=" or starts with a postgres URI into connection settings, which
    would override the host, port and TLS settings given separately. The name travels in PGDATABASE, which
    libpq never expands; only pg_restore takes it as -d, so it must not have that form either.
    """
    name = endpoint.get("database")
    if (
        not isinstance(name, str)
        or not name
        or "=" in name
        or name.lower().startswith(("postgresql://", "postgres://"))
        or any(ord(character) < 32 for character in name)
    ):
        raise BackupError("PostgreSQL database name is invalid")
    return name


def postgres_env(endpoint):
    env = os.environ.copy()
    env["PGDATABASE"] = postgres_database(endpoint)
    env["PGPASSWORD"] = endpoint.get("password", "")
    if endpoint.get("tls"):
        verify = tls_verification(endpoint)
        if verify is False:
            env["PGSSLMODE"] = "require"
        elif verify is True:
            # Chain and hostname, against the connection's CA or the public bundle.
            env["PGSSLMODE"] = "verify-full"
            env["PGSSLROOTCERT"] = str(write_ca(endpoint, "postgres-ca.pem")) if endpoint.get("caPem") else SYSTEM_CA_BUNDLE
        else:
            env["PGSSLMODE"] = "verify-ca" if endpoint.get("caPem") else "require"
            if endpoint.get("caPem"):
                env["PGSSLROOTCERT"] = str(write_ca(endpoint, "postgres-ca.pem"))
        if endpoint.get("serverName"):
            env["PGHOST"] = endpoint["host"]
    return env


def preflight(config):
    engine = config["engine"]
    if config["direction"] == "backup":
        source = config["source"]
        if engine == "postgres":
            run(db_args(source, "psql") + ["-Atqc", "SELECT 1"], postgres_env(source))
        elif engine == "redis":
            redis_command(source, ["PING"])
            assert_redis_replication_access(source)
        else:
            clickhouse_query(source, "SELECT 1")
            stage = config.get("staging") or config["destination"]
            if stage.get("provider") != "s3": raise BackupError("clickhouse requires an S3 native staging destination")
            probe_prefix = safe_part(stage.get("prefix", "database-backups")) + "/probe/" + config["runId"]
            with cleanup_after(lambda: delete_prefix(stage, probe_prefix)):
                # Preflight has seconds, not the run's time limit: prove the server itself can write to the
                # staging bucket with a one-row object instead of backing the whole database up twice.
                clickhouse_query(source, f"INSERT INTO FUNCTION {clickhouse_s3(stage, 'probe/' + config['runId'] + '/probe.csv', ['CSV', 'probe UInt8'])} SELECT 1")
                if not list_objects(stage, probe_prefix):
                    raise BackupError("clickhouse native staging probe produced no objects")
    else:
        assert_empty_target(engine, config["restoreTarget"])
    probe = WORK / "probe"; probe.write_bytes(b"opfield-backup-probe")
    remote = remote_key(config["destination"], f"{config['runId']}/.probe")
    with cleanup_after(lambda: delete_object(config["destination"], remote)):
        try:
            upload(config["destination"], probe, remote)
        except Exception as error:
            raise BackupError(f"writing a test file to the backup storage failed: {error}") from error
        copied = WORK / "probe-copy"
        try:
            download(config["destination"], remote, copied)
        except Exception as error:
            raise BackupError(f"reading the test file back from the backup storage failed: {error}") from error
        if not copied.is_file() or copied.read_bytes() != probe.read_bytes():
            raise BackupError("destination probe read did not match write")


def backup(config):
    artifact_dir = WORK / ("artifacts-" + config["runId"]); artifact_dir.mkdir(mode=0o700, exist_ok=True)
    engine = config["engine"]
    if engine == "postgres":
        artifact = artifact_dir / "database.dump"
        source = config["source"]
        run(db_args(source, postgres_tool("pg_dump", postgres_major(source))) + ["--format=custom", "--no-owner", "--no-privileges", "--file", str(artifact)], postgres_env(source))
        engine_version = run(db_args(source, "psql") + ["-Atqc", "SHOW server_version"], postgres_env(source)).strip()
    elif engine == "redis":
        artifact = artifact_dir / "database.rdb"
        redis_command(config["source"], ["--rdb", str(artifact)])
        engine_version = redis_version(config["source"])
    else:
        return clickhouse_backup(config)
    return upload_artifacts(config, artifact_dir, engine_version)


def restore(config):
    manifest = config.get("restoreArtifact")
    if not manifest or not manifest.get("artifactKeys") or not manifest.get("fileChecksums"):
        raise BackupError("restore artifact manifest is incomplete")
    # ClickHouse stages each artifact into native S3. Its restore path performs
    # the checksum-verified download, so the generic restore directory would
    # only download the same artifacts a second time.
    if config["engine"] == "clickhouse":
        assert_empty_target(config["engine"], config["restoreTarget"])
        restore_clickhouse(config, manifest)
        return
    artifact_dir = WORK / "restore"; artifact_dir.mkdir(mode=0o700, exist_ok=True)
    for key in manifest["artifactKeys"]:
        local = artifact_dir / pathlib.PurePosixPath(key).name
        download(config["destination"], key, local)
        if sha256(local) != manifest["fileChecksums"].get(key):
            raise BackupError("artifact checksum mismatch")
    # A target can change after the earlier preflight. Recheck immediately
    # before any engine-native restore command.
    assert_empty_target(config["engine"], config["restoreTarget"])
    if config["engine"] == "postgres":
        artifact = next(artifact_dir.glob("*.dump"))
        target = config["restoreTarget"]
        # pg_restore restores into a database only with -d; a checked name is never read as a connection string.
        run(db_args(target, postgres_restore_tool(target, artifact)) + ["-d", postgres_database(target), "--no-owner", "--no-privileges", "--exit-on-error", str(artifact)], postgres_env(target))
        if target.get("managedDatabaseId"):
            transfer_postgres_ownership(target)
    elif config["engine"] == "redis":
        restore_redis(config, next(artifact_dir.glob("*.rdb")))
    else:
        restore_clickhouse(config, manifest)


# A managed PostgreSQL database is owned by a NOLOGIN application role that
# binding and direct-access principals SET ROLE to, while Opfield restores as
# its superuser control account. --no-owner makes every restored object owned
# by that control account, which the application role cannot use. Hand them to
# the database owner. Legacy managed databases (owner == restoring account) and
# superuser-owned databases are left unchanged.
POSTGRES_OWNERSHIP_TRANSFER_SQL = """
DO $opfield$
DECLARE
  database_owner name;
  owner_is_superuser boolean;
BEGIN
  SELECT r.rolname, r.rolsuper INTO database_owner, owner_is_superuser
  FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
  WHERE d.datname = current_database();
  IF database_owner IS NULL OR database_owner = current_user OR owner_is_superuser THEN
    RETURN;
  END IF;
  EXECUTE format('REASSIGN OWNED BY %I TO %I', current_user, database_owner);
END
$opfield$;
"""


def transfer_postgres_ownership(target):
    run(db_args(target, "psql") + ["-v", "ON_ERROR_STOP=1", "-Atq"], postgres_env(target), POSTGRES_OWNERSHIP_TRANSFER_SQL)


def upload_artifacts(config, artifact_dir, engine_version):
    owned_prefix = safe_part(config["destination"].get("prefix", "database-backups")) + "/" + config["runId"]
    keys, sizes, checksums = [], {}, {}
    attempted = []
    with discard_on_failure(lambda: discard_uploads(config["destination"], owned_prefix, attempted)):
        for file in sorted(artifact_dir.iterdir()):
            key = remote_key(config["destination"], f"{owned_prefix}/{file.name}")
            attempted.append(key)
            upload(config["destination"], file, key)
            keys.append(key); sizes[key] = file.stat().st_size; checksums[key] = sha256(file)
        manifest = {"engine": config["engine"], "version": 1, "engineVersion": engine_version, "sourceIdentity": config["source"]["connectionId"], "sourceDatabase": config["source"].get("database"), "artifactKeys": keys, "sizes": sizes, "fileChecksums": checksums, "ownedPrefix": owned_prefix}
        manifest["manifestSha256"] = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        manifest_path = artifact_dir / "manifest.json"; manifest_path.write_text(json.dumps(manifest, sort_keys=True)); os.chmod(manifest_path, 0o600)
        manifest_key = remote_key(config["destination"], f"{owned_prefix}/manifest.json")
        attempted.append(manifest_key)
        upload(config["destination"], manifest_path, manifest_key)
    return manifest


def redis_command(endpoint, command, last_argument=None):
    args = ["redis-cli", "--no-auth-warning", "-h", endpoint["host"], "-p", str(endpoint["port"])]
    if endpoint.get("username"): args.extend(["--user", endpoint["username"]])
    verify = tls_verification(endpoint)
    if endpoint.get("tls"):
        args.append("--tls")
        if verify is False:
            args.append("--insecure")
        elif verify is True and not is_ip_address(endpoint["host"]):
            args.extend(["--sni", endpoint["host"]])
    if endpoint.get("caPem") and verify is not False:
        args.extend(["--cacert", str(write_ca(endpoint, "redis-ca.pem"))])
    env = os.environ.copy()
    if endpoint.get("password"):
        env["REDISCLI_AUTH"] = endpoint["password"]
    else:
        env.pop("REDISCLI_AUTH", None)
    if last_argument is not None:
        # -x reads the final argument from stdin, keeping it out of argv.
        return run(args + ["-x"] + command, env, last_argument)
    return run(args + command, env)


def redis_command_secret_last(endpoint, command, secret):
    """Runs a Redis command whose last argument is a secret without exposing it in the process arguments."""
    return redis_command(endpoint, command, last_argument=secret)


def redis_server(endpoint):
    """The engine and version of a key-value server: Valkey reports valkey_version
    beside redis_version, which only names the Redis release it stays compatible with."""
    fields = {}
    for line in redis_command(endpoint, ["INFO", "server"]).replace("\r", "").splitlines():
        name, separator, value = line.partition(":")
        if separator: fields[name] = value.strip()
    if fields.get("valkey_version"): return "valkey", fields["valkey_version"]
    if fields.get("redis_version"): return "redis", fields["redis_version"]
    raise BackupError("key-value server version is unavailable")


def redis_version(endpoint):
    """The engineVersion of a key-value backup: "valkey <version>" for Valkey, the bare version for Redis."""
    engine, version = redis_server(endpoint)
    return f"valkey {version}" if engine == "valkey" else version


def redis_engine_label(engine, version):
    return f"{'Valkey' if engine == 'valkey' else 'Redis'} {version}"


def assert_same_redis_engine(target, stage):
    """Valkey and Redis cannot load each other's data: the staged server runs the
    engine the backup was taken from, and the target must run the same one."""
    target_engine, target_version = redis_server(target)
    stage_engine, stage_version = redis_server(stage)
    if target_engine == stage_engine:
        return
    where = "a new key-value store or one that still runs Redis" if stage_engine == "redis" else "a key-value store that runs Valkey"
    raise BackupError(
        f"this backup was taken from {redis_engine_label(stage_engine, stage_version)} and the restore target runs "
        f"{redis_engine_label(target_engine, target_version)}, which cannot load it; restore it into {where}"
    )


def assert_empty_target(engine, target):
    if engine == "postgres":
        query = "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','m','v','S')"
        if run(db_args(target, "psql") + ["-Atqc", query], postgres_env(target)).strip() != "0": raise BackupError("PostgreSQL restore target is not empty")
    elif engine == "redis":
        if redis_has_keys(target): raise BackupError("Redis restore target is not empty")
    else:
        if clickhouse_query(target, "SELECT count() FROM system.tables WHERE database = currentDatabase() AND is_temporary = 0").strip() != "0": raise BackupError("ClickHouse restore target is not empty")


def redis_has_keys(target):
    # REPLICAOF affects the entire Redis instance. INFO keyspace covers every
    # non-empty logical DB, while DBSIZE checks only the selected DB (usually 0).
    lines = redis_command(target, ["INFO", "keyspace"]).replace("\r", "").split("\n")
    if "# Keyspace" not in lines:
        raise BackupError("Redis target keyspace inspection failed")
    for line in lines:
        name, separator, details = line.partition(":")
        if not separator or not name.startswith("db") or not name[2:].isdigit():
            continue
        values = dict(part.split("=", 1) for part in details.split(",") if "=" in part)
        if "keys" not in values:
            raise BackupError("Redis target keyspace inspection failed")
        key_count = values["keys"]
        if not key_count.isascii() or not key_count.isdigit() or int(key_count) < 0:
            raise BackupError("Redis target keyspace inspection failed")
        if int(key_count) > 0:
            return True
    return False


def clickhouse_ssl_context(endpoint):
    context = ssl.create_default_context(cadata=endpoint["caPem"]) if endpoint.get("caPem") else ssl.create_default_context()
    if tls_verification(endpoint) is False:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def clickhouse_query(endpoint, query, timeout=60):
    scheme = "https" if endpoint.get("tls") else "http"
    url = f"{scheme}://{endpoint['host']}:{endpoint['port']}/?database={urllib.parse.quote(endpoint.get('database', 'default'))}"
    request = urllib.request.Request(url, data=query.encode(), method="POST")
    token = base64.b64encode(f"{endpoint.get('username','')}:{endpoint.get('password','')}".encode()).decode()
    request.add_header("Authorization", "Basic " + token)
    context = clickhouse_ssl_context(endpoint)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            return response.read().decode()
    except Exception as error:
        raise BackupError("clickhouse native command failed") from error


def clickhouse_s3(endpoint, suffix, extra=()):
    native_endpoint = endpoint.get("nativeEndpoint") or endpoint.get("endpoint")
    parsed = urllib.parse.urlparse(native_endpoint or "")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise BackupError("clickhouse requires a server-reachable native S3 endpoint")
    base = native_endpoint.rstrip("/") + "/" + endpoint["bucket"] + "/" + safe_part(endpoint.get("prefix", "database-backups")) + "/" + suffix.strip("/")
    # BACKUP/RESTORE take the S3 engine; with a format and structure in `extra` the same arguments form the s3() table function.
    return ("s3(" if extra else "S3(") + ", ".join(repr(value) for value in [base, endpoint["accessKeyId"], endpoint["secretAccessKey"], *extra]) + ")"


def clickhouse_backup(config):
    stage = config.get("staging") or config["destination"]
    if stage.get("provider") != "s3": raise BackupError("clickhouse native backup requires S3 staging")
    database = quote_identifier(config["source"].get("database", "default")); stage_prefix = "native/" + config["runId"]
    stage_root = safe_part(stage.get("prefix", "database-backups")) + "/" + stage_prefix
    with cleanup_after(lambda: delete_prefix(stage, stage_root)):
        # BACKUP is synchronous and runs for as long as the data takes; the run's own limit bounds it.
        clickhouse_query(config["source"], f"BACKUP DATABASE {database} TO {clickhouse_s3(stage, stage_prefix)}", timeout=config["limits"]["timeoutSeconds"])
        entries = list_objects(stage, stage_root)
        if not entries:
            raise BackupError("clickhouse native backup produced no staged artifacts")
        owned_prefix = safe_part(config["destination"].get("prefix", "database-backups")) + "/" + config["runId"]
        keys, sizes, checksums = [], {}, {}
        attempted = []
        transfer_dir = WORK / "clickhouse-transfer"; transfer_dir.mkdir(mode=0o700, exist_ok=True)
        with discard_on_failure(lambda: discard_uploads(config["destination"], owned_prefix, attempted)):
            for source_key in entries:
                relative = source_key.removeprefix(stage_root + "/")
                local = transfer_dir / pathlib.PurePosixPath(relative)
                local.parent.mkdir(parents=True, exist_ok=True)
                download(stage, source_key, local)
                key = remote_key(config["destination"], f"{owned_prefix}/{relative}")
                attempted.append(key)
                upload(config["destination"], local, key)
                keys.append(key); sizes[key] = local.stat().st_size; checksums[key] = sha256(local)
            manifest = {"engine": "clickhouse", "version": 1, "engineVersion": clickhouse_query(config["source"], "SELECT version()").strip(), "sourceIdentity": config["source"]["connectionId"], "sourceDatabase": config["source"].get("database", "default"), "artifactKeys": keys, "sizes": sizes, "fileChecksums": checksums, "ownedPrefix": owned_prefix, "nativeStagePrefix": stage_root}
            manifest["manifestSha256"] = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            manifest_path = transfer_dir / "manifest.json"; manifest_path.write_text(json.dumps(manifest, sort_keys=True)); os.chmod(manifest_path, 0o600)
            manifest_key = remote_key(config["destination"], f"{owned_prefix}/manifest.json")
            attempted.append(manifest_key)
            upload(config["destination"], manifest_path, manifest_key)
        return manifest


def restore_clickhouse(config, manifest):
    stage = config.get("staging") or config["destination"]
    if stage.get("provider") != "s3": raise BackupError("clickhouse native restore requires S3 staging")
    if not manifest.get("nativeStagePrefix"):
        raise BackupError("clickhouse artifact has no native stage layout")
    restore_prefix = safe_part(stage.get("prefix", "database-backups")) + "/native-restore/" + config["runId"]
    transfer_dir = WORK / "clickhouse-restore"; transfer_dir.mkdir(mode=0o700, exist_ok=True)
    source_prefix = safe_part(manifest["ownedPrefix"])
    with cleanup_after(lambda: delete_prefix(stage, restore_prefix)):
        for source_key in manifest["artifactKeys"]:
            relative = source_key.removeprefix(source_prefix + "/")
            local = transfer_dir / pathlib.PurePosixPath(relative)
            local.parent.mkdir(parents=True, exist_ok=True)
            download(config["destination"], source_key, local)
            if sha256(local) != manifest["fileChecksums"].get(source_key): raise BackupError("clickhouse artifact checksum mismatch")
            upload(stage, local, remote_key(stage, f"{restore_prefix}/{relative}"))
        target = config["restoreTarget"]
        source_database = manifest.get("sourceDatabase")
        if not isinstance(source_database, str) or not source_database:
            raise BackupError("clickhouse artifact source database is missing")
        target_database = quote_identifier(target.get("database", "default"))
        clickhouse_query(target, f"RESTORE DATABASE {quote_source_identifier(source_database)} AS {target_database} FROM {clickhouse_s3(stage, restore_prefix.removeprefix(safe_part(stage.get('prefix', 'database-backups')) + '/'))}", timeout=config["limits"]["timeoutSeconds"])


def restore_redis(config, artifact):
    target = config["restoreTarget"]
    stage = config.get("redisStaging")
    if not stage: raise BackupError("external Redis restore requires node-created staged Redis")
    stage_dir = WORK / "redis-stage"; stage_dir.mkdir(mode=0o700, exist_ok=True)
    # The staged Redis starts as soon as dump.rdb exists, so it must appear complete.
    shutil.copyfile(artifact, stage_dir / "dump.rdb.tmp")
    os.replace(stage_dir / "dump.rdb.tmp", stage_dir / "dump.rdb")
    wait_for_redis_stage(config, stage)
    redis_command(target, ["PING"])
    assert_same_redis_engine(target, stage)
    previous_masterauth = redis_config_value(target, "masterauth")
    # From here on every outcome, a stop request included, detaches the target.
    try:
        if stage.get("password"):
            redis_command_secret_last(target, ["CONFIG", "SET", "masterauth"], stage["password"])
        redis_command(target, ["REPLICAOF", stage["host"], str(stage["port"])])
        wait_for_redis_sync(config, target, stage)
    except BaseException as error:
        problem = detach_redis_target(target, previous_masterauth)
        if problem:
            raise BackupError(f"{error}; {problem}") from error
        raise
    problem = detach_redis_target(target, previous_masterauth)
    if problem:
        raise BackupError(problem)


def wait_for_redis_stage(config, stage):
    # A large dump takes long to load: the wait uses the run's remaining time.
    deadline = time.time() + remaining_seconds(config)
    refused_since = None
    while time.time() < deadline:
        try:
            redis_command(stage, ["PING"])
            return
        except BackupError as error:
            if "refused" not in str(error).lower():
                refused_since = None
            elif refused_since is None:
                refused_since = time.time()
            elif time.time() - refused_since > REDIS_STAGE_START_SECONDS:
                raise BackupError("the staged Redis exited before it was ready: it could not load the backup's dump")
            time.sleep(0.5)
    raise BackupError("staged Redis did not become ready")


def wait_for_redis_sync(config, target, stage):
    # Replicating a large dump takes long: the wait uses the run's remaining time.
    started = time.time()
    deadline = started + remaining_seconds(config)
    while time.time() < deadline:
        info = redis_command(target, ["INFO", "replication"])
        if "master_sync_in_progress:0" in info and "master_link_status:up" in info and "role:slave" in info:
            return
        # A target that cannot load the copy drops it and asks for a new one,
        # forever: only the staged Redis counts the attempts.
        full_syncs = redis_info_number(redis_command(stage, ["INFO", "stats"]), "sync_full")
        if full_syncs >= REDIS_FULL_SYNC_ATTEMPTS:
            raise BackupError(redis_load_failure(target, stage))
        if full_syncs == 0 and time.time() - started > REDIS_STAGE_START_SECONDS:
            raise BackupError(
                f"the restore target did not connect to the staged Redis at {stage['host']}:{stage['port']}: "
                "it must reach the Storage node at that address"
            )
        time.sleep(1)
    raise BackupError("Redis full synchronization did not complete")


def redis_info_number(info, field):
    for line in info.replace("\r", "").split("\n"):
        name, separator, value = line.partition(":")
        if separator and name == field and value.strip().isdigit():
            return int(value.strip())
    return 0


def redis_load_failure(target, stage):
    try:
        target_server, stage_server = redis_server(target), redis_server(stage)
    except BackupError:
        return "the restore target could not load the data replicated to it; restore into the engine version the backup was taken with or a newer one"
    stage_label = redis_engine_label(*stage_server)
    return (
        f"the restore target runs {redis_engine_label(*target_server)}, which could not load the data of this backup "
        f"replicated from {stage_label}; restore into {stage_label} or newer"
    )


def detach_redis_target(target, previous_masterauth):
    """Returns the target to a primary with its own masterauth and a dump it can load.

    Every step is attempted and a failure is returned rather than raised, so the
    cause of the run's outcome is kept. A stop request no longer interrupts it.
    """
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    steps = (
        ("REPLICAOF NO ONE", lambda: redis_command(target, ["REPLICAOF", "NO", "ONE"])),
        ("restore masterauth", lambda: redis_command_secret_last(target, ["CONFIG", "SET", "masterauth"], previous_masterauth)),
        # A failed full synchronization leaves the target's dump.rdb replaced by
        # the copy it could not load, so it would not start again. SAVE rewrites
        # it from the data the target holds.
        ("SAVE", lambda: redis_command(target, ["SAVE"])),
    )
    failures = []
    for name, step in steps:
        try:
            step()
        except BackupError as error:
            failures.append(f"{name}: {error}")
    if failures:
        return "the restore target could not be returned to its previous state (" + "; ".join(failures) + ")"
    return None


def assert_redis_replication_access(source):
    """redis-cli --rdb reads the data over replication (REPLCONF, then SYNC).

    A user without those commands would fail only once the backup runs. Both are in
    the @admin and @dangerous categories; REPLCONF is harmless on a client connection.
    """
    try:
        reply = redis_command(source, ["REPLCONF", "capa", "eof"]).strip()
    except BackupError as error:
        reply = str(error)
    if "NOPERM" in reply or "no permissions" in reply:
        raise BackupError(
            "the Redis user cannot run the replication commands a backup reads the data with (REPLCONF and SYNC): "
            "allow them for this user (+replconf +sync) or use a user that has them. Redis said: " + reply
        )


def redis_config_value(endpoint, key):
    lines = redis_command(endpoint, ["CONFIG", "GET", key]).replace("\r", "").split("\n")
    if len(lines) < 2 or lines[0] != key:
        raise BackupError("Redis target admin preflight failed")
    return lines[1]


def remote_key(endpoint, value):
    # Manifest keys remain logical bucket-relative object names regardless of
    # transport. Base paths belong only to FTP-family I/O, so control-plane
    # retention can delete by (bucket, key) without double-prefixing them.
    return safe_part(value)


def file_protocol_path(endpoint, logical_key):
    logical_key = remote_key(endpoint, logical_key)
    bucket = safe_part(endpoint.get("bucket", ""))
    base_path = endpoint.get("basePath", "")
    if not isinstance(base_path, str) or "\\" in base_path or any(ord(character) < 32 for character in base_path):
        raise BackupError("unsafe backup storage path")
    absolute = base_path.startswith("/")
    stripped = base_path.strip("/")
    if stripped and any(part in {"", ".", ".."} for part in stripped.split("/")):
        raise BackupError("unsafe backup storage path")
    prefix = ("/" if absolute else "") + stripped
    return "/".join(part for part in (prefix, bucket, logical_key) if part)


def rclone_config(endpoint):
    path = WORK / "rclone.conf"
    parsed = urllib.parse.urlparse(endpoint["endpoint"])
    lines = ["[target]", "type = s3", "provider = Other", f"endpoint = {parsed.scheme}://{parsed.netloc}", f"access_key_id = {endpoint.get('accessKeyId','')}", f"secret_access_key = {endpoint.get('secretAccessKey','')}"]
    if endpoint.get("region"): lines.append(f"region = {endpoint['region']}")
    lines.append(f"force_path_style = {'true' if endpoint.get('forcePathStyle') else 'false'}")
    lines.append("no_check_bucket = true")
    if endpoint.get("sessionToken"): lines.append(f"session_token = {endpoint['sessionToken']}")
    path.write_text("\n".join(lines) + "\n"); os.chmod(path, 0o600)
    return path


def rclone_args(endpoint, *args):
    command = ["rclone", "--config", str(rclone_config(endpoint))]
    if endpoint.get("caPem"):
        ca_path = WORK / "s3-ca.pem"
        ca_path.write_text(endpoint["caPem"])
        os.chmod(ca_path, 0o600)
        command.extend(["--ca-cert", str(ca_path)])
    return [*command, *args]


def list_objects(endpoint, prefix):
    if endpoint["provider"] != "s3": raise BackupError("native ClickHouse staging must use S3")
    raw = run(rclone_args(endpoint, "lsjson", "--recursive", f"target:{endpoint['bucket']}/{prefix}"))
    entries = json.loads(raw)
    return [remote_key(endpoint, f"{prefix}/{entry['Path']}") for entry in entries if not entry.get("IsDir")]


def upload(endpoint, local, remote):
    if endpoint["provider"] == "s3":
        run(rclone_args(endpoint, "copyto", str(local), f"target:{endpoint['bucket']}/{remote}")); return
    ftp_upload(endpoint, local, file_protocol_path(endpoint, remote))


def download(endpoint, remote, local):
    if endpoint["provider"] == "s3":
        run(rclone_args(endpoint, "copyto", f"target:{endpoint['bucket']}/{remote}", str(local))); return
    ftp_download(endpoint, file_protocol_path(endpoint, remote), local)


def delete_object(endpoint, remote):
    remote = remote_key(endpoint, remote)
    if endpoint["provider"] == "s3":
        run(rclone_args(endpoint, "deletefile", f"target:{endpoint['bucket']}/{remote}"))
        return
    ftp_delete(endpoint, file_protocol_path(endpoint, remote))


def delete_prefix(endpoint, prefix):
    if endpoint["provider"] != "s3":
        raise BackupError("deleting a prefix needs S3 storage")
    # The trailing slash keeps the deletion inside this directory: run `abc` never matches `abcd`.
    prefix = safe_part(prefix)
    run(rclone_args(endpoint, "delete", "--rmdirs", f"target:{endpoint['bucket']}/{prefix}/"))


class ImplicitFTP_TLS(ftplib.FTP_TLS):
    def connect(self, host="", port=0, timeout=-999):
        self.host = host
        self.port = port
        if timeout != -999: self.timeout = timeout
        self.sock = self.context.wrap_socket(
            socket.create_connection((self.host, self.port), self.timeout), server_hostname=self.host
        )
        self.af = self.sock.family
        self.file = self.sock.makefile("r", encoding=self.encoding)
        self.welcome = self.getresp()
        return self.welcome


def ftp_client(endpoint):
    if endpoint["provider"] == "sftp": return None
    context = ssl.create_default_context(cadata=endpoint.get("caPem"))
    if endpoint["provider"] == "ftps":
        client = ImplicitFTP_TLS(context=context) if endpoint.get("implicitTls") else ftplib.FTP_TLS(context=context)
    else:
        client = ftplib.FTP()
    client.connect(endpoint["host"], endpoint["port"], timeout=60)
    if endpoint["provider"] == "ftps" and not endpoint.get("implicitTls"):
        client.auth()
    client.login(endpoint.get("username", ""), endpoint.get("password", ""))
    if endpoint["provider"] == "ftps": client.prot_p()
    return client


def ftp_upload(endpoint, local, remote):
    if endpoint["provider"] == "sftp": return sftp_transfer(endpoint, local, remote, True)
    client = ftp_client(endpoint)
    try:
        ensure_ftp_dirs(client, pathlib.PurePosixPath(remote).parent)
        with local.open("rb") as source: client.storbinary("STOR " + remote, source)
    finally: client.quit()


def ftp_download(endpoint, remote, local):
    if endpoint["provider"] == "sftp": return sftp_transfer(endpoint, local, remote, False)
    client = ftp_client(endpoint)
    try:
        with local.open("wb") as target: client.retrbinary("RETR " + remote, target.write)
    finally: client.quit()


def ftp_delete(endpoint, remote):
    if endpoint["provider"] == "sftp": return sftp_delete(endpoint, remote)
    client = ftp_client(endpoint)
    try:
        client.delete(remote)
    finally: client.quit()


def ensure_ftp_dirs(client, path):
    current = "/" if path.is_absolute() else ""
    for part in path.parts:
        if part in {"", ".", "/"}: continue
        current = f"{current.rstrip('/')}/{part}" if current else part
        try: client.mkd(current)
        except ftplib.error_perm: pass


def file_remote_path(value):
    absolute = value.startswith("/")
    return ("/" if absolute else "") + safe_part(value.lstrip("/"))


def sftp_transfer(endpoint, local, remote, upload_mode):
    remote = file_remote_path(remote)
    transport = paramiko.Transport((endpoint["host"], endpoint["port"]))
    try:
        transport.start_client(timeout=60)
        remote_key = transport.get_remote_server_key()
        actual = "SHA256:" + base64.b64encode(hashlib.sha256(remote_key.asbytes()).digest()).decode().rstrip("=")
        expected = str(endpoint.get("hostKeyFingerprint", "")).rstrip("=")
        if not hmac.compare_digest(actual, expected):
            raise BackupError("SFTP host key fingerprint did not match pin")
        username = endpoint.get("username", "")
        if endpoint.get("privateKey"):
            private_key = load_sftp_private_key(endpoint["privateKey"], endpoint.get("passphrase"))
            transport.auth_publickey(username, private_key)
        elif endpoint.get("password"):
            transport.auth_password(username, endpoint["password"])
        else:
            raise BackupError("SFTP credentials are required")
        if not transport.is_authenticated():
            raise BackupError("SFTP authentication failed")
        client = paramiko.SFTPClient.from_transport(transport)
        try:
            if upload_mode:
                ensure_sftp_dirs(client, pathlib.PurePosixPath(remote).parent)
                client.put(str(local), remote, confirm=True)
            else:
                client.get(remote, str(local))
        finally:
            client.close()
    except BackupError:
        raise
    except Exception as error:
        raise BackupError("SFTP transfer failed") from error
    finally:
        transport.close()


def sftp_delete(endpoint, remote):
    remote = file_remote_path(remote)
    transport = paramiko.Transport((endpoint["host"], endpoint["port"]))
    try:
        transport.start_client(timeout=60)
        actual = "SHA256:" + base64.b64encode(hashlib.sha256(transport.get_remote_server_key().asbytes()).digest()).decode().rstrip("=")
        expected = str(endpoint.get("hostKeyFingerprint", "")).rstrip("=")
        if not hmac.compare_digest(actual, expected):
            raise BackupError("SFTP host key fingerprint did not match pin")
        username = endpoint.get("username", "")
        if endpoint.get("privateKey"):
            transport.auth_publickey(username, load_sftp_private_key(endpoint["privateKey"], endpoint.get("passphrase")))
        elif endpoint.get("password"):
            transport.auth_password(username, endpoint["password"])
        else:
            raise BackupError("SFTP credentials are required")
        client = paramiko.SFTPClient.from_transport(transport)
        try:
            client.remove(remote)
        finally:
            client.close()
    except BackupError:
        raise
    except Exception as error:
        raise BackupError("SFTP cleanup failed") from error
    finally:
        transport.close()


def load_sftp_private_key(value, passphrase):
    for key_type in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey, paramiko.DSSKey):
        try:
            return key_type.from_private_key(io.StringIO(value), password=passphrase)
        except paramiko.SSHException:
            continue
    raise BackupError("SFTP private key is invalid")


def ensure_sftp_dirs(client, path):
    current = "/" if path.is_absolute() else ""
    for part in path.parts:
        if part in {"", ".", "/"}:
            continue
        current = f"{current.rstrip('/')}/{part}" if current else part
        try:
            client.stat(current)
        except IOError:
            client.mkdir(current)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()


def quote_source_identifier(value):
    # The source name comes from the backup itself and may be any name the
    # source server accepted (for example `my-app`); quote it rather than
    # requiring a plain identifier.
    if not isinstance(value, str) or not value or len(value) > 255 or any(ord(character) < 32 or character in "`\\" for character in value):
        raise BackupError("database identifier is invalid")
    return "`" + value + "`"


def quote_identifier(value):
    if not isinstance(value, str) or not value or not value.replace("_", "a").isalnum(): raise BackupError("database identifier is invalid")
    return '"' + value.replace('"', '""') + '"'


def sanitize(value):
    lowered = value.lower()
    for marker in ("password=", "secret=", "token=", "privatekey="):
        index = lowered.find(marker)
        if index >= 0: return value[:index] + marker + "[redacted]"
    return value.replace("\n", " ")[:2048]


# ── Storage copy ────────────────────────────────────────────────────────────
# A fixed program: copy or sync the selected buckets from one S3 connection to
# another with rclone, then report `rclone check`. The daemon writes the
# config (credentials and endpoints resolved by Opfield) and reads
# /work/progress.json while it runs and /work/result.json at the end.

COPY_PROGRESS = WORK / "progress.json"
COPY_CONFIG_FIELDS = {"kind", "jobId", "version", "mode", "dryRun", "allBuckets", "buckets", "createBuckets", "source", "destination", "limits"}
COPY_ENDPOINT_FIELDS = {"connectionId", "endpoint", "region", "accessKeyId", "secretAccessKey", "sessionToken", "forcePathStyle", "caPem", "relayRouteId"}
COPY_LIMIT_FIELDS = {"timeoutSeconds", "cpuCores", "memoryMb", "transfers"}
COPY_BUCKET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$")
COPY_SAMPLE_KEYS = 20
COPY_MAX_BUCKETS = 500
COPY_KEY_LENGTH = 1024
COPY_STATS_SECONDS = 5


def storage_copy_main():
    state = {"phase": "validation", "report": None, "progress": None}
    try:
        config = load_copy_config()
    except Exception as error:
        copy_result({}, "failed", "validation", error=sanitize(str(error)))
        return 1
    try:
        report = storage_copy(config, state)
        failures = [bucket for bucket in report["buckets"] if bucket.get("error")]
        if failures:
            copy_result(config, "failed", "copy_failed", report=report, progress=state["progress"],
                        error=f"{len(failures)} bucket(s) failed; first: {failures[0]['name']}: {failures[0]['error']}")
            return 1
        copy_result(config, "completed", "completed", report=report, progress=state["progress"])
        return 0
    except Exception as error:
        copy_result(config, "failed", state["phase"], report=state["report"], progress=state["progress"], error=sanitize(str(error)))
        return 1


def load_copy_config():
    path = config_file()
    st = path.stat()
    if st.st_mode & 0o077:
        raise BackupError("storage copy config permissions are unsafe")
    config = json.loads(path.read_text())
    if not isinstance(config, dict) or set(config) != COPY_CONFIG_FIELDS:
        raise BackupError("storage copy config has missing or unrecognized fields")
    if config["kind"] != "storage_copy" or config["version"] != 1 or config["mode"] not in {"copy", "sync"}:
        raise BackupError("storage copy config kind, version or mode is invalid")
    if not isinstance(config["jobId"], str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", config["jobId"]):
        raise BackupError("storage copy job id is invalid")
    for flag in ("dryRun", "allBuckets", "createBuckets"):
        if not isinstance(config[flag], bool):
            raise BackupError(f"storage copy {flag} must be a boolean")
    buckets = config["buckets"]
    if not isinstance(buckets, list) or config["allBuckets"] == bool(buckets) or len(buckets) > 200:
        raise BackupError("select either all buckets or a list of buckets")
    for bucket in buckets:
        copy_bucket_name(bucket)
    if len(set(buckets)) != len(buckets):
        raise BackupError("bucket names must be unique")
    limits = config["limits"]
    if not isinstance(limits, dict) or set(limits) != COPY_LIMIT_FIELDS or not isinstance(limits["transfers"], int) or not 1 <= limits["transfers"] <= 32:
        raise BackupError("storage copy limits are invalid")
    for side in ("source", "destination"):
        endpoint = config[side]
        if not isinstance(endpoint, dict) or set(endpoint) - COPY_ENDPOINT_FIELDS or not endpoint.get("connectionId"):
            raise BackupError(f"storage copy {side} is invalid")
        parsed = urllib.parse.urlparse(endpoint.get("endpoint") or "")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or "@" in parsed.netloc:
            raise BackupError(f"storage copy {side} endpoint is invalid")
        for field in ("region", "accessKeyId", "secretAccessKey", "sessionToken"):
            value = endpoint.get(field, "")
            if not isinstance(value, str) or any(character in value for character in "\r\n"):
                raise BackupError(f"storage copy {side} {field} is invalid")
    if config["source"]["connectionId"] == config["destination"]["connectionId"]:
        raise BackupError("storage copy source and destination must differ")
    return config


def copy_bucket_name(value):
    if not isinstance(value, str) or not 3 <= len(value) <= 255 or ".." in value or not COPY_BUCKET.fullmatch(value):
        raise BackupError("storage copy bucket name is invalid")
    return value


def copy_result(config, status, phase, report=None, progress=None, error=None):
    payload = {"jobId": config.get("jobId", ""), "status": status, "phase": phase}
    if report is not None:
        payload["report"] = report
    if progress is not None:
        payload["progress"] = progress
    if error:
        payload["error"] = error
    write_work_json(RESULT, payload)


def write_work_json(path, payload):
    WORK.mkdir(mode=0o700, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, separators=(",", ":")))
    os.chmod(temp, 0o600)
    temp.replace(path)


def copy_remote_lines(name, endpoint, check_bucket=False):
    parsed = urllib.parse.urlparse(endpoint["endpoint"])
    lines = [f"[{name}]", "type = s3", "provider = Other", f"endpoint = {parsed.scheme}://{parsed.netloc}",
             f"access_key_id = {endpoint.get('accessKeyId', '')}", f"secret_access_key = {endpoint.get('secretAccessKey', '')}"]
    if endpoint.get("region"): lines.append(f"region = {endpoint['region']}")
    if endpoint.get("sessionToken"): lines.append(f"session_token = {endpoint['sessionToken']}")
    lines.append(f"force_path_style = {'true' if endpoint.get('forcePathStyle') else 'false'}")
    # Copies never create buckets implicitly; bucket creation is an explicit, permitted step.
    if not check_bucket: lines.append("no_check_bucket = true")
    return lines


def copy_rclone_setup(config):
    """Writes the rclone config (and CA bundle) once; returns the global arguments."""
    lines = copy_remote_lines("source", config["source"]) + [""] + copy_remote_lines("destination", config["destination"])
    if config["createBuckets"]:
        lines += [""] + copy_remote_lines("destination_create", config["destination"], check_bucket=True)
    conf = WORK / "rclone-copy.conf"
    conf.write_text("\n".join(lines) + "\n"); os.chmod(conf, 0o600)
    args = ["rclone", "--config", str(conf), "--cache-dir", str(WORK / "cache"), "--retries", "3", "--low-level-retries", "10"]
    authorities = [endpoint["caPem"] for endpoint in (config["source"], config["destination"]) if endpoint.get("caPem")]
    if authorities:
        # --ca-cert replaces the system roots, so an external endpoint keeps them in the same bundle.
        bundle = []
        try:
            bundle.append(pathlib.Path(SYSTEM_CA_BUNDLE).read_text())
        except OSError:
            pass
        bundle.extend(authorities)
        ca_path = WORK / "copy-ca.pem"
        ca_path.write_text("\n".join(part.strip() + "\n" for part in bundle)); os.chmod(ca_path, 0o600)
        args += ["--ca-cert", str(ca_path)]
    return args


def run_rclone(base, *args):
    completed = subprocess.run([*base, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False, env=copy_env())
    return completed.returncode, completed.stdout, completed.stderr


def copy_env():
    env = os.environ.copy()
    env["TMPDIR"] = "/tmp"
    return env


def rclone_error(stderr, fallback):
    for line in reversed((stderr or "").strip().splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            if isinstance(entry, dict) and entry.get("msg"):
                return sanitize(str(entry["msg"]).strip())[:512]
        except ValueError:
            return sanitize(line)[:512]
    return fallback


def list_bucket_names(base, remote):
    code, out, err = run_rclone(base, "lsjson", "--dirs-only", "--use-json-log", "--log-level", "ERROR", f"{remote}:")
    if code != 0:
        raise BackupError(f"could not list {remote} buckets: {rclone_error(err, 'listing failed')}")
    names = []
    for entry in json.loads(out or "[]"):
        name = entry.get("Name") or entry.get("Path")
        if entry.get("IsDir") and isinstance(name, str):
            names.append(name)
    return names


def rclone_metadata_supported(base):
    """rclone copies object metadata (content type, cache control, user metadata) with -M since 1.59."""
    code, out, _ = run_rclone(base[:1], "version")
    match = re.search(r"v(\d+)\.(\d+)", out or "") if code == 0 else None
    return bool(match) and (int(match.group(1)), int(match.group(2))) >= (1, 59)


def bucket_size(base, remote, bucket):
    code, out, err = run_rclone(base, "size", "--json", "--use-json-log", "--log-level", "ERROR", f"{remote}:{bucket}")
    if code != 0:
        raise BackupError(f"could not size {remote}:{bucket}: {rclone_error(err, 'size failed')}")
    value = json.loads(out)
    return {"objects": int(value.get("count", 0)), "bytes": int(value.get("bytes", 0))}


class CopyProgress:
    def __init__(self, state, buckets_total):
        self.state = state
        self.done = {"bytes": 0, "objects": 0, "checks": 0, "errors": 0}
        self.current = dict(self.done)
        self.buckets_total = buckets_total
        self.buckets_done = 0
        self.bucket = None
        self.extra = {}
        self.write("listing")

    def begin(self, bucket, phase):
        self.bucket = bucket
        self.current = {"bytes": 0, "objects": 0, "checks": 0, "errors": 0}
        self.extra = {}
        self.write(phase)

    def stats(self, stats):
        self.current = {
            "bytes": int(stats.get("bytes") or 0),
            "objects": int(stats.get("transfers") or 0),
            "checks": int(stats.get("checks") or 0),
            "errors": int(stats.get("errors") or 0),
        }
        self.extra = {"totalBytes": int(stats.get("totalBytes") or 0), "speedBytesPerSecond": int(stats.get("speed") or 0)}
        eta = stats.get("eta")
        self.extra["etaSeconds"] = int(eta) if isinstance(eta, (int, float)) else None
        self.write("copying")

    def finish_bucket(self):
        for key in self.done:
            self.done[key] += self.current[key]
        self.current = {"bytes": 0, "objects": 0, "checks": 0, "errors": 0}
        self.buckets_done += 1
        self.extra = {}

    def transferred(self):
        return {"objects": self.done["objects"] + self.current["objects"], "bytes": self.done["bytes"] + self.current["bytes"]}

    def write(self, phase):
        self.state["phase"] = phase
        progress = {"phase": phase, "bucketsDone": self.buckets_done, "bucketsTotal": self.buckets_total}
        if self.bucket:
            progress["bucket"] = self.bucket
        for key in self.done:
            progress[key] = self.done[key] + self.current[key]
        progress.update(self.extra)
        progress["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.state["progress"] = progress
        try:
            write_work_json(COPY_PROGRESS, progress)
        except OSError:
            pass


def parse_rclone_log_line(line):
    """Returns (stats, error message) from one rclone --use-json-log line."""
    try:
        entry = json.loads(line)
    except ValueError:
        return None, None
    if not isinstance(entry, dict):
        return None, None
    stats = entry.get("stats") if isinstance(entry.get("stats"), dict) else None
    error = str(entry.get("msg", "")).strip() if entry.get("level") in {"error", "critical"} else None
    return stats, error


def copy_bucket(base, config, bucket, progress, metadata):
    transfers = config["limits"]["transfers"]
    args = [*base, config["mode"], f"source:{bucket}", f"destination:{bucket}", "--transfers", str(transfers),
            "--checkers", str(max(8, transfers * 2)), "--use-json-log", "--log-level", "NOTICE",
            "--stats", f"{COPY_STATS_SECONDS}s", "--stats-log-level", "NOTICE"]
    if metadata:
        args.append("--metadata")
    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=copy_env())
    last_error = None
    for line in process.stderr:
        stats, error = parse_rclone_log_line(line)
        if stats is not None:
            progress.stats(stats)
        if error:
            last_error = error
    code = process.wait()
    if code != 0:
        return sanitize(last_error or f"rclone {config['mode']} exited with status {code}")[:512]
    return None


def check_bucket(base, config, bucket):
    """rclone check with a combined listing: counts per outcome and bounded key samples."""
    args = [*base, "check", f"source:{bucket}", f"destination:{bucket}", "--combined", "-", "--use-json-log",
            "--log-level", "ERROR", "--checkers", str(max(8, config["limits"]["transfers"] * 2))]
    if config["mode"] == "copy":
        # Copy never deletes, so objects that exist only on the destination are expected.
        args.append("--one-way")
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=copy_env())
    # rclone logs every difference to stderr as well; drain it concurrently (keeping only the tail)
    # so a full pipe never stalls the listing on stdout.
    tail = deque(maxlen=20)
    drain = threading.Thread(target=lambda: tail.extend(process.stderr), daemon=True)
    drain.start()
    # --combined markers: "=" identical, "+" only on the source (missing on the destination),
    # "-" only on the destination, "*" different, "!" error.
    counts = {"=": 0, "-": 0, "+": 0, "*": 0, "!": 0}
    samples = {"-": [], "+": [], "*": []}
    for line in process.stdout:
        line = line.rstrip("\n")
        if len(line) < 3 or line[1] != " " or line[0] not in counts:
            continue
        marker, key = line[0], line[2:]
        counts[marker] += 1
        if marker in samples and len(samples[marker]) < COPY_SAMPLE_KEYS:
            samples[marker].append(key[:COPY_KEY_LENGTH])
    code = process.wait()
    drain.join(timeout=10)
    stderr = "".join(tail)
    # Exit status 1 only means differences were found.
    if code not in (0, 1) or (code == 1 and not any(counts[marker] for marker in "-+*!")):
        raise BackupError(f"rclone check failed for {bucket}: {rclone_error(stderr, 'check failed')}")
    return {
        "matched": counts["="],
        "missing": counts["+"],
        "differing": counts["*"],
        "extra": None if config["mode"] == "copy" else counts["-"],
        "errors": counts["!"],
        "missingKeys": samples["+"],
        "differingKeys": samples["*"],
        "extraKeys": samples["-"] if config["mode"] == "sync" else [],
    }


def empty_bucket_report(bucket):
    return {"name": bucket, "created": False, "source": None, "destination": None, "matched": 0, "missing": 0,
            "differing": 0, "extra": None, "errors": 0, "missingKeys": [], "differingKeys": [], "extraKeys": []}


def storage_copy(config, state):
    base = copy_rclone_setup(config)
    state["phase"] = "listing"
    source_buckets = list_bucket_names(base, "source")
    buckets = source_buckets if config["allBuckets"] else config["buckets"]
    buckets = [copy_bucket_name(bucket) for bucket in buckets]
    if not config["allBuckets"]:
        missing_on_source = [bucket for bucket in buckets if bucket not in source_buckets]
        if missing_on_source:
            raise BackupError(f"source bucket(s) not found: {', '.join(missing_on_source[:10])}")
    try:
        destination_buckets = set(list_bucket_names(base, "destination"))
    except BackupError:
        # A bucket-scoped destination key may not list buckets; copying will tell.
        destination_buckets = None
    metadata = not config["dryRun"] and rclone_metadata_supported(base)
    progress = CopyProgress(state, len(buckets))
    report = {"mode": config["mode"], "dryRun": config["dryRun"], "clean": False, "buckets": [], "totals": {},
              "transferred": {"objects": 0, "bytes": 0}}
    state["report"] = report
    entries = []
    for bucket in buckets:
        entry = empty_bucket_report(bucket)
        entries.append(entry)
        # The report lists a bounded number of buckets; totals cover all of them.
        if len(report["buckets"]) < COPY_MAX_BUCKETS:
            report["buckets"].append(entry)
        else:
            report["truncated"] = True
        exists = None if destination_buckets is None else bucket in destination_buckets
        try:
            if config["dryRun"]:
                progress.begin(bucket, "checking")
                entry["source"] = bucket_size(base, "source", bucket)
                if exists is False:
                    entry["missingOnDestination"] = True
                    entry["missing"] = entry["source"]["objects"]
                    entry["destination"] = {"objects": 0, "bytes": 0}
                    progress.finish_bucket()
                    continue
            else:
                if exists is not True:
                    if config["createBuckets"]:
                        code, _, err = run_rclone(base, "mkdir", "--use-json-log", "--log-level", "ERROR", f"destination_create:{bucket}")
                        if code != 0:
                            raise BackupError(f"could not create destination bucket: {rclone_error(err, 'mkdir failed')}")
                        entry["created"] = exists is False
                    elif exists is False:
                        raise BackupError("destination bucket does not exist; creating it needs storage:objects:admin on the destination")
                progress.begin(bucket, "copying")
                error = copy_bucket(base, config, bucket, progress, metadata)
                if error:
                    raise BackupError(error)
                state["phase"] = "checking"
                progress.write("checking")
                entry["source"] = bucket_size(base, "source", bucket)
            entry.update(check_bucket(base, config, bucket))
            entry["destination"] = bucket_size(base, "destination", bucket)
        except BackupError as error:
            entry["error"] = sanitize(str(error))[:1024]
        progress.finish_bucket()
    progress.write("completed")
    report["transferred"] = progress.transferred()
    totals = {"buckets": len(buckets), "sourceObjects": 0, "sourceBytes": 0, "destinationObjects": 0, "destinationBytes": 0,
              "missing": 0, "differing": 0, "extra": 0, "errors": 0}
    for entry in entries:
        for side, prefix in (("source", "source"), ("destination", "destination")):
            if entry[side]:
                totals[prefix + "Objects"] += entry[side]["objects"]
                totals[prefix + "Bytes"] += entry[side]["bytes"]
        totals["missing"] += entry["missing"]
        totals["differing"] += entry["differing"]
        totals["extra"] += entry["extra"] or 0
        totals["errors"] += entry["errors"] + (1 if entry.get("error") else 0)
    report["totals"] = totals
    report["clean"] = (totals["missing"] == 0 and totals["differing"] == 0 and totals["errors"] == 0
                       and (config["mode"] == "copy" or totals["extra"] == 0))
    state["phase"] = "completed"
    return report


if __name__ == "__main__":
    sys.exit(main())
