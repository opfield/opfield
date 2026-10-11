package supervisor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

var sigterm os.Signal = syscall.SIGTERM

const (
	// witnessUser runs every witness when the supervisor runs as root.
	witnessUser = "gateway-witness"
	// witnessRootDir holds artifacts and data a root supervisor shares with
	// the witness user; the supervisor's own state directory stays 0700.
	witnessRootDir = "/var/lib/gateway-relay-witness"
	// witnessMemoryMax caps a witness (systemd scope MemoryMax; the Keeper's
	// own soft limit below it everywhere).
	witnessMemoryMax       = 512 << 20
	witnessKeeperSoftLimit = 448 << 20
)

// hostWitnessRuntime runs witnesses on this host.
type hostWitnessRuntime struct {
	root    string
	logger  *slog.Logger
	fetcher *witnessFetcher
	// dialRoute opens RelayAdmin.DialRoute on the worker.
	dialRoute func(ctx context.Context) (relayv1.RelayAdmin_DialRouteClient, error)

	mu      sync.Mutex
	account *witnessAccount
}

type witnessAccount struct {
	uid, gid uint32
}

// newHostWitnessRuntime picks where witnesses live: a root supervisor shares
// witnessRootDir with the unprivileged witness user; any other supervisor
// runs witnesses as itself under its own state directory.
func newHostWitnessRuntime(stateDir string, logger *slog.Logger, dialRoute func(ctx context.Context) (relayv1.RelayAdmin_DialRouteClient, error)) *hostWitnessRuntime {
	root := filepath.Join(stateDir, "witness")
	if os.Geteuid() == 0 {
		root = witnessRootDir
	}
	return &hostWitnessRuntime{root: root, logger: logger, fetcher: newWitnessFetcher(filepath.Join(root, "artifacts")), dialRoute: dialRoute}
}

func (r *hostWitnessRuntime) fetch(ctx context.Context, artifact *pb.WitnessArtifact) (string, error) {
	return r.fetcher.fetch(ctx, artifact)
}

func (r *hostWitnessRuntime) gcArtifacts(keep map[string]bool, now time.Time) {
	r.fetcher.collect(keep, now)
}

// ensureAccount creates the witness user on first use (root only).
func (r *hostWitnessRuntime) ensureAccount() (*witnessAccount, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if os.Geteuid() != 0 {
		return nil, nil
	}
	if r.account != nil {
		return r.account, nil
	}
	found, err := user.Lookup(witnessUser)
	if err != nil {
		if err := createWitnessUser(); err != nil {
			return nil, err
		}
		if found, err = user.Lookup(witnessUser); err != nil {
			return nil, fmt.Errorf("look up %s: %w", witnessUser, err)
		}
	}
	uid, err := strconv.ParseUint(found.Uid, 10, 32)
	if err != nil {
		return nil, err
	}
	gid, err := strconv.ParseUint(found.Gid, 10, 32)
	if err != nil {
		return nil, err
	}
	if uid == 0 {
		return nil, fmt.Errorf("%s must not be root", witnessUser)
	}
	r.account = &witnessAccount{uid: uint32(uid), gid: uint32(gid)}
	return r.account, nil
}

