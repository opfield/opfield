import importlib.util
import hashlib
import base64
import io
from unittest.mock import Mock, patch
import pathlib
import tempfile
import unittest


RUNNER = pathlib.Path(__file__).with_name("opfield-backup-runner.py")
SPEC = importlib.util.spec_from_file_location("opfield_backup_runner", RUNNER)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(runner)


class FileProtocolKeyTests(unittest.TestCase):
    def test_redis_restore_rejects_keys_in_any_logical_database(self):
        target = {"host": "redis.example.test", "port": 6379}
        with patch.object(runner, "redis_command", return_value="# Keyspace\ndb0:keys=0,expires=0,avg_ttl=0\ndb3:keys=1,expires=0,avg_ttl=0\n"):
            with self.assertRaises(runner.BackupError):
                runner.assert_empty_target("redis", target)

    def test_redis_restore_accepts_an_empty_instance(self):
        target = {"host": "redis.example.test", "port": 6379}
        with patch.object(runner, "redis_command", return_value="# Keyspace\n"):
            runner.assert_empty_target("redis", target)

    def test_redis_restore_rejects_unverified_or_malformed_keyspace(self):
        target = {"host": "redis.example.test", "port": 6379}
        for response in ("NOPERM this user has no permissions to run the 'info' command", "# Keyspace\ndb1:keys=-1,expires=0,avg_ttl=0\n", "# Keyspace\ndb1:keys=oops,expires=0,avg_ttl=0\n"):
            with self.subTest(response=response), patch.object(runner, "redis_command", return_value=response):
                with self.assertRaises(runner.BackupError):
                    runner.assert_empty_target("redis", target)

    def test_clickhouse_restore_downloads_each_artifact_once(self):
        original_work = runner.WORK
        with tempfile.TemporaryDirectory() as directory:
            runner.WORK = pathlib.Path(directory)
            config = {
                "runId": "run-1",
                "engine": "clickhouse",
                "limits": {"timeoutSeconds": 7200},
                "destination": {"provider": "s3", "endpoint": "https://destination.example.test", "bucket": "backups", "prefix": "nightly"},
                "staging": {"provider": "s3", "endpoint": "https://stage.example.test", "bucket": "stage", "prefix": "native", "accessKeyId": "key", "secretAccessKey": "secret"},
                "restoreTarget": {"database": "target"},
            }
            contents = {"nightly/run-1/a": b"a", "nightly/run-1/b": b"b"}
            manifest = {
                "artifactKeys": list(contents),
                "fileChecksums": {key: hashlib.sha256(value).hexdigest() for key, value in contents.items()},
                "ownedPrefix": "nightly/run-1",
                "nativeStagePrefix": "native/run-1",
                "sourceDatabase": "source",
            }

            def download(_, key, local):
                local.write_bytes(contents[key])

            with patch.object(runner, "download", side_effect=download) as downloaded, patch.object(runner, "upload"), patch.object(runner, "delete_prefix"), patch.object(runner, "clickhouse_query") as queried, patch.object(runner, "assert_empty_target"):
                runner.restore({**config, "restoreArtifact": manifest})
            self.assertEqual(downloaded.call_count, len(contents))
            # RESTORE is bounded by the run's limit, not the short default used for probes.
            self.assertEqual(queried.call_args.kwargs["timeout"], 7200)
        runner.WORK = original_work

    def test_manifest_key_never_contains_base_path_or_bucket(self):
        endpoint = {"provider": "sftp", "bucket": "archives", "basePath": "/opfield/backups"}
        logical = runner.remote_key(endpoint, "owned/run-1/database.dump")
        self.assertEqual(logical, "owned/run-1/database.dump")
        self.assertEqual(
            runner.file_protocol_path(endpoint, logical),
            "/opfield/backups/archives/owned/run-1/database.dump",
        )

    def test_sftp_hashes_the_host_key_and_preserves_absolute_base_path(self):
        key = b"verified-server-host-key"
        pin = "SHA256:" + base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip("=")
        transport = Mock()
        transport.get_remote_server_key.return_value.asbytes.return_value = key
        client = Mock()
        with patch.object(runner.paramiko, "Transport", return_value=transport), patch.object(runner.paramiko.SFTPClient, "from_transport", return_value=client):
            runner.sftp_transfer({"host": "server", "port": 22, "hostKeyFingerprint": pin, "username": "user", "password": "secret"}, pathlib.Path("local"), "/upload/bucket/key", False)
            client.get.assert_called_once_with("/upload/bucket/key", "local")
            transport.auth_password.assert_called_once_with("user", "secret")
            transport.reset_mock()
            with self.assertRaises(runner.BackupError):
                runner.sftp_transfer({"host": "server", "port": 22, "hostKeyFingerprint": "SHA256:wrong", "username": "user", "password": "secret"}, pathlib.Path("local"), "/upload/bucket/key", False)
            transport.auth_password.assert_not_called()

    def test_control_characters_are_rejected_before_any_transport_call(self):
        with self.assertRaises(runner.BackupError):
            runner.remote_key({"provider": "sftp"}, "owned/run\n!shell")

    def test_rclone_uses_private_ca_and_session_token_without_disabling_tls(self):
        original_work = runner.WORK
        with tempfile.TemporaryDirectory() as directory:
            runner.WORK = pathlib.Path(directory)
            endpoint = {
                "provider": "s3",
                "endpoint": "https://127.0.0.1:9000",
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "sessionToken": "session-token",
                "caPem": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
            }
            command = runner.rclone_args(endpoint, "lsjson", "target:bucket/prefix")
            self.assertIn("--ca-cert", command)
            self.assertNotIn("--no-check-certificate", command)
            config = (runner.WORK / "rclone.conf").read_text()
            self.assertIn("session_token = session-token", config)
            self.assertEqual((runner.WORK / "s3-ca.pem").stat().st_mode & 0o777, 0o600)
        runner.WORK = original_work

    def test_clickhouse_uses_native_endpoint_while_rclone_keeps_executor_endpoint(self):
        endpoint = {
            "endpoint": "https://127.0.0.1:9000",
            "nativeEndpoint": "https://storage-reachable.example.test",
            "bucket": "stage",
            "prefix": "native",
            "accessKeyId": "key",
            "secretAccessKey": "secret",
        }
        statement = runner.clickhouse_s3(endpoint, "run-1")
        self.assertIn("storage-reachable.example.test", statement)
        self.assertNotIn("127.0.0.1", statement)

    def test_clickhouse_preflight_probes_native_staging_without_backing_the_database_up(self):
        original_work = runner.WORK
        stage = {"provider": "s3", "endpoint": "https://stage.example.test", "bucket": "stage", "prefix": "native", "accessKeyId": "key", "secretAccessKey": "secret"}
        config = {"runId": "run-1", "engine": "clickhouse", "direction": "backup", "source": {"host": "ch.example.test", "port": 8123, "database": "app"}, "destination": stage}
        with tempfile.TemporaryDirectory() as directory:
            runner.WORK = pathlib.Path(directory)

            def download(_, __, local):
                local.write_bytes(b"opfield-backup-probe")

            with patch.object(runner, "clickhouse_query") as queried, patch.object(runner, "list_objects", return_value=["native/probe/run-1/probe.csv"]), patch.object(runner, "delete_prefix") as deleted, patch.object(runner, "upload"), patch.object(runner, "download", side_effect=download), patch.object(runner, "delete_object"):
                runner.preflight(config)
        runner.WORK = original_work
        statements = [call.args[1] for call in queried.call_args_list]
        self.assertFalse(any(statement.startswith("BACKUP") for statement in statements))
        probe = next(statement for statement in statements if statement.startswith("INSERT INTO FUNCTION s3("))
        self.assertIn("'https://stage.example.test/stage/native/probe/run-1/probe.csv'", probe)
        self.assertTrue(probe.endswith("'CSV', 'probe UInt8') SELECT 1"))
        deleted.assert_called_once_with(stage, "native/probe/run-1")

    def test_postgres_tools_follow_the_server_major_and_fall_back_to_the_image_default(self):
        original_tools = runner.POSTGRES_TOOLS
        with tempfile.TemporaryDirectory() as directory:
            runner.POSTGRES_TOOLS = pathlib.Path(directory)
            binary = pathlib.Path(directory) / "16" / "bin" / "pg_restore"
            binary.parent.mkdir(parents=True); binary.write_text("")
            (binary.parent / "pg_dump").write_text("")
            self.assertEqual(runner.postgres_tool("pg_dump", 16), str(binary.parent / "pg_dump"))
            self.assertEqual(runner.postgres_tool("pg_dump", 18), "pg_dump")
            target = {"host": "pg.example.test", "port": 5432, "database": "app"}
            with patch.object(runner, "postgres_major", return_value=16), patch.object(runner, "run") as ran:
                self.assertEqual(runner.postgres_restore_tool(target, pathlib.Path("database.dump")), str(binary))
                ran.assert_called_once_with([str(binary), "--list", "database.dump"])
            # An archive from a newer pg_dump is unreadable for the older client.
            with patch.object(runner, "postgres_major", return_value=16), patch.object(runner, "run", side_effect=runner.BackupError("native command failed")):
                self.assertEqual(runner.postgres_restore_tool(target, pathlib.Path("database.dump")), "pg_restore")
        runner.POSTGRES_TOOLS = original_tools


