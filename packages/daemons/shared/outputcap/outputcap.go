// Package outputcap bounds a daemon's own output when its service manager
// appends it to a plain file: OpenRC's output_log/error_log
// (/var/log/<daemon>.log and .err) and the manual-mode `nohup ... >>manual.log`
// fallback. Nothing rotates those files, and a daemon that logs a retry every
// second fills a small disk in weeks. Under systemd the output goes to journald,
// which bounds it, and this does nothing.
//
// Every few minutes each of stdout and stderr that is a regular file opened for
// appending and over MaxBytes keeps its last TailBytes (whole lines) in
// <file>.1 and is truncated in place. The service manager opened it O_APPEND,
// so every writer (the launcher, the daemon, its helpers) goes on at the new
// end; no reopen is needed. A file not opened for appending is left alone:
// truncating it would leave the writers at their old offsets.
package outputcap

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// MaxBytes is the size at which an output file is cut.
	MaxBytes = 50 << 20
	// TailBytes is how much of it is kept in <file>.1.
	TailBytes = 5 << 20
	// Interval is how often the files are checked.
	Interval = 5 * time.Minute
)

var startOnce sync.Once

// Start checks the process's stdout and stderr now and every Interval for the
// life of the process. Call it once from the daemon's run command.
func Start(logger *slog.Logger) {
	startOnce.Do(func() {
		go func() {
			cutter := &cutter{logger: logger, warned: map[string]bool{}}
			for {
				cutter.pass([]int{1, 2})
				time.Sleep(Interval)
			}
		}()
	})
}

type cutter struct {
	logger *slog.Logger
	warned map[string]bool
}

type fileID struct{ dev, ino uint64 }

func (c *cutter) pass(fds []int) {
	seen := map[fileID]bool{}
	for _, fd := range fds {
		var stat syscall.Stat_t
		if err := syscall.Fstat(fd, &stat); err != nil {
			continue
		}
		id := fileID{uint64(stat.Dev), uint64(stat.Ino)}
		if seen[id] {
			continue
		}
		seen[id] = true
		path := fdPath(fd)
		cut, err := Cut(fd, path, MaxBytes, TailBytes)
		if err != nil {
			key := fmt.Sprintf("%d:%s", fd, err)
			if !c.warned[key] && c.logger != nil {
				c.logger.Warn("daemon output file is not bounded", "fd", fd, "path", path, "error", err)
			}
			c.warned[key] = true
			continue
		}
		if cut > 0 && c.logger != nil {
			c.logger.Info("cut the daemon output file", "path", path, "freed_bytes", cut, "kept", path+".1")
		}
	}
}

// fdPath is the file a descriptor of this process refers to, from
// /proc/self/fd; empty when unknown or deleted.
func fdPath(fd int) string {
	path, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(fd))
	if err != nil || !strings.HasPrefix(path, "/") || strings.HasSuffix(path, " (deleted)") {
		return ""
	}
	return path
}

// errNotAppending: the file was not opened O_APPEND, so truncating it would
// leave its writers at their old offsets (a sparse file that grows on).
var errNotAppending = fmt.Errorf("the file is not opened for appending")

// Cut truncates the regular file open as fd once it is over maxBytes, after
// copying its last tailBytes from the first whole line to path+".1" when path
// is known and readable. It returns the bytes freed; 0 when fd is not a
// regular file or not over maxBytes.
func Cut(fd int, path string, maxBytes, tailBytes int64) (int64, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return 0, err
	}
	if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Size <= maxBytes {
		return 0, nil
	}
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFL, 0)
	if errno != 0 {
		return 0, errno
	}
	if flags&syscall.O_APPEND == 0 {
		return 0, errNotAppending
	}
	kept := int64(0)
	if path != "" && tailBytes > 0 {
		// Without the tail (not readable, directory not writable) the file is
		// still cut: a bounded log matters more than its last lines.
		kept, _ = keepTail(path, stat.Size, tailBytes)
	}
	if err := syscall.Ftruncate(fd, 0); err != nil {
		return 0, err
	}
	return stat.Size - kept, nil
}

func keepTail(path string, size, tailBytes int64) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	start := size - tailBytes
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return 0, err
	}
	reader := bufio.NewReader(io.LimitReader(file, size-start))
	if start > 0 {
		if _, err := reader.ReadBytes('\n'); err != nil {
			reader = bufio.NewReader(bytes.NewReader(nil))
		}
	}
	tmp := path + ".1.tmp"
	// The kept tail gets the live log's mode (0640 for the adm group's readers), not a stricter one of its own.
	mode := os.FileMode(0o600)
	if info, statErr := file.Stat(); statErr == nil {
		mode = info.Mode().Perm()
	}
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return 0, err
	}
	// OpenFile applies the umask; set the mode itself so the copy matches.
	_ = out.Chmod(mode)
	kept, err := io.Copy(out, reader)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, path+".1")
	}
	if err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	return kept, nil
}