func createWitnessUser() error {
	nologin := "/usr/sbin/nologin"
	if _, err := os.Stat(nologin); err != nil {
		nologin = "/sbin/nologin"
	}
	if path, err := exec.LookPath("useradd"); err == nil {
		output, err := exec.Command(path, "--system", "--user-group", "--no-create-home", "--home-dir", witnessRootDir, "--shell", nologin, witnessUser).CombinedOutput()
		if err != nil {
			return fmt.Errorf("create %s: %v: %s", witnessUser, err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	if path, err := exec.LookPath("adduser"); err == nil {
		// BusyBox (Alpine): a system user and its group.
		if group, err := exec.LookPath("addgroup"); err == nil {
			_ = exec.Command(group, "-S", witnessUser).Run()
		}
		output, err := exec.Command(path, "-S", "-D", "-H", "-h", witnessRootDir, "-s", nologin, "-G", witnessUser, witnessUser).CombinedOutput()
		if err != nil {
			return fmt.Errorf("create %s: %v: %s", witnessUser, err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	return fmt.Errorf("create %s: neither useradd nor adduser is available", witnessUser)
}

func (r *hostWitnessRuntime) start(launch witnessLaunch) (witnessProcess, error) {
	account, err := r.ensureAccount()
	if err != nil {
		return nil, err
	}
	// The data and config directories belong to the witness, the binary
	// stays root-owned and read-only for it.
	for _, dir := range []string{r.root, filepath.Dir(launch.dataDir), filepath.Dir(launch.runDir)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		_ = os.Chmod(dir, 0o755)
	}
	if err := os.MkdirAll(launch.dataDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(launch.runDir, 0o750); err != nil {
		return nil, err
	}
	configPath := filepath.Join(launch.runDir, "keeper.xml")
	if err := os.WriteFile(configPath, launch.config, 0o640); err != nil {
		return nil, err
	}
	if account != nil {
		for _, path := range []string{launch.dataDir, launch.runDir, configPath} {
			if err := os.Lchown(path, int(account.uid), int(account.gid)); err != nil {
				return nil, err
			}
		}
		if err := chownTree(launch.dataDir, account); err != nil {
			return nil, err
		}
	}
	args := []string{"--config-file=" + configPath}
	var cmd *exec.Cmd
	scope := witnessScopeName(launch.id)
	if account != nil && systemdAvailable() {
		// A transient scope caps memory; the witness still runs as the
		// unprivileged user.
		_ = exec.Command("systemctl", "stop", scope).Run()
		cmd = exec.Command("systemd-run", append([]string{
			"--scope", "--quiet", "--collect", "--unit=" + scope,
			"--property=MemoryMax=" + strconv.Itoa(witnessMemoryMax), "--property=MemorySwapMax=0",
			"--uid=" + strconv.FormatUint(uint64(account.uid), 10), "--gid=" + strconv.FormatUint(uint64(account.gid), 10),
			"--", launch.binary}, args...)...)
		cmd.SysProcAttr = witnessProcAttr(nil, false)
	} else {
		var credential *syscall.Credential
		if account != nil {
			credential = &syscall.Credential{Uid: account.uid, Gid: account.gid}
		}
		cmd = exec.Command(launch.binary, args...)
		cmd.SysProcAttr = witnessProcAttr(credential, true)
	}
	cmd.Dir = launch.dataDir
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=" + launch.dataDir, "TZ=UTC"}
	output := &witnessOutput{logger: r.logger, id: launch.id}
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	proc := &hostWitnessProcess{cmd: cmd, exited: make(chan struct{}), output: output}
	go func() {
		proc.err = cmd.Wait()
		close(proc.exited)
	}()
	return proc, nil
}

func witnessScopeName(id string) string {
	if len(id) > 32 {
		id = id[:32]
	}
	return "gateway-witness-" + id + ".scope"
}

func systemdAvailable() bool {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return false
	}
	_, err := exec.LookPath("systemd-run")
	return err == nil
}

func chownTree(root string, account *witnessAccount) error {
	return filepath.Walk(root, func(path string, _ os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, int(account.uid), int(account.gid))
	})
}

type hostWitnessProcess struct {
	cmd    *exec.Cmd
	exited chan struct{}
	err    error
	output *witnessOutput
}

func (p *hostWitnessProcess) done() <-chan struct{} { return p.exited }

func (p *hostWitnessProcess) exitError() error {
	select {
	case <-p.exited:
	default:
		return nil
	}
	if p.err == nil {
		return nil
	}
	if last := p.output.last(); last != "" {
		return fmt.Errorf("%w (last output: %s)", p.err, last)
	}
	return p.err
}

func (p *hostWitnessProcess) signal(signal os.Signal) error { return p.cmd.Process.Signal(signal) }
func (p *hostWitnessProcess) kill() error                   { return p.cmd.Process.Kill() }

// witnessOutput forwards a witness's output lines to the supervisor log at
// debug level and keeps the last line for error reports.
type witnessOutput struct {
	logger *slog.Logger
	id     string
	mu     sync.Mutex
	buffer []byte
	line   string
}

func (o *witnessOutput) Write(data []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.buffer = append(o.buffer, data...)
	for {
		cut := bytes.IndexByte(o.buffer, '\n')
		if cut < 0 {
			break
		}
		line := strings.TrimSpace(string(o.buffer[:cut]))
		o.buffer = o.buffer[cut+1:]
		if line == "" {
			continue
		}
		if len(line) > 512 {
			line = line[:512]
		}
		o.line = line
		if o.logger != nil {
			o.logger.Debug("witness output", "witness", o.id, "line", line)
		}
	}
	if len(o.buffer) > 64<<10 {
		o.buffer = o.buffer[len(o.buffer)-(64<<10):]
	}
	return len(data), nil
}

func (o *witnessOutput) last() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.line
}

// probe asks the Keeper's client port for its state (four-letter srvr).
func (r *hostWitnessRuntime) probe(ctx context.Context, clientPort uint32) (keeperProbe, error) {
	return probeKeeper(ctx, fmt.Sprintf("127.0.0.1:%d", clientPort))
}

func probeKeeper(ctx context.Context, address string) (keeperProbe, error) {
	var dialer net.Dialer
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return keeperProbe{}, err
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if _, err := connection.Write([]byte("srvr")); err != nil {
		return keeperProbe{}, err
	}
	data, err := io.ReadAll(io.LimitReader(connection, 64<<10))
	if err != nil && len(data) == 0 {
		return keeperProbe{}, err
	}
	return parseKeeperSrvr(string(data))
}

// parseKeeperSrvr reads "Mode:" and "Zxid:" from a srvr answer.
func parseKeeperSrvr(answer string) (keeperProbe, error) {
	var probe keeperProbe
	modeSeen := false
	scanner := bufio.NewScanner(strings.NewReader(answer))
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		switch strings.TrimSpace(key) {
		case "Mode":
			probe.role, modeSeen = value, true
		case "Zxid":
			if parsed, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(value), "0x"), 16, 64); err == nil {
				probe.zxid = parsed
			}
		}
	}
	if !modeSeen {
		return keeperProbe{}, errors.New("keeper did not report its mode (no quorum yet?)")
	}
	return probe, nil
}

// forward listens on a peer's loopback address and carries every connection
// over a relay-originated tunnel on the peer's route.
func (r *hostWitnessRuntime) forward(ctx context.Context, peer *pb.WitnessPeer) (net.Listener, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort(peer.GetHost(), strconv.FormatUint(uint64(peer.GetPort()), 10)))
	if err != nil {
		return nil, err
	}
	routeID, generation := peer.GetRouteId(), peer.GetAssignmentGeneration()
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go r.carry(connection, routeID, generation)
		}
	}()
	return listener, nil
}

