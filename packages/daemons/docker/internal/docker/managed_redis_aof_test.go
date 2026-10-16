package docker

import (
	"os"
	"strings"
	"testing"
)

// A percentage of 0 turns the automatic AOF rewrite off; the daemon renders
// the default instead, and repairs a bound file an older release wrote.
func TestRedisAOFRewriteIsNeverOff(t *testing.T) {
	config := defaultManagedRedisConfig()
	config.AutoAOFRewritePercentage = 0
	text := managedRedisConfigText(managedDatabaseCommand{Type: "redis", MemoryBytes: 256 << 20, RedisConfig: &config})
	if !strings.Contains(text, "\nauto-aof-rewrite-percentage 100\n") {
		t.Fatalf("0 renders as the default:\n%s", text)
	}
	config.AutoAOFRewritePercentage = 50
	if text := managedRedisConfigText(managedDatabaseCommand{Type: "redis", MemoryBytes: 256 << 20, RedisConfig: &config}); !strings.Contains(text, "\nauto-aof-rewrite-percentage 50\n") {
		t.Fatalf("another value is kept:\n%s", text)
	}

	record := managedDatabaseRecord{Type: "redis", MountPath: t.TempDir(), RedisConfigHash: "abc"}
	legacy := "maxmemory 100\nappendonly yes\nauto-aof-rewrite-percentage 0\nauto-aof-rewrite-min-size 64mb\n"
	if err := writeManagedRedisConfig(managedRedisBoundConfigPath(record), legacy); err != nil {
		t.Fatal(err)
	}
	repaired, err := repairRedisAOFRewrite(record)
	if err != nil || !repaired {
		t.Fatalf("repair = %v %v", repaired, err)
	}
	data, err := os.ReadFile(managedRedisBoundConfigPath(record))
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.Replace(legacy, "percentage 0", "percentage 100", 1); string(data) != want {
		t.Fatalf("repaired file:\n%s\nwant:\n%s", data, want)
	}
	if repaired, err := repairRedisAOFRewrite(record); err != nil || repaired {
		t.Fatalf("a repaired file is left alone: %v %v", repaired, err)
	}
	if repaired, err := repairRedisAOFRewrite(managedDatabaseRecord{Type: "redis", MountPath: t.TempDir(), RedisConfigHash: "missing"}); err != nil || repaired {
		t.Fatalf("a missing file is no error: %v %v", repaired, err)
	}
}