class RestoreHardeningTests(unittest.TestCase):
    def test_managed_postgres_restore_hands_objects_to_the_database_owner(self):
        original_work = runner.WORK
        with tempfile.TemporaryDirectory() as directory:
            runner.WORK = pathlib.Path(directory)
            payload = b"dump"
            config = {
                "runId": "run-1",
                "engine": "postgres",
                "limits": {"timeoutSeconds": 3600},
                "destination": {"provider": "s3"},
                "restoreTarget": {"host": "127.0.0.1", "port": 5432, "database": "app", "username": "gw_admin_x", "password": "pw", "managedDatabaseId": "m-1"},
                "restoreArtifact": {"artifactKeys": ["owned/run-1/database.dump"], "fileChecksums": {"owned/run-1/database.dump": hashlib.sha256(payload).hexdigest()}},
            }

            def download(_, __, local):
                local.write_bytes(payload)

            with patch.object(runner, "download", side_effect=download), patch.object(runner, "assert_empty_target"), patch.object(runner, "postgres_restore_tool", return_value="pg_restore"), patch.object(runner, "run") as ran:
                runner.restore(config)
            statements = [call.args[2] for call in ran.call_args_list if len(call.args) > 2 and call.args[2]]
            self.assertTrue(any("REASSIGN OWNED BY" in statement for statement in statements))
            # External targets keep the restoring account as owner.
            ran.reset_mock()
            config["restoreTarget"].pop("managedDatabaseId")
            with patch.object(runner, "download", side_effect=download), patch.object(runner, "assert_empty_target"), patch.object(runner, "postgres_restore_tool", return_value="pg_restore"), patch.object(runner, "run") as ran:
                runner.restore(config)
            self.assertFalse(any(len(call.args) > 2 and call.args[2] for call in ran.call_args_list))
        runner.WORK = original_work

    def test_clickhouse_restore_quotes_a_non_identifier_source_database(self):
        self.assertEqual(runner.quote_source_identifier("my-app"), "`my-app`")
        for value in ("", "a`b", "a\\b", "a\nb"):
            with self.subTest(value=value), self.assertRaises(runner.BackupError):
                runner.quote_source_identifier(value)

    def test_waits_follow_the_remaining_run_time(self):
        config = {"limits": {"timeoutSeconds": 7200}}
        with patch.object(runner, "STARTED_AT", 1000.0), patch.object(runner.time, "time", return_value=1000.0):
            self.assertEqual(runner.remaining_seconds(config), 7200 - runner.DEADLINE_RESERVE_SECONDS)
            # A control-plane deadline earlier than the local timeout wins.
            config["deadlineAt"] = "1970-01-01T00:26:40Z"  # epoch 1600
            self.assertEqual(runner.remaining_seconds(config), 600 - runner.DEADLINE_RESERVE_SECONDS)
        with patch.object(runner, "STARTED_AT", 1000.0), patch.object(runner.time, "time", return_value=99999.0):
            self.assertEqual(runner.remaining_seconds({"limits": {"timeoutSeconds": 60}}), 1)

    def test_masterauth_is_passed_on_stdin_not_in_arguments(self):
        target = {"host": "redis.example.test", "port": 6379, "password": "owner-secret"}
        with patch.object(runner, "run", return_value="OK") as ran:
            runner.redis_command_secret_last(target, ["CONFIG", "SET", "masterauth"], "stage-secret")
        args, env, stdin = ran.call_args.args
        self.assertIn("-x", args)
        self.assertNotIn("stage-secret", args)
        self.assertNotIn("owner-secret", args)
        self.assertEqual(stdin, "stage-secret")
        self.assertEqual(env["REDISCLI_AUTH"], "owner-secret")