// carry opens the tunnel and bridges one connection over it.
func (r *hostWitnessRuntime) carry(connection net.Conn, routeID string, generation uint64) {
	defer connection.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := r.dialRoute(ctx)
	if err != nil {
		r.debug("witness tunnel could not open", "route", routeID, "error", err)
		return
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Dial{Dial: &relayv1.DialRoute{RouteId: routeID, AssignmentGeneration: generation}}}); err != nil {
		r.debug("witness tunnel could not open", "route", routeID, "error", err)
		return
	}
	readyCtx, readyCancel := context.WithTimeout(ctx, 15*time.Second)
	defer readyCancel()
	ready := make(chan *relayv1.TunnelFrame, 1)
	failed := make(chan error, 1)
	go func() {
		frame, err := stream.Recv()
		if err != nil {
			failed <- err
			return
		}
		ready <- frame
	}()
	var maxFrame int
	select {
	case frame := <-ready:
		if frame.GetReady() == nil {
			r.debug("witness tunnel refused", "route", routeID, "frame", frame.String())
			return
		}
		maxFrame = int(frame.GetReady().GetMaxFrameBytes())
	case err := <-failed:
		r.debug("witness tunnel refused", "route", routeID, "error", err)
		return
	case <-readyCtx.Done():
		r.debug("witness tunnel was not ready in time", "route", routeID)
		return
	}
	_ = relaybridge.Bridge(ctx, connection, stream, maxFrame, cancel)
}

