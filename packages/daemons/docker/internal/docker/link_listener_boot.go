package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// After a reboot Docker starts the workloads (their restart policy) before this daemon, which starts after Docker,
// listens on their database links again: the first connections were refused (stand run X1, PAAS-06: the listener came
// 1-2 s after the container). A boot step ordered before Docker therefore opens the host listeners this daemon held
// last (link-listeners/listeners.json) and holds them until the daemon takes them over. Docker has not created the
// binding networks yet at that point, so the sockets bind with IP_FREEBIND to their gateway addresses before those
// exist; once Docker brings the bridge up, a workload's connection waits in the backlog for the daemon instead of
// being refused. The boot step only listens: the daemon authorises and serves every connection, and drops the sockets
// of bindings that are gone.
//
// The step forks: the process systemd or OpenRC started binds the sockets, starts a holder that keeps them and serves
// one handover over a root-only Unix socket, and exits once the holder is ready, which is when Docker may start.

const (
	linkListenerBootService   = "opfield-link-listeners"
	linkListenerBootDirectory = "link-listeners"
	linkListenerSetFile       = "listeners.json"
	linkListenerHandoverFile  = "handover.sock"
	// linkListenerBootHold bounds how long the holder keeps the sockets for a daemon that does not ask for them.
	linkListenerBootHold = 2 * time.Minute
	// linkListenerHandoverWait bounds the daemon's handover request.
	linkListenerHandoverWait = 5 * time.Second
	// linkListenerHandoverBatch is the most descriptors one handover message carries (Linux SCM_MAX_FD is 253).
	linkListenerHandoverBatch = 200
	linkListenerHolderEnv     = "OPFIELD_LINK_LISTENERS_HELD"
)

type linkListenerAddress struct {
	Address string `json:"address"`
	Port    uint16 `json:"port"`
}

type linkListenerSet struct {
	Listeners []linkListenerAddress `json:"listeners"`
}

type linkListenerHandoverMessage struct {
	Names []string `json:"names"`
	Last  bool     `json:"last"`
}

func linkListenerBootPath(stateDir, name string) string {
	return filepath.Join(stateDir, linkListenerBootDirectory, name)
}

// persistBootSetLocked records the addresses of the open host listeners for the boot step, when they changed.
// Callers hold m.mu.
func (m *managedDatabaseHostListenerManager) persistBootSetLocked() {
	if m.stateDir == "" {
		return
	}
	set := linkListenerSet{Listeners: []linkListenerAddress{}}
	for _, listener := range m.listeners {
		config := listener.currentConfig()
		set.Listeners = append(set.Listeners, linkListenerAddress{Address: config.listenAddress.String(), Port: config.listenPort})
	}
	slices.SortFunc(set.Listeners, func(a, b linkListenerAddress) int {
		if a.Address != b.Address {
			if a.Address < b.Address {
				return -1
			}
			return 1
		}
		return int(a.Port) - int(b.Port)
	})
	encoded, err := json.Marshal(set)
	if err != nil || string(encoded) == m.bootSetWritten {
		return
	}
	if err := os.MkdirAll(filepath.Join(m.stateDir, linkListenerBootDirectory), 0o700); err == nil {
		err = atomicfile.WriteFile(linkListenerBootPath(m.stateDir, linkListenerSetFile), encoded, 0o600)
	}
	if err != nil {
		m.logger.Warn("could not record the database link listeners for the next boot", "error", err)
		return
	}
	m.bootSetWritten = string(encoded)
}