class FakeRedis:
    """Answers redis_command for a restore target and a staged Redis by host."""

    def __init__(self, stage_full_syncs=1, link_up=False, fail=()):
        self.calls = []
        self.secrets = []
        self.stage_full_syncs = stage_full_syncs
        self.link_up = link_up
        self.fail = set(fail)

    def command(self, endpoint, command, last_argument=None):
        name = " ".join(command)
        self.calls.append((endpoint["host"], name))
        if last_argument is not None:
            self.secrets.append((name, last_argument))
        if name in self.fail:
            raise runner.BackupError(f"redis-cli failed: {name} refused")
        if endpoint["host"] == "stage":
            if name == "INFO stats":
                return f"# Stats\r\nsync_full:{self.stage_full_syncs}\r\n"
            if name == "INFO server":
                return "# Server\r\nredis_version:8.10.0\r\n"
            return "PONG"
        if name == "CONFIG GET masterauth":
            return "masterauth\nprevious-secret\n"
        if name == "INFO replication":
            return "role:slave\r\nmaster_link_status:up\r\nmaster_sync_in_progress:0\r\n" if self.link_up else "role:slave\r\nmaster_link_status:down\r\nmaster_sync_in_progress:0\r\n"
        if name == "INFO server":
            return "# Server\r\nredis_version:8.2.10\r\n"
        return "OK"


class RedisRestoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_work = runner.WORK
        runner.WORK = pathlib.Path(self.directory.name)
        self.artifact = runner.WORK / "database.rdb"
        self.artifact.write_bytes(b"REDIS0012")
        self.config = {
            "limits": {"timeoutSeconds": 3600},
            "restoreTarget": {"host": "target", "port": 6379},
            "redisStaging": {"host": "stage", "port": 21345, "password": "stage-secret"},
        }

    def tearDown(self):
        runner.WORK = self.original_work
        self.directory.cleanup()

    def restore(self, fake):
        with patch.object(runner, "redis_command", side_effect=fake.command), patch.object(runner.time, "sleep"), patch.object(runner.signal, "pthread_sigmask"):
            runner.restore_redis(self.config, self.artifact)

    def assert_detached(self, fake):
        target_calls = [name for host, name in fake.calls if host == "target"]
        self.assertIn("REPLICAOF NO ONE", target_calls)
        self.assertEqual(target_calls[-1], "SAVE")
        self.assertEqual(fake.secrets[-1], ("CONFIG SET masterauth", "previous-secret"))

    def test_a_target_that_cannot_load_the_copy_fails_fast_and_is_detached(self):
        fake = FakeRedis(stage_full_syncs=runner.REDIS_FULL_SYNC_ATTEMPTS)
        with self.assertRaises(runner.BackupError) as raised:
            self.restore(fake)
        self.assertIn("Redis 8.2.10", str(raised.exception))
        self.assertIn("Redis 8.10.0 or newer", str(raised.exception))
        self.assert_detached(fake)

    def test_a_stop_request_while_replicating_detaches_the_target(self):
        fake = FakeRedis()
        original = fake.command

        def stopped(endpoint, command, last_argument=None):
            if endpoint["host"] == "target" and command == ["INFO", "replication"]:
                runner.stop_requested(None, None)
            return original(endpoint, command, last_argument)

        fake.command = stopped
        with patch.object(runner.signal, "signal"), self.assertRaises(runner.BackupError) as raised:
            self.restore(fake)
        self.assertIn("stopped", str(raised.exception))
        self.assert_detached(fake)

    def test_masterauth_is_restored_even_when_replication_could_not_start(self):
        fake = FakeRedis(fail={"REPLICAOF stage 21345", "REPLICAOF NO ONE"})
        with self.assertRaises(runner.BackupError) as raised:
            self.restore(fake)
        self.assertIn("REPLICAOF NO ONE", str(raised.exception))
        self.assertEqual(fake.secrets[-1], ("CONFIG SET masterauth", "previous-secret"))
        self.assertEqual([name for host, name in fake.calls if host == "target"][-1], "SAVE")

    def test_a_completed_copy_is_detached_and_saved(self):
        fake = FakeRedis(link_up=True)
        self.restore(fake)
        self.assert_detached(fake)

    def test_a_backup_of_another_engine_is_refused_before_the_target_changes(self):
        fake = FakeRedis(link_up=True)
        original = fake.command

        def valkey_target(endpoint, command, last_argument=None):
            if endpoint["host"] == "target" and command == ["INFO", "server"]:
                return "# Server\r\nredis_version:7.2.4\r\nvalkey_version:9.1.2\r\n"
            return original(endpoint, command, last_argument)

        fake.command = valkey_target
        with self.assertRaises(runner.BackupError) as raised:
            self.restore(fake)
        self.assertIn("taken from Redis 8.10.0", str(raised.exception))
        self.assertIn("runs Valkey 9.1.2", str(raised.exception))
        target_calls = [name for host, name in fake.calls if host == "target"]
        self.assertNotIn("REPLICAOF stage 21345", target_calls)
        self.assertEqual(fake.secrets, [])

    def test_a_valkey_backup_records_its_engine(self):
        with patch.object(runner, "redis_command", return_value="# Server\r\nredis_version:7.2.4\r\nvalkey_version:9.1.2\r\n"):
            self.assertEqual(runner.redis_version({"host": "kv", "port": 6379}), "valkey 9.1.2")
        with patch.object(runner, "redis_command", return_value="# Server\r\nredis_version:8.10.0\r\n"):
            self.assertEqual(runner.redis_version({"host": "kv", "port": 6379}), "8.10.0")

    def test_a_target_that_never_connects_fails_instead_of_waiting_for_the_deadline(self):
        fake = FakeRedis(stage_full_syncs=0)
        clock = iter(range(0, 10_000, 30))
        with patch.object(runner.time, "time", side_effect=lambda: float(next(clock))), self.assertRaises(runner.BackupError) as raised:
            self.restore(fake)
        self.assertIn("did not connect to the staged Redis at stage:21345", str(raised.exception))
        self.assert_detached(fake)


class RunnerDiagnosticsTests(unittest.TestCase):
    def test_a_failed_tool_reports_what_it_printed(self):
        completed = Mock(returncode=1, stdout="", stderr="Entering replica output mode...\nNOPERM User app has no permissions to run the 'sync' command\n")
        with patch.object(runner.subprocess, "run", return_value=completed), self.assertRaises(runner.BackupError) as raised:
            runner.run(["/usr/bin/redis-cli", "--rdb", "/work/database.rdb"])
        self.assertIn("redis-cli failed:", str(raised.exception))
        self.assertIn("NOPERM", str(raised.exception))

    def test_a_redis_user_without_replication_access_fails_preflight(self):
        source = {"host": "redis.example.test", "port": 6379, "username": "app"}
        for reply in ("NOPERM User app has no permissions to run the 'replconf' command", runner.BackupError("redis-cli failed: NOPERM User app has no permissions to run the 'replconf' command")):
            effect = reply if isinstance(reply, Exception) else None
            with self.subTest(reply=str(reply)), patch.object(runner, "redis_command", return_value=reply, side_effect=effect):
                with self.assertRaises(runner.BackupError) as raised:
                    runner.assert_redis_replication_access(source)
                self.assertIn("+replconf +sync", str(raised.exception))
        with patch.object(runner, "redis_command", return_value="OK"):
            runner.assert_redis_replication_access(source)


