//go:build linux

package chha

import (
	"errors"
	"fmt"
	"net"
	"os"
	"runtime"

	"golang.org/x/sys/unix"
)

// ListenInNetns listens on address inside the network namespace of process
// pid (a member's container). The socket keeps belonging to that namespace
// after the thread returns to its own. It runs on a dedicated, locked OS
// thread: when the thread cannot return to the daemon's namespace it is never
// unlocked, so the Go runtime discards it with its goroutine.
func ListenInNetns(pid int, address string) (net.Listener, error) {
	if pid <= 0 {
		return nil, errors.New("the container has no process")
	}
	type result struct {
		listener net.Listener
		err      error
	}
	done := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		origin, err := os.Open(fmt.Sprintf("/proc/self/task/%d/ns/net", unix.Gettid()))
		if err != nil {
			runtime.UnlockOSThread()
			done <- result{err: err}
			return
		}
		defer origin.Close()
		target, err := os.Open(fmt.Sprintf("/proc/%d/ns/net", pid))
		if err != nil {
			runtime.UnlockOSThread()
			done <- result{err: err}
			return
		}
		defer target.Close()
		if err := unix.Setns(int(target.Fd()), unix.CLONE_NEWNET); err != nil {
			runtime.UnlockOSThread()
			done <- result{err: fmt.Errorf("enter the container's network namespace: %w", err)}
			return
		}
		listener, listenErr := net.Listen("tcp4", address)
		if err := unix.Setns(int(origin.Fd()), unix.CLONE_NEWNET); err != nil {
			// Stay locked: the thread dies with this goroutine.
			if listener != nil {
				_ = listener.Close()
			}
			done <- result{err: fmt.Errorf("return to the daemon's network namespace: %w", err)}
			return
		}
		runtime.UnlockOSThread()
		done <- result{listener: listener, err: listenErr}
	}()
	r := <-done
	return r.listener, r.err
}