// readLinkListenerSet reads the listeners to open at boot. Only addresses a listener can have are kept: the daemon
// verified each one as the gateway of its binding network before it listened there.
func readLinkListenerSet(stateDir string) ([]linkListenerAddress, error) {
	data, err := os.ReadFile(linkListenerBootPath(stateDir, linkListenerSetFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var set linkListenerSet
	if err := json.Unmarshal(data, &set); err != nil {
		return nil, err
	}
	var valid []linkListenerAddress
	for _, entry := range set.Listeners {
		address, err := netip.ParseAddr(entry.Address)
		if err != nil || !address.Is4() || !address.IsGlobalUnicast() || entry.Port == 0 {
			continue
		}
		valid = append(valid, entry)
	}
	return valid, nil
}

// HoldLinkListenersAtBoot is the `hold-link-listeners` boot step (see the top of this file). Without listeners to
// hold it returns at once.
func HoldLinkListenersAtBoot(stateDir string, logger *slog.Logger) error {
	if os.Getenv(linkListenerHolderEnv) != "" {
		return serveLinkListenerHandover(stateDir, logger)
	}
	set, err := readLinkListenerSet(stateDir)
	if err != nil {
		return fmt.Errorf("read the database link listeners: %w", err)
	}
	var files []*os.File
	var names []string
	for _, entry := range set {
		address := netip.MustParseAddr(entry.Address)
		file, err := bindFreeListener(address, entry.Port)
		if err != nil {
			logger.Warn("database link listener not opened before Docker", "address", net.JoinHostPort(entry.Address, strconv.Itoa(int(entry.Port))), "error", err)
			continue
		}
		files = append(files, file)
		names = append(names, hostListenerKeepName(address, entry.Port))
	}
	if len(files) == 0 {
		return nil
	}
	defer func() {
		for _, file := range files {
			_ = file.Close()
		}
	}()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	ready, readyWriter, err := os.Pipe()
	if err != nil {
		return err
	}
	defer ready.Close()
	encodedNames, _ := json.Marshal(names)
	holder := exec.Command(executable, "hold-link-listeners", "--state-dir", stateDir)
	holder.Env = append(os.Environ(), linkListenerHolderEnv+"="+string(encodedNames))
	holder.ExtraFiles = append([]*os.File{readyWriter}, files...)
	holder.Stdout, holder.Stderr = os.Stdout, os.Stderr
	holder.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := holder.Start(); err != nil {
		readyWriter.Close()
		return fmt.Errorf("start the database link listener holder: %w", err)
	}
	readyWriter.Close()
	// Docker starts once this process exited: the holder listens on the handover socket by then.
	_ = ready.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := ready.Read(make([]byte, 1)); err != nil {
		return fmt.Errorf("database link listener holder did not start: %w", err)
	}
	logger.Info("database link listeners open before Docker", "listeners", len(files))
	return nil
}

// serveLinkListenerHandover is the holder: descriptor 3 reports readiness, 4 on are the listeners named by
// linkListenerHolderEnv. It hands them all to the first daemon process that asks, or closes them after
// linkListenerBootHold.
func serveLinkListenerHandover(stateDir string, logger *slog.Logger) error {
	var names []string
	if err := json.Unmarshal([]byte(os.Getenv(linkListenerHolderEnv)), &names); err != nil {
		return fmt.Errorf("read the held listeners: %w", err)
	}
	_ = os.Unsetenv(linkListenerHolderEnv)
	ready := os.NewFile(3, "ready")
	files := make([]*os.File, len(names))
	for index := range names {
		files[index] = os.NewFile(uintptr(4+index), names[index])
	}
	return holdLinkListeners(stateDir, names, files, linkListenerBootHold, func() {
		_, _ = ready.Write([]byte{1})
		_ = ready.Close()
	}, logger)
}

// holdLinkListeners keeps files (the listeners named by names) and hands them all to the first daemon process that
// asks within hold; ready runs once it accepts requests.
func holdLinkListeners(stateDir string, names []string, files []*os.File, hold time.Duration, ready func(), logger *slog.Logger) error {
	defer func() {
		for _, file := range files {
			_ = file.Close()
		}
	}()
	directory := filepath.Join(stateDir, linkListenerBootDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	path := linkListenerBootPath(stateDir, linkListenerHandoverFile)
	_ = os.Remove(path)
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: path, Net: "unixpacket"})
	if err != nil {
		return fmt.Errorf("listen for the link listener handover: %w", err)
	}
	defer listener.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	ready()
	_ = listener.SetDeadline(time.Now().Add(hold))
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			logger.Warn("no daemon took over the database link listeners held at boot; they close", "listeners", len(files), "error", err)
			return nil
		}
		if !linkListenerPeerAllowed(connection, directory) {
			_ = connection.Close()
			continue
		}
		err = sendLinkListeners(connection, names, files)
		_ = connection.Close()
		if err != nil {
			logger.Warn("database link listener handover failed", "error", err)
			continue
		}
		return nil
	}
}

