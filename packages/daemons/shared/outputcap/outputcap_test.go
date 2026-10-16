package outputcap

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openLog(t *testing.T, flags int, lines int) (*os.File, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "docker-daemon.log")
	content := bytes.Repeat([]byte("{\"level\":\"WARN\",\"msg\":\"relay tunnel lane connection failed, retrying\"}\n"), lines)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	return file, path
}

func TestCutKeepsTheTailAndWritersGoOnAtTheNewEnd(t *testing.T) {
	file, path := openLog(t, os.O_WRONLY|os.O_APPEND, 1000)
	before, _ := os.Stat(path)

	freed, err := Cut(int(file.Fd()), path, 1000, 300)
	if err != nil {
		t.Fatal(err)
	}
	tail, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) == 0 || len(tail) > 300 || !strings.HasPrefix(string(tail), "{") || !strings.HasSuffix(string(tail), "}\n") {
		t.Fatalf("tail is not whole lines: %q", tail)
	}
	if freed != before.Size()-int64(len(tail)) {
		t.Fatalf("freed %d", freed)
	}
	if _, err := file.WriteString("next\n"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != "next\n" {
		t.Fatalf("the writer did not go on at the start: %q", after)
	}
}

func TestCutLeavesSmallFilesAndNonAppendingWritersAlone(t *testing.T) {
	file, path := openLog(t, os.O_WRONLY|os.O_APPEND, 10)
	if freed, err := Cut(int(file.Fd()), path, 1<<20, 300); err != nil || freed != 0 {
		t.Fatalf("freed=%d err=%v", freed, err)
	}

	plain, plainPath := openLog(t, os.O_WRONLY, 1000)
	if _, err := Cut(int(plain.Fd()), plainPath, 1000, 300); !errors.Is(err, errNotAppending) {
		t.Fatalf("err = %v", err)
	}
	if info, _ := os.Stat(plainPath); info.Size() == 0 {
		t.Fatal("a file without O_APPEND was truncated")
	}
}

func TestCutWithoutAKnownPathStillBoundsTheFile(t *testing.T) {
	file, path := openLog(t, os.O_WRONLY|os.O_APPEND, 1000)
	if _, err := Cut(int(file.Fd()), "", 1000, 300); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(path); info.Size() != 0 {
		t.Fatal("not truncated")
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Fatal("a tail was written without a path")
	}
}