func (r *hostWitnessRuntime) debug(message string, args ...any) {
	if r.logger != nil {
		r.logger.Debug(message, args...)
	}
}

// renderKeeperConfig writes the Keeper configuration of a witness. Every
// value comes from a validated spec: ports, loopback hosts, server ids and
// the witness's own data directory.
func renderKeeperConfig(spec *pb.WitnessSpec, dataDir string) ([]byte, error) {
	type server struct {
		ID       uint32 `xml:"id"`
		Hostname string `xml:"hostname"`
		Port     uint32 `xml:"port"`
	}
	raftHost := spec.GetRaftHost()
	if raftHost == "" {
		raftHost = "127.0.0.1"
	}
	servers := []server{{ID: spec.GetServerId(), Hostname: raftHost, Port: spec.GetRaftPort()}}
	for _, peer := range spec.GetPeers() {
		servers = append(servers, server{ID: peer.GetServerId(), Hostname: peer.GetHost(), Port: peer.GetPort()})
	}
	type coordination struct {
		OperationTimeoutMs int    `xml:"operation_timeout_ms"`
		SessionTimeoutMs   int    `xml:"session_timeout_ms"`
		RaftLogsLevel      string `xml:"raft_logs_level"`
	}
	type keeperServer struct {
		TCPPort                 uint32       `xml:"tcp_port"`
		ServerID                uint32       `xml:"server_id"`
		LogStoragePath          string       `xml:"log_storage_path"`
		SnapshotStoragePath     string       `xml:"snapshot_storage_path"`
		EnableReconfiguration   bool         `xml:"enable_reconfiguration"`
		FourLetterWordWhiteList string       `xml:"four_letter_word_white_list"`
		MaxMemoryUsageSoftLimit int          `xml:"max_memory_usage_soft_limit"`
		Coordination            coordination `xml:"coordination_settings"`
		Servers                 []server     `xml:"raft_configuration>server"`
	}
	type logger struct {
		Level   string `xml:"level"`
		Console int    `xml:"console"`
	}
	type document struct {
		XMLName    xml.Name     `xml:"clickhouse"`
		Logger     logger       `xml:"logger"`
		ListenHost string       `xml:"listen_host"`
		Path       string       `xml:"path"`
		Keeper     keeperServer `xml:"keeper_server"`
	}
	value := document{
		Logger:     logger{Level: "information", Console: 1},
		ListenHost: "127.0.0.1",
		Path:       dataDir,
		Keeper: keeperServer{
			TCPPort: spec.GetClientPort(), ServerID: spec.GetServerId(),
			LogStoragePath: filepath.Join(dataDir, "coordination", "log"), SnapshotStoragePath: filepath.Join(dataDir, "coordination", "snapshots"),
			EnableReconfiguration: true, FourLetterWordWhiteList: "ruok,srvr,mntr,conf,isro",
			MaxMemoryUsageSoftLimit: witnessKeeperSoftLimit,
			Coordination:            coordination{OperationTimeoutMs: 10000, SessionTimeoutMs: 30000, RaftLogsLevel: "warning"},
			Servers:                 servers,
		},
	}
	encoded, err := xml.MarshalIndent(value, "", "    ")
	if err != nil {
		return nil, err
	}
	return append(append([]byte(xml.Header), encoded...), '\n'), nil
}
