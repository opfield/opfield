package docker

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

const testValkeyImage = "docker.io/valkey/valkey-bundle@sha256:dd30c59c2b2a598e83308095220a31d6d93d64c40a839c702cb1e98c8e220660"
const testRedisImage = "docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236"

func TestValkeyKeyValueStoreRunsValkeyWithItsModules(t *testing.T) {
	mirror, ok := thirdPartyMirrorReference(testValkeyImage)
	if !ok || !managedRedisRunsValkey(testValkeyImage) || !managedRedisRunsValkey(mirror) || managedRedisRunsValkey(testRedisImage) {
		t.Fatalf("Valkey image detection: mirror %q ok %v", mirror, ok)
	}
	if !isCuratedDigestImage("redis", testValkeyImage) || !isCuratedDigestImage("redis", mirror) {
		t.Fatal("the Valkey image must be a curated key-value image")
	}
	if managedRedisServerCommand(testValkeyImage) != "valkey-server" || managedRedisServerCommand(testRedisImage) != "redis-server" {
		t.Fatal("server command")
	}
	record := managedDatabaseRecord{MountPath: "/m"}
	if managedRedisDataPath(record, testValkeyImage) != "/m/valkey-data" || managedRedisDataPath(record, testRedisImage) != "/m/redis-data" {
		t.Fatal("data directories")
	}
	valkey := managedRedisConfigText(managedDatabaseCommand{Type: "redis", Image: testValkeyImage, MemoryBytes: 1 << 30})
	for _, module := range managedValkeyModules {
		if !strings.Contains(valkey, "\nloadmodule "+module+"\n") {
			t.Fatalf("Valkey config does not load %s:\n%s", module, valkey)
		}
	}
	// The bundle entrypoint skips a module the config names, LDAP included.
	if !strings.Contains(valkey, "loadmodule /usr/lib/valkey/libvalkey_ldap.so") || strings.Contains(valkey, "\nloadmodule /usr/lib/valkey/libvalkey_ldap.so") {
		t.Fatalf("the LDAP module must be named only in a comment:\n%s", valkey)
	}
	redis := managedRedisConfigText(managedDatabaseCommand{Type: "redis", Image: testRedisImage, MemoryBytes: 1 << 30})
	if strings.Contains(redis, "loadmodule") || !strings.HasSuffix(redis, "activedefrag no\n") {
		t.Fatalf("a Redis store keeps its config:\n%s", redis)
	}
}

func TestRedisStageLoadsTheModulesOfEitherImage(t *testing.T) {
	command := redisStageCommand()
	for _, want := range append([]string{"/usr/local/lib/redis/modules/*.so", "exec redis-server /work/redis-stage/redis.conf \"$@\""}, managedValkeyModules...) {
		if !strings.Contains(command, want) {
			t.Fatalf("stage command lacks %q:\n%s", want, command)
		}
	}
	if strings.Contains(command, "ldap") {
		t.Fatal("the stage must not load the LDAP module")
	}
}

func TestRespCommandsRoundTrip(t *testing.T) {
	var buffer bytes.Buffer
	if err := writeRespCommand(&buffer, []string{"SET", "k\r\n", ""}); err != nil {
		t.Fatal(err)
	}
	if buffer.String() != "*3\r\n$3\r\nSET\r\n$3\r\nk\r\n\r\n$0\r\n\r\n" {
		t.Fatalf("encoded %q", buffer.String())
	}
	reply, err := readResp(bufio.NewReader(strings.NewReader("*4\r\n$1\r\na\r\n:-2\r\n$-1\r\n*2\r\n+OK\r\n-ERR unknown command 'X'\r\n")))
	if err != nil {
		t.Fatal(err)
	}
	if len(reply.items) != 4 || reply.items[0].text != "a" || reply.items[1].integer != -2 || !reply.items[2].null || reply.items[3].items[1].kind != '-' {
		t.Fatalf("decoded %+v", reply)
	}
	if !isRedisUnknownCommand(respError(reply.items[3].items[1].text)) {
		t.Fatal("unknown command detection")
	}
}