class PreflightProbeFailureTests(unittest.TestCase):
    """The preflight reports the probe step that failed, not the cleanup of the probe it never wrote (stand rc.6, O-2)."""

    FULL = "rclone failed: Failed to copyto: InternalError: No writable volumes status code: 500"
    GONE = "rclone failed: Failed to deletefile: target:scn-rc6-probe/run-1/.probe is a directory or doesn't exist"

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_work = runner.WORK
        runner.WORK = pathlib.Path(self.directory.name)
        self.destination = {"provider": "s3", "endpoint": "https://storage.example.test", "bucket": "scn-rc6-probe"}
        self.config = {"runId": "run-1", "engine": "postgres", "direction": "backup", "source": {"host": "db.example.test", "port": 5432, "database": "app"}, "destination": self.destination}

    def tearDown(self):
        runner.WORK = self.original_work
        self.directory.cleanup()

    def test_a_full_storage_is_reported_instead_of_the_missing_probe(self):
        with patch.object(runner, "run", return_value="1"), patch.object(runner, "upload", side_effect=runner.BackupError(self.FULL)), patch.object(runner, "download") as downloaded, patch.object(runner, "delete_object", side_effect=runner.BackupError(self.GONE)) as deleted:
            with self.assertRaises(runner.BackupError) as raised:
                runner.preflight(self.config)
        self.assertEqual(str(raised.exception), f"writing a test file to the backup storage failed: {self.FULL}")
        downloaded.assert_not_called()
        deleted.assert_called_once_with(self.destination, "run-1/.probe")

    def test_a_probe_that_cannot_be_read_back_names_the_read(self):
        with patch.object(runner, "run", return_value="1"), patch.object(runner, "upload"), patch.object(runner, "download", side_effect=runner.BackupError("rclone failed: AccessDenied")), patch.object(runner, "delete_object") as deleted:
            with self.assertRaises(runner.BackupError) as raised:
                runner.preflight(self.config)
        self.assertEqual(str(raised.exception), "reading the test file back from the backup storage failed: rclone failed: AccessDenied")
        deleted.assert_called_once()

    def test_a_probe_that_cannot_be_removed_after_it_passed_still_fails(self):
        def download(_, __, local):
            local.write_bytes(b"opfield-backup-probe")

        with patch.object(runner, "run", return_value="1"), patch.object(runner, "upload"), patch.object(runner, "download", side_effect=download), patch.object(runner, "delete_object", side_effect=runner.BackupError("rclone failed: AccessDenied")):
            with self.assertRaises(runner.BackupError) as raised:
                runner.preflight(self.config)
        self.assertEqual(str(raised.exception), "rclone failed: AccessDenied")

    def test_a_full_clickhouse_staging_is_reported_instead_of_its_cleanup(self):
        config = {**self.config, "engine": "clickhouse", "source": {"host": "ch.example.test", "port": 8123, "database": "app"}, "destination": {**self.destination, "accessKeyId": "key", "secretAccessKey": "secret"}}

        def query(_, statement, **__):
            if statement.startswith("INSERT"):
                raise runner.BackupError("clickhouse native command failed: No writable volumes")
            return "1"

        with patch.object(runner, "clickhouse_query", side_effect=query), patch.object(runner, "delete_prefix", side_effect=runner.BackupError("rclone failed: directory not found")) as deleted, patch.object(runner, "upload") as uploaded:
            with self.assertRaises(runner.BackupError) as raised:
                runner.preflight(config)
        self.assertEqual(str(raised.exception), "clickhouse native command failed: No writable volumes")
        deleted.assert_called_once_with(config["destination"], "database-backups/probe/run-1")
        uploaded.assert_not_called()


CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"


class DatabaseTlsVerificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_work = runner.WORK
        runner.WORK = pathlib.Path(self.directory.name)

    def tearDown(self):
        runner.WORK = self.original_work
        self.directory.cleanup()

    def redis_args(self, endpoint):
        with patch.object(runner, "run", return_value="PONG") as ran:
            runner.redis_command(endpoint, ["PING"])
        return ran.call_args.args[0]

    def test_postgres_verifies_the_hostname_against_the_public_bundle_by_default(self):
        env = runner.postgres_env({"host": "db.example.test", "database": "app", "tls": True, "tlsVerifyCertificate": True})
        self.assertEqual(env["PGSSLMODE"], "verify-full")
        self.assertEqual(env["PGSSLROOTCERT"], runner.SYSTEM_CA_BUNDLE)

    def test_postgres_verifies_against_a_custom_ca(self):
        env = runner.postgres_env({"host": "db.example.test", "database": "app", "tls": True, "tlsVerifyCertificate": True, "caPem": CA_PEM})
        self.assertEqual(env["PGSSLMODE"], "verify-full")
        self.assertEqual(pathlib.Path(env["PGSSLROOTCERT"]).read_text(), CA_PEM)

    def test_postgres_opt_out_encrypts_without_verification(self):
        env = runner.postgres_env({"host": "db.example.test", "database": "app", "tls": True, "tlsVerifyCertificate": False, "caPem": CA_PEM})
        self.assertEqual(env["PGSSLMODE"], "require")
        self.assertNotIn("PGSSLROOTCERT", env)

    def test_postgres_without_the_setting_keeps_the_relay_behavior(self):
        self.assertEqual(runner.postgres_env({"host": "127.0.0.1", "database": "app", "tls": True})["PGSSLMODE"], "require")
        self.assertEqual(runner.postgres_env({"host": "127.0.0.1", "database": "app", "tls": True, "caPem": CA_PEM})["PGSSLMODE"], "verify-ca")

    def test_postgres_database_travels_in_the_environment_and_never_as_a_connection_string(self):
        endpoint = {"host": "db.example.test", "port": 5432, "database": "app", "tls": True, "tlsVerifyCertificate": True}
        self.assertEqual(runner.postgres_env(endpoint)["PGDATABASE"], "app")
        for name in ("dbname=app host=attacker.example sslmode=disable", "postgresql://attacker.example/app", "POSTGRES://attacker.example/app", "", "app\nx", None):
            with self.assertRaises(runner.BackupError):
                runner.postgres_env({**endpoint, "database": name})
        with patch.object(runner, "run", return_value="1") as ran:
            runner.postgres_major(endpoint)
        args, env = ran.call_args.args[0], ran.call_args.args[1]
        self.assertNotIn("-d", args)
        self.assertNotIn("app", args)
        self.assertEqual(env["PGDATABASE"], "app")

    def test_redis_verifies_with_sni_and_custom_ca(self):
        args = self.redis_args({"host": "redis.example.test", "port": 6380, "tls": True, "tlsVerifyCertificate": True, "caPem": CA_PEM})
        self.assertIn("--tls", args)
        self.assertNotIn("--insecure", args)
        self.assertEqual(args[args.index("--sni") + 1], "redis.example.test")
        self.assertEqual(pathlib.Path(args[args.index("--cacert") + 1]).read_text(), CA_PEM)

    def test_redis_opt_out_skips_verification(self):
        args = self.redis_args({"host": "10.0.0.5", "port": 6380, "tls": True, "tlsVerifyCertificate": False, "caPem": CA_PEM})
        self.assertIn("--insecure", args)
        self.assertNotIn("--cacert", args)
        self.assertNotIn("--sni", args)

    def test_clickhouse_opt_out_disables_verification_only_when_explicit(self):
        insecure = runner.clickhouse_ssl_context({"tls": True, "tlsVerifyCertificate": False})
        self.assertFalse(insecure.check_hostname)
        self.assertEqual(insecure.verify_mode, runner.ssl.CERT_NONE)
        for endpoint in ({"tls": True, "tlsVerifyCertificate": True}, {"tls": True}):
            with self.subTest(endpoint=endpoint):
                context = runner.clickhouse_ssl_context(endpoint)
                self.assertTrue(context.check_hostname)
                self.assertEqual(context.verify_mode, runner.ssl.CERT_REQUIRED)