func sendLinkListeners(connection *net.UnixConn, names []string, files []*os.File) error {
	_ = connection.SetWriteDeadline(time.Now().Add(linkListenerHandoverWait))
	for start := 0; start < len(names) || start == 0; start += linkListenerHandoverBatch {
		end := min(start+linkListenerHandoverBatch, len(names))
		message, _ := json.Marshal(linkListenerHandoverMessage{Names: names[start:end], Last: end == len(names)})
		descriptors := make([]int, 0, end-start)
		for _, file := range files[start:end] {
			descriptors = append(descriptors, int(file.Fd()))
		}
		if _, _, err := connection.WriteMsgUnix(message, syscall.UnixRights(descriptors...), nil); err != nil {
			return err
		}
		if end == len(names) {
			return nil
		}
	}
	return nil
}

// takeBootHeldListeners asks the boot step's holder for the host listeners it opened before Docker; none when no
// holder runs.
func takeBootHeldListeners(stateDir string, logger *slog.Logger) map[string]*os.File {
	path := linkListenerBootPath(stateDir, linkListenerHandoverFile)
	if _, err := os.Lstat(path); err != nil {
		return nil
	}
	connection, err := net.DialTimeout("unixpacket", path, linkListenerHandoverWait)
	if err != nil {
		return nil
	}
	defer connection.Close()
	unixConnection := connection.(*net.UnixConn)
	_ = unixConnection.SetReadDeadline(time.Now().Add(linkListenerHandoverWait))
	held := map[string]*os.File{}
	buffer := make([]byte, 64*1024)
	oob := make([]byte, syscall.CmsgSpace(linkListenerHandoverBatch*4))
	for {
		n, oobn, _, _, err := unixConnection.ReadMsgUnix(buffer, oob)
		if err != nil {
			logger.Warn("database link listener handover from the boot step failed", "error", err)
			break
		}
		received := receivedDescriptors(oob[:oobn])
		var message linkListenerHandoverMessage
		if json.Unmarshal(buffer[:n], &message) != nil || len(message.Names) != len(received) {
			for _, file := range received {
				_ = file.Close()
			}
			logger.Warn("database link listener handover from the boot step was malformed")
			break
		}
		for index, name := range message.Names {
			held[name] = received[index]
		}
		if message.Last {
			break
		}
	}
	if len(held) > 0 {
		logger.Info("took over the database link listeners opened before Docker", "listeners", len(held))
	}
	return held
}

func receivedDescriptors(oob []byte) []*os.File {
	messages, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	var files []*os.File
	for _, message := range messages {
		descriptors, err := syscall.ParseUnixRights(&message)
		if err != nil {
			continue
		}
		for _, descriptor := range descriptors {
			syscall.CloseOnExec(descriptor)
			files = append(files, os.NewFile(uintptr(descriptor), "held-listener"))
		}
	}
	return files
}

// restoreDatabaseListeners opens the host listeners of the restored grant bundle at start: on the sockets the previous
// process kept and the boot step held where there are any. A kept socket whose binding could not be verified now waits
// for the next sync (keptListenerAdoptionWindow); every other unclaimed one closes.
func (p *DockerPlugin) restoreDatabaseListeners(ctx context.Context) {
	m := p.databaseListeners
	m.adoptKeptListeners(takeBootHeldListeners(p.cfg.StateDir, p.logger))
	bundle := p.relayGrants.get()
	desired, _ := m.desired(bundle)
	waiting := map[string]bool{}
	for bindingID, status := range m.reconcile(ctx, bundle) {
		if status.State != "error" {
			continue
		}
		p.logger.Warn("managed database host listener restore deferred", "binding_id", bindingID, "error", status.Error)
		if config, ok := desired[bindingID]; ok {
			waiting[hostListenerKeepName(config.listenAddress, config.listenPort)] = true
		}
	}
	m.releaseAdopted(waiting)
	go p.ensureLinkListenerBootUnit()
	// Once the start is confirmed the pre-Opfield boot unit goes (renamed_boot_units.go).
	linkListenerBootRenameOnce.Do(func() { lifecycle.OnStartConfirmed(p.ensureLinkListenerBootUnit) })
}

