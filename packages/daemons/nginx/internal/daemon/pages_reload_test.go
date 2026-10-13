package daemon

import (
	"path/filepath"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/pages"
)

func withPagesRuntime(t *testing.T, h *reloadTestHandler) {
	t.Helper()
	runtime, err := pages.New(filepath.Join(filepath.Dir(h.cfg.Nginx.ConfigDir), "pages"), h.cfg.Nginx.ConfigDir, h.cfg.Nginx.CertsDir, h.mgr)
	if err != nil {
		t.Fatal(err)
	}
	h.pagesRuntime = runtime
	runtime.SetDeferredReload(h.mgr.BeginChange, h.schedulePagesReload)
}

func removePreview(hostname string) *pb.OpfieldCommand {
	return &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_PagesRemovePreview{PagesRemovePreview: &pb.PagesRemovePreviewCommand{Hostname: hostname}}}
}

// F-9: the Pages commands of one deploy or deletion arrive within a second; each is tested at once and they load
// with one reload shortly after the last of them.
func TestPagesChangesLoadWithOneDebouncedReload(t *testing.T) {
	h := newReloadTestHandler(t)
	withPagesRuntime(t, h)
	start := time.Now()
	for _, hostname := range []string{"a.pages.test", "b.pages.test", "c.pages.test"} {
		h.run(t, removePreview(hostname))
		time.Sleep(100 * time.Millisecond)
	}
	if got := h.reloads(t); got != 0 {
		t.Fatalf("Pages changes reloaded nginx %d times before they went quiet", got)
	}
	for h.reloads(t) < 1 && time.Since(start) < pagesReloadMax+time.Second {
		time.Sleep(20 * time.Millisecond)
	}
	if got, waited := h.reloads(t), time.Since(start); got != 1 || waited > pagesReloadMax+500*time.Millisecond {
		t.Fatalf("three Pages changes: %d reloads after %s, want 1 within %s", got, waited, pagesReloadMax)
	}
	time.Sleep(pagesReloadQuiet + 200*time.Millisecond)
	if got := h.reloads(t); got != 1 || h.mgr.ReloadPending() {
		t.Fatalf("after the debounced reload: %d reloads, pending %v", got, h.mgr.ReloadPending())
	}

	// A steady stream of changes still reloads within the max wait.
	start = time.Now()
	for i := 0; time.Since(start) < pagesReloadMax+300*time.Millisecond; i++ {
		h.run(t, removePreview(string(rune('d'+i%20))+"x.pages.test"))
		time.Sleep(pagesReloadQuiet / 2)
	}
	if got := h.reloads(t); got < 2 {
		t.Fatalf("a steady stream of Pages changes did not reload within %s", pagesReloadMax)
	}
}

// Removing a release loads the Pages changes that still wait first: nginx must not serve a release whose files
// are gone.
func TestPagesCleanupLoadsWaitingChangesFirst(t *testing.T) {
	h := newReloadTestHandler(t)
	withPagesRuntime(t, h)
	h.run(t, removePreview("a.pages.test"))
	if got := h.reloads(t); got != 0 {
		t.Fatalf("reloads before the cleanup: %d", got)
	}
	// The release is not stored, so the cleanup itself fails, after the waiting change was loaded.
	h.HandleCommand(&pb.OpfieldCommand{Payload: &pb.OpfieldCommand_PagesCleanupDeployment{PagesCleanupDeployment: &pb.PagesCleanupDeploymentCommand{DeploymentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"}}})
	if got := h.reloads(t); got != 1 || h.mgr.ReloadPending() {
		t.Fatalf("cleanup: %d reloads, pending %v; want the waiting change loaded", got, h.mgr.ReloadPending())
	}
}
