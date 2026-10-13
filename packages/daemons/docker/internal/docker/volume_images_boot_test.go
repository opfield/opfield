package docker

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func newTestVolumeManager(t *testing.T, loops *fakeLoops) *volumeImageManager {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{"images", "mounts", "records"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return &volumeImageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host(), supported: true}
}

func saveTestVolume(t *testing.T, m *volumeImageManager, name string) volumeImageRecord {
	t.Helper()
	record := m.newRecord(name, minimumVolumeImageBytes)
	writeFile(t, record.ImagePath)
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	return record
}

// At boot, before Docker: images are mounted, and the mount point of one that
// cannot be mounted becomes a read-only empty placeholder instead of a bare
// directory on the root filesystem.
func TestVolumeBootStepGuardsImagesThatCannotBeMounted(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestVolumeManager(t, loops)
	good := saveTestVolume(t, m, "good")
	bad := saveTestVolume(t, m, "bad")
	done := saveTestVolume(t, m, "done") // the fstab entry already mounted it
	loops.attach("/dev/loop1", "7:1", done.ImagePath)
	loops.mount("7:1", done.MountPath)
	gone := saveTestVolume(t, m, "gone")
	gone.Deleting = true
	if err := m.saveRecord(gone); err != nil {
		t.Fatal(err)
	}
	loops.failImages = map[string]bool{bad.ImagePath: true}

	err := m.mountAtBoot(context.Background())
	if err == nil || !strings.Contains(err.Error(), "bad") {
		t.Fatalf("error = %v, want the volume that is not mounted", err)
	}
	for _, call := range []string{"mount /dev/loop101 " + good.MountPath, "placeholder " + bad.MountPath} {
		if !slices.Contains(loops.calls, call) {
			t.Errorf("calls = %v, missing %q", loops.calls, call)
		}
	}
	for _, call := range loops.calls {
		if strings.Contains(call, done.MountPath) || strings.Contains(call, gone.ImagePath) || strings.Contains(call, gone.MountPath) {
			t.Errorf("boot step touched a mounted or deleted volume: %s", call)
		}
	}
	if placeholder, _ := loops.host().isPlaceholder(canonicalLoopPath(bad.MountPath)); !placeholder {
		t.Fatal("unmountable image left a writable mount point")
	}
}

// The daemon replaces the placeholder with the image as soon as it can mount
// it and moves the volume's running containers onto it: all stop before any
// starts, since Docker binds a local volume once for all of them.
func TestVolumeDaemonReplacesPlaceholderAndRestartsUsers(t *testing.T) {
	loops := newFakeLoops(t)
	m := newTestVolumeManager(t, loops)
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"u1": true, "u2": true}, policy: map[string]string{}, users: []string{"u1", "u2"}}
	m.client = docker.client()
	record := saveTestVolume(t, m, "data")
	path := canonicalLoopPath(record.MountPath)
	if err := m.guardMountPoint(context.Background(), record.MountPath); err != nil {
		t.Fatal(err)
	}

	// Still no loop device: the placeholder stays and nothing restarts.
	loops.calls, loops.attachErr = nil, errNoFreeLoopDevice
	m.mountVolume(context.Background(), &record)
	if placeholder, _ := loops.host().isPlaceholder(path); !placeholder || slices.ContainsFunc(loops.calls, func(call string) bool {
		return strings.HasPrefix(call, "stop ") || strings.HasPrefix(call, "start ")
	}) {
		t.Fatalf("calls = %v; want the placeholder back and no restart", loops.calls)
	}

	loops.calls, loops.attachErr = nil, nil
	m.mountVolume(context.Background(), &record)
	want := []string{"umount " + path, "attach " + record.ImagePath, "mount /dev/loop100 " + record.MountPath, "stop u1", "stop u2", "start u1", "start u2"}
	if !slices.Equal(loops.calls, want) {
		t.Fatalf("calls = %v, want %v", loops.calls, want)
	}
	if placeholder, _ := loops.host().isPlaceholder(path); placeholder {
		t.Fatal("placeholder left over the mounted image")
	}

	// Mounted: later passes change nothing.
	loops.calls = nil
	m.mountVolume(context.Background(), &record)
	if len(loops.calls) != 0 {
		t.Fatalf("calls = %v, want none for a mounted volume", loops.calls)
	}
}

func TestVolumeBootUnitIsInstalledBeforeDocker(t *testing.T) {
	var commands []string
	enabled := false
	host := volumeImageBootHost{
		systemd: true, systemdDir: t.TempDir(), openrcDir: t.TempDir(), runlevels: t.TempDir(),
		run: func(name string, args ...string) error {
			commands = append(commands, name+" "+strings.Join(args, " "))
			if slices.Contains(args, "is-enabled") && !enabled {
				return errors.New("disabled")
			}
			if slices.Contains(args, "enable") {
				enabled = true
			}
			return nil
		},
	}
	if err := installVolumeImageBootUnit(host, "/usr/local/bin/docker-daemon", "/var/lib/docker-daemon"); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(filepath.Join(host.systemdDir, volumeImageBootService+".service"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"Before=docker.service", `ExecStart="/usr/local/bin/docker-daemon" mount-volume-images --state-dir "/var/lib/docker-daemon"`, "WantedBy=multi-user.target docker.service"} {
		if !strings.Contains(string(unit), line) {
			t.Errorf("unit lacks %q:\n%s", line, unit)
		}
	}
	if !slices.Contains(commands, "systemctl daemon-reload") || !slices.Contains(commands, "systemctl enable --quiet "+volumeImageBootService+".service") {
		t.Fatalf("commands = %v", commands)
	}
	commands = nil
	if err := installVolumeImageBootUnit(host, "/usr/local/bin/docker-daemon", "/var/lib/docker-daemon"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(commands, []string{"systemctl is-enabled --quiet " + volumeImageBootService + ".service"}) {
		t.Fatalf("an unchanged, enabled unit was touched again: %v", commands)
	}

	host.systemd, host.openrc, commands = false, true, nil
	if err := installVolumeImageBootUnit(host, "/usr/local/bin/docker-daemon", "/var/lib/docker-daemon"); err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile(filepath.Join(host.openrcDir, volumeImageBootService))
	if err != nil || !strings.Contains(string(script), "before docker") || !strings.Contains(string(script), "'/usr/local/bin/docker-daemon' mount-volume-images") {
		t.Fatalf("OpenRC service = %s, %v", script, err)
	}
	if !slices.Equal(commands, []string{"rc-update add " + volumeImageBootService + " boot", "rc-update -u"}) {
		t.Fatalf("commands = %v", commands)
	}
}