COPY_JOB_ID = "22222222-2222-4222-8222-222222222222"


def copy_config(**overrides):
    config = {
        "kind": "storage_copy",
        "jobId": COPY_JOB_ID,
        "version": 1,
        "mode": "copy",
        "dryRun": False,
        "allBuckets": False,
        "buckets": ["assets"],
        "createBuckets": True,
        "source": {"connectionId": "minio", "endpoint": "https://127.0.0.1:41001", "region": "us-east-1", "accessKeyId": "root", "secretAccessKey": "source-secret", "forcePathStyle": True, "caPem": CA_PEM, "relayRouteId": COPY_JOB_ID},
        "destination": {"connectionId": "seaweedfs", "endpoint": "https://127.0.0.1:41002", "accessKeyId": "root", "secretAccessKey": "destination-secret", "forcePathStyle": True},
        "limits": {"timeoutSeconds": 3600, "cpuCores": 1, "memoryMb": 1024, "transfers": 4},
    }
    config.update(overrides)
    return config


class FakeProcess:
    def __init__(self, stdout="", stderr="", code=0):
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.code = code

    def wait(self):
        return self.code


class StorageCopyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original = (runner.WORK, runner.RESULT, runner.COPY_PROGRESS, runner.CONFIG, runner.LEGACY_CONFIG, runner.SYSTEM_CA_BUNDLE)
        work = pathlib.Path(self.directory.name) / "work"
        work.mkdir()
        runner.WORK, runner.RESULT, runner.COPY_PROGRESS = work, work / "result.json", work / "progress.json"
        runner.CONFIG = pathlib.Path(self.directory.name) / "config.json"
        runner.LEGACY_CONFIG = pathlib.Path(self.directory.name) / "legacy-config.json"
        system_bundle = pathlib.Path(self.directory.name) / "system.pem"
        system_bundle.write_text("SYSTEM ROOTS\n")
        runner.SYSTEM_CA_BUNDLE = str(system_bundle)

    def tearDown(self):
        runner.WORK, runner.RESULT, runner.COPY_PROGRESS, runner.CONFIG, runner.LEGACY_CONFIG, runner.SYSTEM_CA_BUNDLE = self.original
        self.directory.cleanup()

    def write_config(self, config, mode=0o600):
        runner.CONFIG.write_text(runner.json.dumps(config))
        runner.os.chmod(runner.CONFIG, mode)

    def result(self):
        return runner.json.loads(runner.RESULT.read_text())

    def test_config_accepts_only_the_typed_copy_program(self):
        self.write_config(copy_config())
        self.assertEqual(runner.load_copy_config()["buckets"], ["assets"])
        for name, config in {
            "command": {**copy_config(), "command": "sh -c id"},
            "both selectors": copy_config(allBuckets=True),
            "no selector": copy_config(buckets=[]),
            "path bucket": copy_config(buckets=["assets/../etc"]),
            "mode": copy_config(mode="move"),
            "endpoint userinfo": copy_config(destination={"connectionId": "d", "endpoint": "https://u:p@example.test"}),
            "endpoint field": copy_config(destination={"connectionId": "d", "endpoint": "https://example.test", "command": "id"}),
            "newline secret": copy_config(destination={"connectionId": "d", "endpoint": "https://example.test", "secretAccessKey": "x\n[evil]"}),
            "same storage": copy_config(destination={**copy_config()["source"]}),
        }.items():
            with self.subTest(name=name):
                self.write_config(config)
                with self.assertRaises(runner.BackupError):
                    runner.load_copy_config()
        self.write_config(copy_config(), mode=0o644)
        with self.assertRaises(runner.BackupError):
            runner.load_copy_config()

    def test_config_falls_back_to_the_mount_of_older_daemons(self):
        runner.LEGACY_CONFIG.write_text(runner.json.dumps(copy_config()))
        runner.os.chmod(runner.LEGACY_CONFIG, 0o600)
        self.assertEqual(runner.load_copy_config()["buckets"], ["assets"])
        self.write_config(copy_config(buckets=["media"]))
        self.assertEqual(runner.load_copy_config()["buckets"], ["media"])

    def test_invalid_config_still_writes_a_failed_result(self):
        self.write_config({"kind": "storage_copy"})
        self.assertEqual(runner.storage_copy_main(), 1)
        result = self.result()
        self.assertEqual((result["status"], result["phase"]), ("failed", "validation"))

    def test_rclone_config_keeps_secrets_out_of_arguments_and_bucket_creation_explicit(self):
        base = runner.copy_rclone_setup(copy_config())
        joined = " ".join(base)
        self.assertNotIn("source-secret", joined)
        self.assertNotIn("destination-secret", joined)
        conf = pathlib.Path(base[base.index("--config") + 1]).read_text()
        self.assertIn("[source]", conf)
        self.assertIn("[destination]", conf)
        self.assertIn("endpoint = https://127.0.0.1:41001", conf)
        # Copy remotes never create buckets; only the explicit create remote may.
        create = conf.split("[destination_create]")[1]
        self.assertEqual(conf.split("[destination_create]")[0].count("no_check_bucket = true"), 2)
        self.assertNotIn("no_check_bucket", create)
        bundle = pathlib.Path(base[base.index("--ca-cert") + 1]).read_text()
        self.assertIn("SYSTEM ROOTS", bundle)
        self.assertIn(CA_PEM.strip(), bundle)
        no_create = runner.copy_rclone_setup(copy_config(createBuckets=False, source={**copy_config()["source"], "caPem": None}))
        self.assertNotIn("[destination_create]", pathlib.Path(no_create[no_create.index("--config") + 1]).read_text())
        self.assertNotIn("--ca-cert", no_create)

    def test_progress_accumulates_across_buckets(self):
        state = {"phase": "listing", "progress": None}
        progress = runner.CopyProgress(state, 2)
        progress.begin("a", "copying")
        stats, error = runner.parse_rclone_log_line('{"level":"notice","msg":"stats","stats":{"bytes":100,"transfers":2,"checks":3,"errors":0,"totalBytes":200,"speed":50.5,"eta":2}}')
        self.assertIsNone(error)
        progress.stats(stats)
        progress.finish_bucket()
        progress.begin("b", "copying")
        progress.stats({"bytes": 10, "transfers": 1, "checks": 0, "errors": 1, "eta": None})
        written = runner.json.loads(runner.COPY_PROGRESS.read_text())
        self.assertEqual((written["bytes"], written["objects"], written["errors"], written["bucket"], written["bucketsDone"]), (110, 3, 1, "b", 1))
        self.assertIsNone(written["etaSeconds"])
        self.assertEqual(progress.transferred(), {"objects": 3, "bytes": 110})
        _, error = runner.parse_rclone_log_line('{"level":"error","msg":"Failed to copy: AccessDenied"}')
        self.assertEqual(error, "Failed to copy: AccessDenied")
        self.assertEqual(runner.parse_rclone_log_line("plain text"), (None, None))

    def test_check_counts_outcomes_and_bounds_samples(self):
        # rclone marks objects only on the source with "+" and only on the destination with "-".
        combined = "= same\n" + "".join(f"+ missing-{index}\n" for index in range(30)) + "* changed\n- extra\n! broken\n"
        with patch.object(runner.subprocess, "Popen", return_value=FakeProcess(combined, "", 1)) as popen:
            checked = runner.check_bucket(["rclone"], copy_config(mode="sync"), "assets")
        self.assertEqual((checked["matched"], checked["missing"], checked["differing"], checked["extra"], checked["errors"]), (1, 30, 1, 1, 1))
        self.assertEqual(len(checked["missingKeys"]), runner.COPY_SAMPLE_KEYS)
        self.assertEqual(checked["extraKeys"], ["extra"])
        self.assertNotIn("--one-way", popen.call_args.args[0])
        with patch.object(runner.subprocess, "Popen", return_value=FakeProcess("= same\n", "", 0)) as popen:
            checked = runner.check_bucket(["rclone"], copy_config(), "assets")
        self.assertIn("--one-way", popen.call_args.args[0])
        self.assertIsNone(checked["extra"])
        with patch.object(runner.subprocess, "Popen", return_value=FakeProcess("", '{"level":"error","msg":"directory not found"}\n', 3)):
            with self.assertRaises(runner.BackupError):
                runner.check_bucket(["rclone"], copy_config(), "assets")
        with patch.object(runner.subprocess, "Popen", return_value=FakeProcess("", "", 1)):
            with self.assertRaises(runner.BackupError):
                runner.check_bucket(["rclone"], copy_config(), "assets")

    def run_copy(self, config, source_buckets, destination_buckets, check=None, copy_error=None):
        calls = []

        def fake_rclone(base, *args):
            calls.append(args)
            if args[0] == "lsjson":
                names = source_buckets if args[-1] == "source:" else destination_buckets
                if names is None:
                    return 1, "", '{"level":"error","msg":"AccessDenied"}'
                return 0, runner.json.dumps([{"Name": name, "Path": name, "IsDir": True} for name in names]), ""
            if args[0] == "size":
                return 0, '{"count":3,"bytes":300}', ""
            if args[0] == "mkdir":
                return 0, "", ""
            if args[0] == "version":
                return 0, "rclone v1.60.1-DEV\n", ""
            raise AssertionError(args)

        copied = []

        def fake_copy(base, cfg, bucket, progress, metadata):
            copied.append((bucket, metadata))
            progress.stats({"bytes": 300, "transfers": 3})
            return copy_error

        verdict = check or {"matched": 3, "missing": 0, "differing": 0, "extra": None, "errors": 0, "missingKeys": [], "differingKeys": [], "extraKeys": []}
        self.write_config(config)
        with patch.object(runner, "run_rclone", side_effect=fake_rclone), patch.object(runner, "copy_bucket", side_effect=fake_copy), patch.object(runner, "check_bucket", return_value=dict(verdict)):
            code = runner.storage_copy_main()
        return code, self.result(), calls, copied

    def test_copies_all_buckets_creates_missing_ones_and_reports_a_clean_check(self):
        code, result, calls, copied = self.run_copy(copy_config(allBuckets=True, buckets=[]), ["assets", "logs"], ["assets"])
        self.assertEqual(code, 0)
        self.assertEqual((result["status"], result["jobId"]), ("completed", COPY_JOB_ID))
        report = result["report"]
        self.assertTrue(report["clean"])
        self.assertEqual([bucket["name"] for bucket in report["buckets"]], ["assets", "logs"])
        self.assertEqual([bucket["created"] for bucket in report["buckets"]], [False, True])
        self.assertEqual(report["totals"]["sourceObjects"], 6)
        self.assertEqual(report["transferred"], {"objects": 6, "bytes": 600})
        mkdirs = [args for args in calls if args[0] == "mkdir"]
        self.assertEqual(mkdirs, [("mkdir", "--use-json-log", "--log-level", "ERROR", "destination_create:logs")])
        self.assertEqual(copied, [("assets", True), ("logs", True)])
        self.assertEqual(result["progress"]["bucketsDone"], 2)

    def test_missing_destination_bucket_without_permission_fails_that_bucket(self):
        code, result, calls, copied = self.run_copy(copy_config(createBuckets=False, buckets=["assets", "logs"]), ["assets", "logs"], ["assets"])
        self.assertEqual(code, 1)
        self.assertEqual((result["status"], result["phase"]), ("failed", "copy_failed"))
        failed = [bucket for bucket in result["report"]["buckets"] if bucket.get("error")]
        self.assertEqual([bucket["name"] for bucket in failed], ["logs"])
        self.assertIn("storage:objects:admin", failed[0]["error"])
        self.assertFalse(result["report"]["clean"])
        self.assertFalse(any(args[0] == "mkdir" for args in calls))
        self.assertEqual(copied, [("assets", True)])

    def test_selected_bucket_missing_on_source_fails_before_copying(self):
        code, result, _, copied = self.run_copy(copy_config(buckets=["ghost"]), ["assets"], ["assets"])
        self.assertEqual((code, result["status"], result["phase"]), (1, "failed", "listing"))
        self.assertIn("ghost", result["error"])
        self.assertEqual(copied, [])

    def test_dry_run_only_compares(self):
        code, result, calls, copied = self.run_copy(copy_config(dryRun=True, buckets=["assets", "logs"]), ["assets", "logs"], ["assets"],
                                                    check={"matched": 1, "missing": 2, "differing": 0, "extra": None, "errors": 0, "missingKeys": ["a", "b"], "differingKeys": [], "extraKeys": []})
        self.assertEqual(code, 0)
        self.assertEqual(copied, [])
        self.assertFalse(any(args[0] in {"mkdir", "version"} for args in calls))
        logs = result["report"]["buckets"][1]
        self.assertTrue(logs["missingOnDestination"])
        self.assertEqual(logs["missing"], 3)
        self.assertFalse(result["report"]["clean"])
        self.assertEqual(result["report"]["totals"]["missing"], 5)

    def test_sync_is_clean_only_without_extra_destination_objects(self):
        _, result, _, _ = self.run_copy(copy_config(mode="sync"), ["assets"], ["assets"],
                                        check={"matched": 3, "missing": 0, "differing": 0, "extra": 1, "errors": 0, "missingKeys": [], "differingKeys": [], "extraKeys": ["old"]})
        self.assertFalse(result["report"]["clean"])
        self.assertEqual(result["report"]["totals"]["extra"], 1)

    def test_rclone_copy_failure_is_reported_per_bucket(self):
        code, result, _, _ = self.run_copy(copy_config(), ["assets"], None, copy_error="Failed to copy: AccessDenied")
        self.assertEqual(code, 1)
        self.assertEqual(result["report"]["buckets"][0]["error"], "Failed to copy: AccessDenied")


if __name__ == "__main__":
    unittest.main()