var linkListenerBootRenameOnce sync.Once

func systemdLinkListenerUnit(host volumeImageBootHost, executable, stateDir string) string {
	return `[Unit]
Description=Opfield database link listeners: listen before Docker starts containers
After=local-fs.target
Before=docker.service
` + systemdLegacyGuard(host, legacyLinkListenerBootService) + `

[Service]
Type=forking
ExecStart=` + strconv.Quote(executable) + ` hold-link-listeners --state-dir ` + strconv.Quote(stateDir) + `
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target docker.service
`
}

func openrcLinkListenerService(host volumeImageBootHost, executable, stateDir string) string {
	return `#!/sbin/openrc-run
description="Opfield database link listeners: listen before Docker starts containers"

depend() {
	need localmount
	before docker
}

start() {
` + openrcLegacyGuard(host, legacyLinkListenerBootService) + `	ebegin "Opening Opfield database link listeners"
	` + shellQuote(executable) + ` hold-link-listeners --state-dir ` + shellQuote(stateDir) + `
	eend $?
}
`
}

// installLinkListenerBootUnit installs or updates the boot step that opens the database link listeners before Docker.
func installLinkListenerBootUnit(host volumeImageBootHost, executable, stateDir string) error {
	switch {
	case host.systemd:
		path := filepath.Join(host.systemdDir, linkListenerBootService+".service")
		changed, err := writeFileIfChanged(path, systemdLinkListenerUnit(host, executable, stateDir), 0o644)
		if err != nil {
			return err
		}
		if changed {
			if err := host.run("systemctl", "daemon-reload"); err != nil {
				return err
			}
		}
		if changed || host.run("systemctl", "is-enabled", "--quiet", linkListenerBootService+".service") != nil {
			if err := host.run("systemctl", "enable", "--quiet", linkListenerBootService+".service"); err != nil {
				return err
			}
		}
		return retireLegacyBootUnit(host, legacyLinkListenerBootService)
	case host.openrc:
		path := filepath.Join(host.openrcDir, linkListenerBootService)
		changed, err := writeFileIfChanged(path, openrcLinkListenerService(host, executable, stateDir), 0o755)
		if err != nil {
			return err
		}
		if _, err := os.Lstat(filepath.Join(host.runlevels, "boot", linkListenerBootService)); err != nil {
			if err := host.run("rc-update", "add", linkListenerBootService, "boot"); err != nil {
				return err
			}
		}
		if changed {
			// OpenRC's dependency cache must know the script at the next boot
			// (it compares mtimes in whole seconds).
			if err := host.run("rc-update", "-u"); err != nil {
				return err
			}
		}
		return retireLegacyBootUnit(host, legacyLinkListenerBootService)
	default:
		return errors.New("no systemd or OpenRC: database link listeners open after Docker at boot")
	}
}

func (p *DockerPlugin) ensureLinkListenerBootUnit() {
	if runsWithoutRoot() {
		// The boot step runs as root before Docker; a daemon without root can neither install it nor may it point
		// root at a binary its own user can replace.
		linkListenerBootSkipped.Do(func() {
			p.logger.Info("database link listener boot step unavailable: it needs docker-daemon to run as root; after a reboot workloads may be refused until the daemon listens", "user", runUserName())
		})
		return
	}
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err == nil {
		err = installLinkListenerBootUnit(systemVolumeImageBootHost(), executable, p.cfg.StateDir)
	}
	if err != nil {
		p.logger.Warn("database link listener boot step not installed; after a reboot workloads may be refused until the daemon listens", "error", err)
	}
}
