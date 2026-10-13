package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

const (
	volumeImageMountOptions = "noatime,nodev,nosuid"
	volumeImageBootService  = "opfield-volume-images"
)

// MountVolumeImagesAtBoot is the `mount-volume-images` boot step, ordered
// before Docker by the unit installVolumeImageBootUnit writes. It mounts every
// disk-image volume image that is not mounted yet (its fstab entry normally
// did), and at the mount point of one that cannot be mounted it mounts a
// read-only empty placeholder: a container Docker then starts on that volume
// fails on a read-only directory instead of writing into the root filesystem.
// The daemon replaces the placeholder once it can mount the image and restarts
// the volume's containers onto it.
func MountVolumeImagesAtBoot(ctx context.Context, stateDir string, logger *slog.Logger) error {
	m := &volumeImageManager{logger: logger, root: filepath.Clean(filepath.Join(stateDir, "volume-images"))}
	return m.mountAtBoot(ctx)
}

func (m *volumeImageManager) mountAtBoot(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(m.root, "records"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	h := m.loopHost()
	var unmounted []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		var record volumeImageRecord
		data, err := os.ReadFile(filepath.Join(m.root, "records", entry.Name()))
		if err == nil {
			err = json.Unmarshal(data, &record)
		}
		if err != nil || !pathWithin(m.root, record.ImagePath) || !pathWithin(m.root, record.MountPath) {
			m.logger.Error("disk-image volume record could not be read at boot", "record", entry.Name(), "error", err)
			unmounted = append(unmounted, entry.Name())
			continue
		}
		if record.Deleting {
			continue
		}
		if mounted, err := h.isMounted(canonicalLoopPath(record.MountPath)); err != nil {
			return err
		} else if mounted {
			continue
		}
		if _, err := h.mountImage(ctx, record.ImagePath, record.MountPath, volumeImageMountOptions); err == nil {
			m.logger.Info("mounted disk-image volume", "volume", record.Name)
			continue
		} else {
			m.logger.Error("disk-image volume image could not be mounted; its mount point is made read-only", "volume", record.Name, "error", err)
		}
		unmounted = append(unmounted, record.Name)
		if err := m.guardMountPoint(ctx, record.MountPath); err != nil {
			m.logger.Error("read-only placeholder of a disk-image volume could not be mounted", "volume", record.Name, "error", err)
		}
	}
	if len(unmounted) > 0 {
		return fmt.Errorf("disk-image volumes not mounted: %s", strings.Join(unmounted, ", "))
	}
	return nil
}

// guardMountPoint mounts the read-only empty placeholder at a mount point
// whose image is not mounted.
func (m *volumeImageManager) guardMountPoint(ctx context.Context, path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return m.loopHost().placeholder(ctx, path)
}

// volumeImageBootHost is where the boot unit goes; tests point it elsewhere.
type volumeImageBootHost struct {
	systemd    bool
	openrc     bool
	systemdDir string
	openrcDir  string
	runlevels  string
	run        func(name string, args ...string) error
	// confirmed: this start is confirmed (lifecycle.OnStartConfirmed), so the
	// pre-Opfield boot units go.
	confirmed bool
}

func systemVolumeImageBootHost() volumeImageBootHost {
	_, systemdErr := os.Stat("/run/systemd/system")
	_, openrcErr := os.Stat("/sbin/openrc-run")
	return volumeImageBootHost{
		systemd:    systemdErr == nil,
		openrc:     openrcErr == nil,
		systemdDir: "/etc/systemd/system",
		openrcDir:  "/etc/init.d",
		runlevels:  "/etc/runlevels",
		confirmed:  lifecycle.StartConfirmed(),
		run: func(name string, args ...string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			return runLoopCommand(ctx, name, args...)
		},
	}
}

func systemdVolumeImageUnit(host volumeImageBootHost, executable, stateDir string) string {
	return `[Unit]
Description=Opfield disk-image volumes: mount before Docker starts containers
After=local-fs.target
Before=docker.service
` + systemdLegacyGuard(host, legacyVolumeImageBootService) + `

[Service]
Type=oneshot
ExecStart=` + strconv.Quote(executable) + ` mount-volume-images --state-dir ` + strconv.Quote(stateDir) + `
RemainAfterExit=yes
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target docker.service
`
}

func openrcVolumeImageService(host volumeImageBootHost, executable, stateDir string) string {
	return `#!/sbin/openrc-run
description="Opfield disk-image volumes: mount before Docker starts containers"

depend() {
	need localmount
	before docker
}

start() {
` + openrcLegacyGuard(host, legacyVolumeImageBootService) + `	ebegin "Mounting Opfield disk-image volumes"
	` + shellQuote(executable) + ` mount-volume-images --state-dir ` + shellQuote(stateDir) + `
	eend $?
}
`
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// installVolumeImageBootUnit installs or updates the boot step that mounts
// disk-image volume images before Docker starts. The daemon does it itself, so
// a node updated in place gets it as well as a new one.
func installVolumeImageBootUnit(host volumeImageBootHost, executable, stateDir string) error {
	switch {
	case host.systemd:
		path := filepath.Join(host.systemdDir, volumeImageBootService+".service")
		changed, err := writeFileIfChanged(path, systemdVolumeImageUnit(host, executable, stateDir), 0o644)
		if err != nil {
			return err
		}
		if changed {
			if err := host.run("systemctl", "daemon-reload"); err != nil {
				return err
			}
		}
		if changed || host.run("systemctl", "is-enabled", "--quiet", volumeImageBootService+".service") != nil {
			if err := host.run("systemctl", "enable", "--quiet", volumeImageBootService+".service"); err != nil {
				return err
			}
		}
		return retireLegacyBootUnit(host, legacyVolumeImageBootService)
	case host.openrc:
		path := filepath.Join(host.openrcDir, volumeImageBootService)
		if _, err := writeFileIfChanged(path, openrcVolumeImageService(host, executable, stateDir), 0o755); err != nil {
			return err
		}
		if _, err := os.Lstat(filepath.Join(host.runlevels, "boot", volumeImageBootService)); err != nil {
			if err := host.run("rc-update", "add", volumeImageBootService, "boot"); err != nil {
				return err
			}
		}
		return retireLegacyBootUnit(host, legacyVolumeImageBootService)
	default:
		return errors.New("no systemd or OpenRC: disk-image volumes are mounted at boot only by their fstab entries")
	}
}

func writeFileIfChanged(path, content string, mode os.FileMode) (bool, error) {
	if current, err := os.ReadFile(path); err == nil && string(current) == content {
		if info, statErr := os.Stat(path); statErr == nil && info.Mode().Perm() == mode {
			return false, nil
		}
	}
	if err := atomicfile.WriteFile(path, []byte(content), mode); err != nil {
		return false, fmt.Errorf("write %s: %w", path, err)
	}
	return true, nil
}

// ensureVolumeImageBootUnit is installVolumeImageBootUnit for this daemon's
// own binary and state directory.
func (m *volumeImageManager) ensureVolumeImageBootUnit(stateDir string) {
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err == nil {
		err = installVolumeImageBootUnit(systemVolumeImageBootHost(), executable, stateDir)
	}
	if err != nil {
		m.logger.Warn("disk-image volume boot step not installed", "error", err)
	}
}
