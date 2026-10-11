package chha

import (
	"testing"
	"time"
)

func TestStatusParsing(t *testing.T) {
	row, err := parseStatusRow("0\t3\t0\t4\t2\t7\t2\t1073741824\t10737418240\n")
	if err != nil {
		t.Fatal(err)
	}
	if !row.writable() || row.tables != 3 || row.delay != 4*time.Second || row.minActive != 2 || row.quorum != 2 {
		t.Fatalf("row %+v", row)
	}
	if _, err := parseStatusRow("1\t2"); err == nil {
		t.Fatal("short row accepted")
	}
	status := toStatus(row, "follower", false, "1,2,101", map[string]string{posConvert: "done:x"})
	s := sampleOf(status)
	if !s.keeperQuorum || s.delay != 4*time.Second || s.minActive != 2 || s.quorum != 2 || s.tables != 3 {
		t.Fatalf("sample %+v", s)
	}
	if !status.Writable || status.Streaming || status.SyncState != "sync" || status.Position[posKeeperVoters] != "1,2,101" {
		t.Fatalf("status %+v", status)
	}
	full, _ := parseStatusRow("1\t0\t0\t0\t0\t0\t1\t1024\t10737418240")
	if fullStatus := toStatus(full, "not_serving", false, "", nil); !fullStatus.DiskFull || fullStatus.Streaming || sampleOf(fullStatus).keeperQuorum {
		t.Fatalf("disk full / not serving %+v", fullStatus)
	}
	for answer, want := range map[string]string{
		"ClickHouse Keeper version: v25.8\nLatency min/avg/max: 0/0/0\nMode: follower\nZxid: 0x12\n": "follower",
		"This instance is not currently serving requests":                                            "not_serving",
	} {
		if got, err := parseKeeperMode(answer); err != nil || got != want {
			t.Errorf("mode of %q: %q %v", answer, got, err)
		}
	}
}
