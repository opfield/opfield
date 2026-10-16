package docker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/docker-daemon/internal/lease"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
	"github.com/opfield/opfield/docker-daemon/internal/swha"
)

// SeaweedFS availability set members (P2-T05). A storage-profile node runs one
// member of a set as three containers on the set's private network (the
// member mesh, set_member_mesh.go): the volume server, the filer with S3 (the
// record's container: links, IAM and certificate reloads use it as for a
// single node) and the master, which only the primary runs. The member
// runtime (internal/memberha) drives them through the swha engine; this file
// creates and replaces the containers (payload version 3) and adapts the
// docker daemon to swha.Host.
//
// Single-node storages are unchanged (payload versions 1 and 2).

const (
	managedStorageSetPayloadVersion = 3
	managedStorageRoleLabel         = "net.opfield.managed-storage.role"
	seaweedfsSetMasterDataDir       = "/run/gateway-master"
	seaweedfsSetStateRoot           = "seaweedfs-set"
	seaweedfsSetHostsFile           = "hosts"
	setFilerTokenLifetime           = 2 * time.Minute
)

var seaweedfsFilerKeyPattern = regexp.MustCompile(`key\s*=\s*"([0-9a-f]{16,128})"`)

func init() {
	RegisterSetMemberEngine(managedStorageEngineSeaweedFS, func(p *DockerPlugin, config memberha.Config) (memberha.Engine, error) {
		if p.storageManager == nil {
			return nil, errors.New("this daemon does not run managed storage")
		}
		host, err := newSeaweedFSSetHost(p, config)
		if err != nil {
			return nil, err
		}
		return swha.New(host)
	})
}

// managedStorageSetCommand names this node's member of a SeaweedFS set.
type managedStorageSetCommand struct {
	SetID       string                    `json:"setId"`
	MemberID    string                    `json:"memberId"`
	MemberIndex uint32                    `json:"memberIndex"`
	Members     []managedStorageSetMember `json:"members"`
	// Origin: this node serves the storage as a single node now; the update
	// turns its container into the member layout without losing data.
	Origin bool `json:"origin,omitempty"`
	// ImageMove: recreate this member's containers on the daemon's pinned
	// image (a copy only; managed_storage_set_image_move.go).
	ImageMove bool `json:"imageMove,omitempty"`
}

type managedStorageSetMember struct {
	MemberID    string `json:"memberId"`
	MemberIndex uint32 `json:"memberIndex"`
}

// managedStorageSetRecord is the member part of a record.
type managedStorageSetRecord struct {
	SetID       string `json:"setId"`
	MemberID    string `json:"memberId"`
	MemberIndex uint32 `json:"memberIndex"`
}

func validateSeaweedFSSetCommand(input managedStorageCommand, creating bool) error {
	set := input.Set
	if set == nil {
		return errors.New("managed storage config version 3 needs the availability set member")
	}
	if !uuidLike(set.SetID) || !uuidLike(set.MemberID) {
		return errors.New("availability set and member ids must be UUIDs")
	}
	if set.MemberIndex > swha.MaxMemberIndex {
		return fmt.Errorf("availability member index must be at most %d", swha.MaxMemberIndex)
	}
	self := false
	indexes := map[uint32]bool{}
	for _, member := range set.Members {
		if !uuidLike(member.MemberID) || member.MemberIndex > swha.MaxMemberIndex || indexes[member.MemberIndex] {
			return errors.New("availability set members are invalid")
		}
		indexes[member.MemberIndex] = true
		if member.MemberID == set.MemberID {
			self = member.MemberIndex == set.MemberIndex
		}
	}
	if !self {
		return errors.New("the member must be listed among the set's members")
	}
	if input.FTP != nil || input.SFTP != nil || input.PeerBindAddress != "" || len(input.Members) > 0 {
		return errors.New("a SeaweedFS set member takes no FTP, SFTP, peer address or MinIO members")
	}
	if input.PublishS3 != (input.PublishedPort != 0) {
		return errors.New("public managed storage requires a published port, private storage none")
	}
	if err := validateManagedStorageTransport(input); err != nil {
		return err
	}
	if input.Image != "" && !isTrustedSeaweedFSImage(input.Image) {
		return errors.New("managed storage image must be the trusted digest-pinned SeaweedFS image")
	}
	if !creating {
		if input.RootCredentials.AccessKey != "" || input.RootCredentials.SecretKey != "" {
			return validateSeaweedFSRootCredentials(input.RootCredentials)
		}
		return nil
	}
	if input.ImageCatalogID != seaweedfsCatalogID {
		return errors.New("managed storage catalog id must be " + seaweedfsCatalogID)
	}
	if err := validateSeaweedFSRootCredentials(input.RootCredentials); err != nil {
		return err
	}
	return validateManagedStorageResources(input.Resources, minimumSeaweedFSMemoryBytes)
}

func setMemberRefs(members []managedStorageSetMember) []swha.MemberRef {
	out := make([]swha.MemberRef, 0, len(members))
	for _, member := range members {
		out = append(out, swha.MemberRef{ID: member.MemberID, Index: member.MemberIndex})
	}
	return out
}

func seaweedfsSetContainerName(prefix, id string, index uint32, role swha.Role) string {
	base := fmt.Sprintf("%s%s-%d", prefix, id, index)
	if role == swha.RoleFiler {
		return base
	}
	return base + "-" + string(role)
}

func (m *managedStorageManager) seaweedfsSetDir(id string, index uint32) string {
	return filepath.Join(m.root, "storage", seaweedfsSetStateRoot, fmt.Sprintf("%s-%d", id, index))
}

// seaweedfsSetMemberRecord is the record of a member that runs here, by role
// container name (the filer is the record's container).
func (record managedStorageRecord) isSetMember() bool { return record.Set != nil }

// mesh is the plugin's member mesh (nil in tests without a plugin).
func (m *managedStorageManager) mesh() *setMesh {
	if m.plugin == nil {
		return nil
	}
	return m.plugin.setMesh()
}

// prepareSetNetwork creates the set's network, its mesh listeners and the
// member's hosts file (the mesh hosts at the network's gateway).
func (m *managedStorageManager) prepareSetNetwork(ctx context.Context, id string, set managedStorageSetCommand) (string, error) {
	mesh := m.mesh()
	if mesh == nil {
		return "", errors.New("the availability member mesh is not running")
	}
	networkName, err := mesh.Ensure(ctx, set.SetID)
	if err != nil {
		return "", err
	}
	exposures := swha.Exposures(set.MemberID, setMemberRefs(set.Members))
	for _, exposure := range exposures {
		mesh.Expose(set.SetID, exposure.Host, exposure.Port, exposure.Alias)
	}
	gateway, ok := mesh.Gateway(set.SetID)
	if !ok {
		return "", errors.New("the availability set network has no gateway address")
	}
	if _, err := m.writeSetHosts(id, set.MemberIndex, gateway, exposures); err != nil {
		return "", err
	}
	return networkName, nil
}

// writeSetHosts writes the member's /etc/hosts (mounted into its containers):
// every mesh host at the set network's gateway. It is rewritten in place when
// the members change, so the containers resolve a new member without being
// recreated (Go reads /etc/hosts again once it changed).
func (m *managedStorageManager) writeSetHosts(id string, index uint32, gateway netip.Addr, exposures []swha.Exposure) (string, error) {
	dir := m.seaweedfsSetDir(id, index)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return "", err
	}
	hosts := map[string]bool{}
	for _, exposure := range exposures {
		hosts[exposure.Host] = true
	}
	names := make([]string, 0, len(hosts))
	for host := range hosts {
		names = append(names, host)
	}
	sort.Strings(names)
	content := "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n"
	for _, name := range names {
		content += gateway.String() + "\t" + name + "\n"
	}
	path := filepath.Join(dir, seaweedfsSetHostsFile)
	if current, err := os.ReadFile(path); err == nil && string(current) == content {
		return path, nil
	}
	// In place: the file is bind-mounted, a rename would leave the containers
	// on the old inode.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", err
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		return "", err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return "", err
	}
	return path, file.Close()
}

// stageSeaweedFSSet stages the member's runtime tree: the single-node files,
// the master's snowflake sequencer, and a filer signing key that survives
// restaging (the running filer keeps the one it started with).
func (m *managedStorageManager) stageSeaweedFSSet(record managedStorageRecord, input managedStorageCommand) (string, error) {
	root := m.seaweedfsStagingDir(record)
	securityPath := filepath.Join(root, "config", "security.toml")
	keptSecurity, keptErr := os.ReadFile(securityPath)
	staging, err := m.stageSeaweedFS(record, input)
	if err != nil {
		return "", err
	}
	snowflake, err := swha.SnowflakeID(record.Set.MemberIndex)
	if err != nil {
		return "", err
	}
	configDir := filepath.Join(staging, "config")
	if err := m.openStagingDirs(staging, configDir); err != nil {
		return "", err
	}
	if keptErr == nil && seaweedfsFilerKeyPattern.Match(keptSecurity) {
		if err := m.writeRuntimeFile(securityPath, keptSecurity); err != nil {
			return "", err
		}
	}
	master := seaweedfsMasterConfig + fmt.Sprintf("\n[master.sequencer]\ntype = \"snowflake\"\nsequencer_snowflake_id = %d\n", snowflake)
	if err := m.writeRuntimeFile(filepath.Join(configDir, "master.toml"), []byte(master)); err != nil {
		return "", err
	}
	if err := m.sealStagingDirs(staging, configDir); err != nil {
		return "", err
	}
	return staging, nil
}

func seaweedfsSetVolumeCommand(record managedStorageRecord, set managedStorageSetRecord) []string {
	sizing := seaweedfsSizingFor(record.StorageBytes)
	httpPort, grpcPort := swha.VolumePorts(set.MemberIndex)
	limit := strconv.FormatInt(seaweedfsTransferLimitMiB(seaweedfsSetMemory(record.MemoryBytes, swha.RoleVolume)), 10)
	return []string{
		"-logtostderr=true", "-config_dir=" + seaweedfsContainerRoot + "/config", "volume",
		"-dir=/data", "-ip=" + swha.VolumeHost(set.MemberID), "-ip.bind=0.0.0.0",
		"-port=" + strconv.Itoa(int(httpPort)), "-port.grpc=" + strconv.Itoa(int(grpcPort)),
		"-mserver=" + swha.MasterAddress(),
		"-max=" + strconv.FormatInt(sizing.VolumeMax, 10),
		"-index=memory",
		"-minFreeSpace=" + strconv.FormatInt(sizing.MinFreeSpaceMiB, 10) + "MiB",
		"-concurrentUploadLimitMB=" + limit, "-concurrentDownloadLimitMB=" + limit,
		"-preStopSeconds=2",
	}
}

func seaweedfsSetFilerCommand(record managedStorageRecord, set managedStorageSetRecord) []string {
	httpPort, grpcPort := swha.FilerPorts(set.MemberIndex)
	args := []string{
		"-logtostderr=true", "-config_dir=" + seaweedfsContainerRoot + "/config", "filer",
		"-ip=" + swha.FilerHost(set.MemberID), "-ip.bind=0.0.0.0",
		"-port=" + strconv.Itoa(int(httpPort)), "-port.grpc=" + strconv.Itoa(int(grpcPort)),
		"-master=" + swha.MasterAddress(),
		// The single node's filer store (weed server -dir=/data) is
		// /data/filerldb2, so a converted node keeps its metadata.
		"-defaultStoreDir=/data",
		// 1 MiB chunks, as for a single node (seaweedfsCommand).
		"-maxMB=1",
		"-s3", "-s3.port=" + strconv.Itoa(swha.S3Port), "-s3.ip.bind=0.0.0.0",
		"-s3.config=" + seaweedfsContainerRoot + "/config/s3.json",
		"-s3.iam=true", "-s3.iam.readOnly=false", "-s3.allowDeleteBucketNotEmpty=false",
		"-s3.port.iceberg=0", "-s3.port.lance=0",
	}
	if record.TLSEnabled {
		args = append(args, "-s3.cert.file="+seaweedfsContainerRoot+"/tls/public.crt", "-s3.key.file="+seaweedfsContainerRoot+"/tls/private.key")
	}
	return args
}

func seaweedfsSetMasterCommand(record managedStorageRecord) []string {
	sizing := seaweedfsSizingFor(record.StorageBytes)
	return []string{
		"-logtostderr=true", "-config_dir=" + seaweedfsContainerRoot + "/config", "master",
		"-ip=" + swha.MasterHost, "-ip.bind=0.0.0.0",
		"-port=" + strconv.Itoa(swha.MasterHTTPPort), "-port.grpc=" + strconv.Itoa(swha.MasterGRPCPort),
		"-mdir=" + seaweedfsSetMasterDataDir, "-peers=none",
		"-defaultReplication=001", "-volumePreallocate=false",
		"-volumeSizeLimitMB=" + strconv.FormatInt(sizing.VolumeSizeLimitMB, 10),
	}
}

// seaweedfsSetMemory splits the storage's memory between the member's
// containers: volume server and filer 45 % each, master 10 % (each at least
// 128 MiB).
func seaweedfsSetMemory(memoryBytes int64, role swha.Role) int64 {
	share := int64(45)
	if role == swha.RoleMaster {
		share = 10
	}
	return max(128*mebibyte, memoryBytes*share/100)
}

func seaweedfsSetHealthcheck(role swha.Role, set managedStorageSetRecord, tlsEnabled bool) *container.HealthConfig {
	var test string
	switch role {
	case swha.RoleVolume:
		port, _ := swha.VolumePorts(set.MemberIndex)
		test = fmt.Sprintf("curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:%d/status", port)
	case swha.RoleFiler:
		port, _ := swha.FilerPorts(set.MemberIndex)
		s3 := fmt.Sprintf("curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:%d/healthz", swha.S3Port)
		if tlsEnabled {
			s3 = fmt.Sprintf("curl -fsSk -o /dev/null --max-time 3 https://127.0.0.1:%d/healthz", swha.S3Port)
		}
		test = fmt.Sprintf("curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:%d/healthz && %s", port, s3)
	default:
		test = fmt.Sprintf("curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:%d/cluster/healthz", swha.MasterHTTPPort)
	}
	return &container.HealthConfig{
		Test: []string{"CMD-SHELL", test}, Interval: 10 * time.Second, Timeout: 8 * time.Second,
		StartPeriod: 2 * time.Minute, StartInterval: 2 * time.Second, Retries: 3,
	}
}

// seaweedfsSetMasterTmpfs is the master's scratch directory: 64 MiB, mode
// 0700, owned by the runtime user the container runs as.
func seaweedfsSetMasterTmpfs() map[string]string {
	return map[string]string{seaweedfsSetMasterDataDir: fmt.Sprintf("rw,noexec,nosuid,nodev,size=%d,mode=0700,uid=%d,gid=%d",
		64*mebibyte, seaweedfsRuntimeUID, seaweedfsRuntimeGID)}
}

// createSetContainer creates one member container (not started).
func (m *managedStorageManager) createSetContainer(ctx context.Context, record managedStorageRecord, role swha.Role, setNetwork, staging, hostsPath string) (string, error) {
	set := *record.Set
	var cmd []string
	aliases := []string{}
	binds := []string{staging + ":" + seaweedfsContainerRoot + ":ro", hostsPath + ":/etc/hosts:ro"}
	var tmpfs map[string]string
	restart := engineRestartPolicy
	switch role {
	case swha.RoleVolume:
		cmd = seaweedfsSetVolumeCommand(record, set)
		aliases = append(aliases, swha.VolumeHost(set.MemberID))
		binds = append(binds, record.MountPath+":/data")
	case swha.RoleFiler:
		cmd = seaweedfsSetFilerCommand(record, set)
		aliases = append(aliases, swha.FilerHost(set.MemberID))
		binds = append(binds, record.MountPath+":/data")
	case swha.RoleMaster:
		cmd = seaweedfsSetMasterCommand(record)
		// The master runs as the SeaweedFS runtime user: its scratch tmpfs is
		// that user's (a root-owned 0700 tmpfs made it exit at once).
		tmpfs = seaweedfsSetMasterTmpfs()
		restart = container.RestartPolicy{Name: container.RestartPolicyDisabled}
	}
	memory := seaweedfsSetMemory(record.MemoryBytes, role)
	containerCfg := &container.Config{
		Image: record.Image, User: fmt.Sprintf("%d:%d", seaweedfsRuntimeUID, seaweedfsRuntimeGID),
		Entrypoint: []string{"/usr/bin/weed"}, Cmd: cmd,
		Env: []string{seaweedfsMemoryLimitEnv(memory), "WEED_TLS_CERT_REFRESH_INTERVAL=" + seaweedfsTLSRefreshInterval},
		Labels: map[string]string{
			managedStorageLabel: record.ID, managedStorageMemberLabel: strconv.Itoa(record.MemberIndex),
			managedStorageEngineLabel: managedStorageEngineSeaweedFS, managedStorageRoleLabel: string(role),
			"net.opfield.availability-set": set.SetID,
		},
		Healthcheck: seaweedfsSetHealthcheck(role, set, record.TLSEnabled),
	}
	swap := record.MemorySwapBytes
	if swap != 0 {
		swap = max(swap*memory/max(record.MemoryBytes, 1), memory)
	}
	hostCfg := &container.HostConfig{
		Binds: binds, Tmpfs: tmpfs, RestartPolicy: restart,
		Resources:   container.Resources{Memory: memory, MemorySwap: swap, NanoCPUs: record.NanoCPUs},
		LogConfig:   container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}},
		CapDrop:     []string{"ALL"},
		SecurityOpt: []string{"no-new-privileges:true"},
		Sysctls:     seaweedfsSysctls(),
	}
	created, err := m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: containerCfg, HostConfig: hostCfg, Name: seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, role),
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{setNetwork: {Aliases: aliases}}},
	})
	if err != nil {
		return "", fmt.Errorf("create the SeaweedFS %s container: %w", role, err)
	}
	if role == swha.RoleFiler {
		// Links and Opfield's tools reach S3 on the storage network, as for a
		// single node.
		if _, err := m.client.cli.NetworkConnect(ctx, record.NetworkName, mobyclient.NetworkConnectOptions{
			Container: created.ID, EndpointConfig: &network.EndpointSettings{Aliases: []string{"s3"}},
		}); err != nil {
			_ = m.client.RemoveContainer(ctx, created.ID, true)
			return "", fmt.Errorf("attach the SeaweedFS filer to the storage network: %w", err)
		}
	}
	return created.ID, nil
}

// createSetNetworkForStorage creates the storage network of a set member:
// always internal (direct publication is the member proxy, not a port binding).
func (m *managedStorageManager) createSetStorageNetwork(ctx context.Context, record managedStorageRecord) error {
	if _, err := m.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{}); err == nil {
		return nil
	}
	if _, err := m.client.cli.NetworkCreate(ctx, record.NetworkName, mobyclient.NetworkCreateOptions{
		Driver: "bridge", Internal: true, Labels: map[string]string{managedStorageLabel: record.ID},
	}); err != nil {
		return fmt.Errorf("create managed storage network: %w", err)
	}
	return nil
}

// createSetMember creates a new member of a set (a copy): its disk, staged
// files and containers; the volume server and filer start, the master is only
// created. The member runtime takes it over once Opfield configures it.
func (m *managedStorageManager) createSetMember(ctx context.Context, id string, input managedStorageCommand) (managedStorageRecord, error) {
	set := *input.Set
	input.MemberIndex = int(set.MemberIndex)
	if existing, err := m.loadRecord(id); err == nil {
		if existing.OperationID != input.OperationID || existing.OperationID == "" || existing.Set == nil ||
			existing.Set.MemberID != set.MemberID {
			return managedStorageRecord{}, errors.New("managed storage id is already allocated")
		}
		return existing, m.ensureSetContainers(ctx, &existing, input)
	} else if !errors.Is(err, os.ErrNotExist) {
		return managedStorageRecord{}, err
	}
	release, err := m.reserveCapacity(input.Resources.StorageBytes)
	if err != nil {
		return managedStorageRecord{}, err
	}
	defer release()
	image, err := m.ensureEngineImage(ctx, managedStorageEngineSeaweedFS)
	if err != nil {
		return managedStorageRecord{}, err
	}
	record := m.newRecord(id, input, image)
	record.PublishS3, record.PublishedPort = input.PublishS3, input.PublishedPort
	record.Set = &managedStorageSetRecord{SetID: set.SetID, MemberID: set.MemberID, MemberIndex: set.MemberIndex}
	if err := m.cleanupStorage(ctx, &record, true); err != nil {
		return managedStorageRecord{}, err
	}
	if err := m.createImage(ctx, record); err != nil {
		return managedStorageRecord{}, err
	}
	created := false
	defer func() {
		if created {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		_ = m.removeMemberContainers(cleanupCtx, record)
		if err := m.cleanupStorage(cleanupCtx, &record, true); err != nil {
			m.logger.Warn("failed managed storage member create left storage behind; the repair pass releases it", "id", record.ID, "error", err)
		}
	}()
	if err := m.ensureMounted(ctx, &record); err != nil {
		return managedStorageRecord{}, err
	}
	if err := m.prepareEngineDataRoot(record); err != nil {
		return managedStorageRecord{}, err
	}
	if err := m.ensureSetContainers(ctx, &record, input); err != nil {
		return managedStorageRecord{}, err
	}
	created = true
	return record, nil
}

// ensureSetContainers creates whatever container of the member is missing and
// starts the volume server and filer.
func (m *managedStorageManager) ensureSetContainers(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	set := *input.Set
	setNetwork, err := m.prepareSetNetwork(ctx, record.ID, set)
	if err != nil {
		return err
	}
	if err := m.createSetStorageNetwork(ctx, *record); err != nil {
		return err
	}
	staging, err := m.stageSeaweedFSSet(*record, input)
	if err != nil {
		return err
	}
	hostsPath := filepath.Join(m.seaweedfsSetDir(record.ID, set.MemberIndex), seaweedfsSetHostsFile)
	for _, role := range []swha.Role{swha.RoleVolume, swha.RoleFiler, swha.RoleMaster} {
		name := seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, role)
		inspect, err := m.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
		var containerID string
		switch {
		case err == nil:
			if inspect.Container.Config == nil || inspect.Container.Config.Labels[managedStorageLabel] != record.ID {
				return fmt.Errorf("container %s exists and is not this storage member's", name)
			}
			containerID = inspect.Container.ID
		case isNotFoundErr(err):
			containerID, err = m.createSetContainer(ctx, *record, role, setNetwork, staging, hostsPath)
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("inspect %s: %w", name, err)
		}
		if role == swha.RoleFiler {
			record.ContainerID = containerID
		}
		if role != swha.RoleMaster {
			if err := m.startContainer(ctx, containerID); err != nil {
				return err
			}
		}
	}
	record.ContainerName = seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, swha.RoleFiler)
	record.DesiredRunning = true
	if input.OperationID != "" {
		record.OperationID = input.OperationID
	}
	return m.saveRecord(*record)
}

// convertToSetMember turns the single-node container of the storage into the
// member layout: the data stays on the disk (volumes in /data, the filer store
// in /data/filerldb2), the master starts here as the set's first primary, and
// the replication of the existing volumes is repaired to two copies once
// another member registered (the engine starts degraded). On any failure the
// single-node container runs again, on its storage network as before.
//
// The member runtime is held meanwhile (it makes no decision on containers
// that change under it), and the primary aliases of the set are served from
// this node's master (no lease names a holder yet): the volume server and the
// filer reach the master only through them.
func (m *managedStorageManager) convertToSetMember(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	set := *input.Set
	if record.MemberIndex != int(set.MemberIndex) {
		return errors.New("the origin member keeps the storage's member index")
	}
	if m.plugin != nil && m.plugin.setMembers != nil {
		release, err := m.plugin.setMembers.Hold(ctx, set.SetID)
		if err != nil {
			return err
		}
		defer release()
	}
	previous := *record
	converted := *record
	converted.Set = &managedStorageSetRecord{SetID: set.SetID, MemberID: set.MemberID, MemberIndex: set.MemberIndex}
	converted.PublishS3, converted.PublishedPort = input.PublishS3, input.PublishedPort
	if input.TLS != nil {
		converted.TLSEnabled, converted.TLSServerName = true, input.TLS.ServerName
	}
	previousNetworkID := ""
	if inspected, err := m.client.cli.NetworkInspect(ctx, previous.NetworkName, mobyclient.NetworkInspectOptions{}); err == nil {
		previousNetworkID = inspected.Network.ID
	}
	releaseOrigin := func() {}
	if mesh := m.mesh(); mesh != nil {
		host := &seaweedfsSetHost{plugin: m.plugin, storage: m, initial: memberha.Config{SetID: set.SetID}, id: record.ID, index: set.MemberIndex,
			prefix: record.namePrefix()}
		releaseOrigin = mesh.SetOriginPrimary(set.SetID, func(ctx context.Context, port string) (net.Conn, bool) {
			target := uint16(swha.MasterHTTPPort)
			switch port {
			case swha.PortMaster:
			case swha.PortMasterGRPC:
				target = swha.MasterGRPCPort
			default:
				return nil, false
			}
			conn, err := host.DialContainer(ctx, swha.RoleMaster, target)
			if err != nil {
				return nil, false
			}
			return conn, true
		})
	}
	rollbackName := previous.ContainerName + "-replaced"
	if err := m.client.StopContainer(ctx, previous.ContainerID, 20); err != nil && !isNotFoundErr(err) {
		releaseOrigin()
		return err
	}
	if err := m.client.RenameContainer(ctx, previous.ContainerID, rollbackName); err != nil {
		releaseOrigin()
		_ = m.startContainer(ctx, previous.ContainerID)
		return fmt.Errorf("set the single-node container aside: %w", err)
	}
	restore := func(cause error) error {
		releaseOrigin()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		for _, role := range []swha.Role{swha.RoleVolume, swha.RoleFiler, swha.RoleMaster} {
			_ = m.client.RemoveContainer(cleanupCtx, seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, role), true)
		}
		*record = previous
		if err := m.client.RenameContainer(cleanupCtx, previous.ContainerID, previous.ContainerName); err != nil {
			m.logger.Error("could not restore the single-node storage container's name", "id", record.ID, "error", err)
		}
		// The single node publishes its S3 port itself again: a member proxy
		// the member runtime attached meanwhile lets go of it (and stays off;
		// the set is turned off around the storage).
		if _, err := m.plugin.releaseSetPublished(cleanupCtx, set.SetID); err != nil {
			m.logger.Warn("the storage member's proxy still holds the published port", "id", record.ID, "error", err)
		}
		if err := m.restoreSingleNodeNetwork(cleanupCtx, previous, previousNetworkID); err != nil {
			m.logger.Error("could not restore the single-node storage network", "id", record.ID, "error", err)
			return fmt.Errorf("the storage was not turned into an availability member (%v) and its network could not be restored: %w", cause, err)
		}
		if err := m.startContainer(cleanupCtx, previous.ContainerID); err != nil {
			m.logger.Error("could not restart the single-node storage container", "id", record.ID, "error", err)
			return fmt.Errorf("the storage was not turned into an availability member (%v) and could not be started again: %w", cause, err)
		}
		return fmt.Errorf("the storage was not turned into an availability member and runs as before: %w", cause)
	}
	if err := m.ensureMounted(ctx, &converted); err != nil {
		return restore(err)
	}
	// The storage network becomes internal: the member proxy publishes S3.
	if err := m.ensureSetStorageNetworkInternal(ctx, converted); err != nil {
		return restore(err)
	}
	if err := m.ensureSetContainers(ctx, &converted, input); err != nil {
		return restore(err)
	}
	masterName := seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, swha.RoleMaster)
	if err := m.startContainer(ctx, masterName); err != nil {
		return restore(err)
	}
	maxVolumeID, err := m.waitSetMaster(ctx, converted)
	if err != nil {
		return restore(err)
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, masterName, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil {
		return restore(fmt.Errorf("inspect the master: %w", err))
	}
	started, _ := time.Parse(time.RFC3339Nano, inspect.Container.State.StartedAt)
	if err := swha.MarkPrimary(m.seaweedfsSetEngineDir(record.ID, set.MemberIndex), started, maxVolumeID, true); err != nil {
		return restore(err)
	}
	if err := m.client.RemoveContainer(ctx, previous.ContainerID, true); err != nil && !isNotFoundErr(err) {
		m.logger.Warn("the replaced single-node storage container stays behind", "id", record.ID, "error", err)
	}
	*record = converted
	m.logger.Info("managed storage turned into an availability set member", "id", record.ID, "set_id", set.SetID)
	return m.saveRecord(*record)
}

// restoreSingleNodeNetwork puts the storage network back in the single node's
// shape after a conversion that failed: the conversion may have replaced it
// (internal for the member layout), and a container whose endpoint names the
// replaced network does not start ("network ... not found"). The network is
// created again as the single node needs it and the stopped single-node
// container is attached to it afresh, with its alias.
func (m *managedStorageManager) restoreSingleNodeNetwork(ctx context.Context, previous managedStorageRecord, previousNetworkID string) error {
	if err := m.ensureNetworkIsolation(ctx, previous, ""); err != nil {
		return err
	}
	inspected, err := m.client.cli.NetworkInspect(ctx, previous.NetworkName, mobyclient.NetworkInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed storage network: %w", err)
	}
	if previousNetworkID != "" && inspected.Network.ID == previousNetworkID {
		return nil
	}
	// The container is stopped: a forced disconnect only drops its endpoint
	// entry (the network it names may be gone).
	if _, err := m.client.cli.NetworkDisconnect(ctx, previous.NetworkName, mobyclient.NetworkDisconnectOptions{Container: previous.ContainerID, Force: true}); err != nil && !isNotFoundErr(err) {
		m.logger.Debug("the single-node storage container had no endpoint to drop", "id", previous.ID, "error", err)
	}
	if _, err := m.client.cli.NetworkConnect(ctx, previous.NetworkName, mobyclient.NetworkConnectOptions{
		Container: previous.ContainerID, EndpointConfig: &network.EndpointSettings{Aliases: []string{"s3"}},
	}); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return fmt.Errorf("reattach the single-node storage container: %w", err)
	}
	return nil
}

// restoreSetStorageNetwork puts a member's storage network back (internal)
// after a revert that failed and replaced it, and attaches the member's
// stopped filer to it again (its endpoint named the replaced network).
func (m *managedStorageManager) restoreSetStorageNetwork(ctx context.Context, record managedStorageRecord, memberNetworkID string) error {
	if err := m.ensureSetStorageNetworkInternal(ctx, record); err != nil {
		return err
	}
	inspected, err := m.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
	if err != nil {
		return err
	}
	if memberNetworkID != "" && inspected.Network.ID == memberNetworkID {
		return nil
	}
	filer := seaweedfsSetContainerName(record.namePrefix(), record.ID, record.Set.MemberIndex, swha.RoleFiler)
	_, _ = m.client.cli.NetworkDisconnect(ctx, record.NetworkName, mobyclient.NetworkDisconnectOptions{Container: filer, Force: true})
	if _, err := m.client.cli.NetworkConnect(ctx, record.NetworkName, mobyclient.NetworkConnectOptions{
		Container: filer, EndpointConfig: &network.EndpointSettings{Aliases: []string{"s3"}},
	}); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return fmt.Errorf("reattach the storage member's filer: %w", err)
	}
	return nil
}

// ensureSetStorageNetworkInternal recreates the storage network internal when
// the single node published S3 through it.
func (m *managedStorageManager) ensureSetStorageNetworkInternal(ctx context.Context, record managedStorageRecord) error {
	inspected, err := m.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
	if isNotFoundErr(err) {
		return m.createSetStorageNetwork(ctx, record)
	}
	if err != nil {
		return err
	}
	if inspected.Network.Internal {
		return nil
	}
	if inspected.Network.Labels[managedStorageLabel] != record.ID {
		return errors.New("managed storage network identity is invalid")
	}
	for endpoint := range inspected.Network.Containers {
		if _, err := m.client.cli.NetworkDisconnect(ctx, record.NetworkName, mobyclient.NetworkDisconnectOptions{Container: endpoint, Force: true}); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	if _, err := m.client.cli.NetworkRemove(ctx, record.NetworkName, mobyclient.NetworkRemoveOptions{}); err != nil && !isNotFoundErr(err) {
		return err
	}
	return m.createSetStorageNetwork(ctx, record)
}

// waitSetMaster waits until the converted member's master answers with its
// volume server registered and the filer and S3 answer; it returns the
// highest volume id.
func (m *managedStorageManager) waitSetMaster(ctx context.Context, record managedStorageRecord) (uint32, error) {
	set := *record.Set
	deadline := time.Now().Add(seaweedfsReadyTimeout)
	selfURL := swha.VolumeURL(set.MemberID, set.MemberIndex)
	var lastErr error
	for time.Now().Before(deadline) {
		raw, err := m.engineExec(ctx, seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, swha.RoleMaster),
			[]string{"curl", "-fsS", "--max-time", "3", "http://127.0.0.1:" + strconv.Itoa(swha.MasterHTTPPort) + "/dir/status"}, "")
		if err == nil {
			topology, perr := swha.ParseTopology(raw)
			if perr == nil && topology.Registered(selfURL) {
				if err := m.checkSeaweedFSReady(ctx, record); err == nil {
					return topology.MaxVolumeID, nil
				} else {
					lastErr = err
				}
			} else if perr != nil {
				lastErr = perr
			} else {
				lastErr = errors.New("the volume server has not registered")
			}
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return 0, fmt.Errorf("the member did not become ready: %w", lastErr)
}

func (m *managedStorageManager) seaweedfsSetEngineDir(id string, index uint32) string {
	return filepath.Join(m.seaweedfsSetDir(id, index), "engine")
}

// updateSetMember applies an update to a member: resources, a larger disk
// (the volume server is recreated for its sizing flags), TLS material or root
// credentials (the filer restarts), and the set's members (mesh and hosts).
// The member runtime is held while containers are replaced.
func (m *managedStorageManager) updateSetMember(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	set := managedStorageSetCommand{SetID: record.Set.SetID, MemberID: record.Set.MemberID, MemberIndex: record.Set.MemberIndex}
	if input.Set != nil {
		if input.Set.SetID != set.SetID || input.Set.MemberID != set.MemberID || input.Set.MemberIndex != set.MemberIndex {
			return errors.New("the update names another availability member")
		}
		set.Members = input.Set.Members
		if input.Set.ImageMove {
			return m.moveSetMemberImage(ctx, record, input)
		}
	}
	release := func() {}
	if m.plugin != nil && m.plugin.setMembers != nil {
		held, err := m.plugin.setMembers.Hold(ctx, set.SetID)
		if err != nil {
			return err
		}
		release = held
	}
	defer release()
	if len(set.Members) > 0 {
		if _, err := m.prepareSetNetwork(ctx, record.ID, set); err != nil {
			return err
		}
	}
	grown := false
	if input.Resources.StorageBytes != 0 && input.Resources.StorageBytes != record.StorageBytes {
		if input.Resources.StorageBytes < record.StorageBytes {
			return errors.New("managed storage cannot be reduced")
		}
		if err := m.ensureStorageSize(ctx, record, input.Resources.StorageBytes); err != nil {
			return err
		}
		record.StorageBytes, grown = input.Resources.StorageBytes, true
	}
	if input.Resources.NanoCPUs != 0 {
		record.NanoCPUs = input.Resources.NanoCPUs
	}
	if input.Resources.MemoryBytes != 0 {
		if input.Resources.MemoryBytes < minimumSeaweedFSMemoryBytes {
			return errors.New("managed storage memory limit is outside the supported range")
		}
		record.MemoryBytes = input.Resources.MemoryBytes
	}
	if input.Resources.MemorySwapBytes != 0 {
		record.MemorySwapBytes = input.Resources.MemorySwapBytes
	}
	for _, role := range []swha.Role{swha.RoleVolume, swha.RoleFiler, swha.RoleMaster} {
		memory := seaweedfsSetMemory(record.MemoryBytes, role)
		resources := container.Resources{Memory: memory, NanoCPUs: record.NanoCPUs}
		if _, err := m.client.cli.ContainerUpdate(ctx, seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, role),
			mobyclient.ContainerUpdateOptions{Resources: &resources}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("update the SeaweedFS %s resources: %w", role, err)
		}
	}
	restartFiler := false
	if input.TLS != nil {
		if !record.TLSEnabled {
			return errors.New("enabling TLS on existing SeaweedFS storage requires recreation")
		}
		changed, err := m.restageSeaweedFSTLS(*record, *input.TLS)
		if err != nil {
			return err
		}
		record.TLSServerName = input.TLS.ServerName
		restartFiler = restartFiler || changed
	}
	if input.RootCredentials.AccessKey != "" {
		changed, err := m.restageSeaweedFSRootCredentials(*record, input.RootCredentials)
		if err != nil {
			return err
		}
		restartFiler = restartFiler || changed
	}
	if grown {
		volume := seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, swha.RoleVolume)
		if err := m.client.RemoveContainer(ctx, volume, true); err != nil && !isNotFoundErr(err) {
			return err
		}
		ensure := input
		ensure.Set = &set
		if len(set.Members) == 0 {
			ensure.Set.Members = []managedStorageSetMember{{MemberID: set.MemberID, MemberIndex: set.MemberIndex}}
		}
		if err := m.ensureSetContainers(ctx, record, ensure); err != nil {
			return err
		}
	}
	if restartFiler {
		filer := seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, swha.RoleFiler)
		if err := m.client.StopContainer(ctx, filer, 20); err != nil && !isNotFoundErr(err) {
			return err
		}
		if err := m.startContainer(ctx, filer); err != nil {
			return err
		}
	}
	if input.OperationID != "" {
		record.OperationID = input.OperationID
	}
	return nil
}

// removeSetMember removes the member's containers, network share and files;
// the member runtime forgets it.
func (m *managedStorageManager) removeSetMember(ctx context.Context, record managedStorageRecord) error {
	if err := m.removeMemberContainers(ctx, record); err != nil {
		return err
	}
	if m.plugin != nil && m.plugin.setMembers != nil {
		if config, ok := m.plugin.setMembers.Config(record.Set.SetID); ok && config.MemberID == record.Set.MemberID {
			if err := m.plugin.setMembers.Forget(record.Set.SetID); err != nil {
				return err
			}
		}
	}
	if mesh := m.mesh(); mesh != nil {
		mesh.Release(ctx, record.Set.SetID)
	}
	return removeStagingTree(m.seaweedfsSetDir(record.ID, record.Set.MemberIndex))
}

// seaweedfsSetHost adapts the docker daemon to swha.Host for one member.
type seaweedfsSetHost struct {
	plugin  *DockerPlugin
	storage *managedStorageManager
	initial memberha.Config
	id      string
	index   uint32
	// prefix is the prefix of the member's container names (its record's).
	prefix string
	engine *leaseEngine
}

func newSeaweedFSSetHost(p *DockerPlugin, config memberha.Config) (*seaweedfsSetHost, error) {
	if !managedStorageIDPattern.MatchString(config.OwnerID) {
		return nil, errors.New("a SeaweedFS availability member needs its storage id")
	}
	self, ok := config.Peer(config.MemberID)
	if !ok {
		return nil, errors.New("the member is not listed in its set")
	}
	prefix := newManagedStorageNamePrefix()
	if p.storageManager != nil {
		if record, err := p.storageManager.loadRecord(config.OwnerID); err == nil {
			prefix = record.namePrefix()
		}
	}
	return &seaweedfsSetHost{plugin: p, storage: p.storageManager, initial: config, id: config.OwnerID, index: self.MemberIndex,
		prefix: prefix, engine: &leaseEngine{client: p.client, cgroupRoot: leasefence.DefaultCgroupRoot}}, nil
}

func (h *seaweedfsSetHost) Config() memberha.Config {
	if h.plugin.setMembers != nil {
		if config, ok := h.plugin.setMembers.Config(h.initial.SetID); ok {
			return config
		}
	}
	return h.initial
}

func (h *seaweedfsSetHost) name(role swha.Role) string {
	return seaweedfsSetContainerName(h.prefix, h.id, h.index, role)
}

func (h *seaweedfsSetHost) Container(ctx context.Context, role swha.Role) (swha.ContainerInfo, error) {
	inspect, err := h.plugin.client.cli.ContainerInspect(ctx, h.name(role), mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		h.storage.setImages.observe(h.initial.SetID, role, "", false)
		return swha.ContainerInfo{}, nil
	}
	if err != nil {
		return swha.ContainerInfo{}, err
	}
	if inspect.Container.Config == nil || inspect.Container.Config.Labels[managedStorageLabel] != h.id {
		return swha.ContainerInfo{}, fmt.Errorf("container %s is not this storage member's", h.name(role))
	}
	h.storage.setImages.observe(h.initial.SetID, role, inspect.Container.Config.Image, true)
	c := h.engine.convert(ctx, inspect.Container)
	return swha.ContainerInfo{Exists: true, Running: c.Running && !c.Restarting, ID: c.ID, CgroupPath: c.CgroupPath, StartedAt: c.StartedAt}, nil
}

func (h *seaweedfsSetHost) Start(ctx context.Context, role swha.Role) error {
	if role == swha.RoleFiler || role == swha.RoleVolume {
		record, err := h.storage.loadRecord(h.id)
		if err == nil && !record.Removed {
			if err := h.storage.ensureMounted(ctx, &record); err != nil {
				return err
			}
		}
	}
	return h.storage.startContainer(ctx, h.name(role))
}

func (h *seaweedfsSetHost) Stop(ctx context.Context, role swha.Role, timeout time.Duration) error {
	err := h.plugin.client.StopContainer(ctx, h.name(role), max(1, int(timeout.Seconds())))
	if isNotFoundErr(err) {
		return nil
	}
	return err
}

func (h *seaweedfsSetHost) Kill(ctx context.Context, role swha.Role) error {
	err := h.plugin.client.KillContainer(ctx, h.name(role), "KILL")
	if err != nil && (isNotFoundErr(err) || strings.Contains(strings.ToLower(err.Error()), "not running")) {
		return nil
	}
	return err
}

func (h *seaweedfsSetHost) CgroupEmpty(ctx context.Context, role swha.Role) (bool, error) {
	info, err := h.Container(ctx, role)
	if err != nil {
		return false, err
	}
	if !info.Exists {
		return true, nil
	}
	return h.engine.CgroupEmpty(ctx, leaseContainer(info))
}

func (h *seaweedfsSetHost) EnsureNoRestart(ctx context.Context, role swha.Role) error {
	inspect, err := h.plugin.client.cli.ContainerInspect(ctx, h.name(role), mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if inspect.Container.HostConfig == nil || inspect.Container.HostConfig.RestartPolicy.Name == "" ||
		inspect.Container.HostConfig.RestartPolicy.Name == container.RestartPolicyDisabled {
		return nil
	}
	return h.engine.DisableRestart(ctx, inspect.Container.ID)
}

func (h *seaweedfsSetHost) DialContainer(ctx context.Context, role swha.Role, port uint16) (net.Conn, error) {
	inspect, err := h.plugin.client.cli.ContainerInspect(ctx, h.name(role), mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, err
	}
	if inspect.Container.NetworkSettings == nil {
		return nil, fmt.Errorf("container %s has no network", h.name(role))
	}
	endpoint := setMeshEndpoint(inspect.Container.NetworkSettings.Networks, h.initial.SetID)
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return nil, fmt.Errorf("container %s is not on the set network", h.name(role))
	}
	return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(endpoint.IPAddress.String(), strconv.Itoa(int(port))))
}

func (h *seaweedfsSetHost) Exec(ctx context.Context, role swha.Role, command []string, stdin string) ([]byte, error) {
	return h.storage.engineExec(ctx, h.name(role), command, stdin)
}

func (h *seaweedfsSetHost) DialAlias(ctx context.Context, alias string) (net.Conn, error) {
	local, remote := net.Pipe()
	go func() {
		if err := h.plugin.BridgeSetPeer(remote, h.initial.SetID, alias); err != nil {
			_ = local.Close()
		}
	}()
	if deadline, ok := ctx.Deadline(); ok {
		_ = local.SetDeadline(deadline)
	}
	return local, nil
}

func (h *seaweedfsSetHost) Expose(exposures []swha.Exposure) {
	mesh := h.plugin.setMesh()
	for _, exposure := range exposures {
		mesh.Expose(h.initial.SetID, exposure.Host, exposure.Port, exposure.Alias)
	}
	gateway, ok := mesh.Gateway(h.initial.SetID)
	if !ok {
		return
	}
	if _, err := h.storage.writeSetHosts(h.id, h.index, gateway, exposures); err != nil {
		h.plugin.logger.Warn("could not write the storage member's hosts file", "id", h.id, "error", err)
	}
}

func (h *seaweedfsSetHost) SetLocalPrimary(dial func(ctx context.Context, port string) (net.Conn, bool)) {
	h.plugin.setMesh().SetLocalPrimary(h.initial.SetID, dial)
}

// FilerToken signs a short-lived write token with the member's filer signing
// key (jwt.filer_signing in its security.toml), as SeaweedFS expects it.
func (h *seaweedfsSetHost) FilerToken() (string, error) {
	record := managedStorageRecord{ID: h.id, MemberIndex: int(h.index)}
	raw, err := os.ReadFile(filepath.Join(h.storage.seaweedfsStagingDir(record), "config", "security.toml"))
	if err != nil {
		return "", err
	}
	match := seaweedfsFilerKeyPattern.FindSubmatch(raw)
	if match == nil {
		return "", errors.New("the member's filer signing key is missing")
	}
	return swha.SignFilerToken(match[1], time.Now().Add(setFilerTokenLifetime))
}

func (h *seaweedfsSetHost) DiskFree() (uint64, bool, bool) {
	record, err := h.storage.loadRecord(h.id)
	if err != nil {
		return 0, false, false
	}
	space, err := h.storage.storageSpace(record)
	if err != nil {
		return 0, false, false
	}
	return uint64(max(space.Free, 0)), seaweedfsFull(space, seaweedfsSizingFor(record.StorageBytes)), true
}

// PlanReclaim plans a set's compaction as a single node's (managed_storage_reclaim.go),
// against the fullest member disk: every copy of a volume is compacted on its
// own member.
func (h *seaweedfsSetHost) PlanReclaim(volumeStatus []byte, fullest swha.DiskSpace) (swha.ReclaimPlan, error) {
	record, err := h.storage.loadRecord(h.id)
	if err != nil {
		return swha.ReclaimPlan{}, err
	}
	volumes, err := parseSeaweedFSVolumeStatus(volumeStatus)
	if err != nil {
		return swha.ReclaimPlan{}, err
	}
	space := storageSpace{Free: int64(min(fullest.Free, uint64(math.MaxInt64))), Total: int64(min(fullest.Total, uint64(math.MaxInt64)))}
	plan := planSeaweedFSReclaim(volumes, space, seaweedfsSizingFor(record.StorageBytes))
	return swha.ReclaimPlan{Threshold: plan.Threshold, VolumeIDs: plan.VolumeIDs}, nil
}

func (h *seaweedfsSetHost) StateDir() string {
	return h.storage.seaweedfsSetEngineDir(h.id, h.index)
}

// Serve attaches the member proxy of the storage's published port.
func (h *seaweedfsSetHost) Serve() {
	config := h.Config()
	if h.plugin.setMembers == nil {
		return
	}
	if config.PublishedPort == 0 {
		h.plugin.setMembers.DetachProxy(config.SetID)
		return
	}
	address := ":" + strconv.Itoa(int(config.PublishedPort))
	if err := h.plugin.setMembers.AttachProxy(config.SetID, address, func(ctx context.Context) (net.Conn, error) {
		return h.DialContainer(ctx, swha.RoleFiler, swha.S3Port)
	}); err != nil {
		h.plugin.logger.Warn("storage member proxy could not listen", "id", h.id, "address", address, "error", err)
	}
}

func (h *seaweedfsSetHost) Logger() *slog.Logger { return h.plugin.logger }

func leaseContainer(info swha.ContainerInfo) lease.Container {
	return lease.Container{ID: info.ID, CgroupPath: info.CgroupPath, Running: info.Running}
}

// startSetMember starts the member's volume server and filer; restart
// restarts the filer.
func (m *managedStorageManager) startSetMember(ctx context.Context, record managedStorageRecord, restart bool) error {
	index := record.Set.MemberIndex
	filer := seaweedfsSetContainerName(record.namePrefix(), record.ID, index, swha.RoleFiler)
	if restart {
		if err := m.client.StopContainer(ctx, filer, 20); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	for _, name := range []string{seaweedfsSetContainerName(record.namePrefix(), record.ID, index, swha.RoleVolume), filer} {
		if err := m.startContainer(ctx, name); err != nil {
			return err
		}
	}
	return nil
}

// revertSetMember turns the member (the one the set kept when it was turned
// off) back into the single-node container on the same data: volumes stay in
// /data, the filer store in /data/filerldb2. Its volumes get one copy again
// (a single volume server cannot keep two). On failure the member's
// containers run again.
func (m *managedStorageManager) revertSetMember(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	set := *record.Set
	release := func() {}
	if m.plugin != nil && m.plugin.setMembers != nil {
		held, err := m.plugin.setMembers.Hold(ctx, set.SetID)
		if err != nil {
			return err
		}
		release = held
	}
	defer release()
	// A public single node publishes the S3 port the member proxy serves.
	restorePublished, err := m.plugin.releaseSetPublished(ctx, set.SetID)
	if err != nil {
		return err
	}
	memberNetworkID := ""
	if inspected, err := m.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{}); err == nil {
		memberNetworkID = inspected.Network.ID
	}
	single := *record
	single.Set = nil
	single.ContainerID = ""
	single.ContainerName = fmt.Sprintf("%s%s-%d", record.namePrefix(), record.ID, record.MemberIndex)
	single.PublishS3, single.PublishedPort = input.PublishS3, input.PublishedPort
	if input.TLS != nil {
		single.TLSEnabled, single.TLSServerName = true, input.TLS.ServerName
	}
	for _, role := range []swha.Role{swha.RoleMaster, swha.RoleFiler, swha.RoleVolume} {
		if err := m.client.StopContainer(ctx, seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, role), 20); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	restore := func(cause error) error {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		if single.ContainerID != "" {
			_ = m.client.RemoveContainer(cleanupCtx, single.ContainerID, true)
		}
		if err := m.restoreSetStorageNetwork(cleanupCtx, *record, memberNetworkID); err != nil {
			m.logger.Error("could not restore the storage member's network", "id", record.ID, "error", err)
		}
		restorePublished()
		for _, role := range []swha.Role{swha.RoleVolume, swha.RoleFiler} {
			if err := m.startContainer(cleanupCtx, seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, role)); err != nil {
				m.logger.Error("could not restart the storage member", "id", record.ID, "role", role, "error", err)
			}
		}
		return fmt.Errorf("the storage member was not turned back into a single node and runs as before: %w", cause)
	}
	// The filer container holds the single-node name: set it aside first.
	filer := seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, swha.RoleFiler)
	setAside := filer + "-member"
	if err := m.client.RenameContainer(ctx, filer, setAside); err != nil && !isNotFoundErr(err) {
		return restore(err)
	}
	renamedBack := func() {
		_ = m.client.RenameContainer(context.Background(), setAside, filer)
	}
	// A public single node binds its S3 port itself, on a network that is not
	// internal (the single-node rule).
	if err := m.ensureNetworkIsolation(ctx, single, ""); err != nil {
		renamedBack()
		return restore(err)
	}
	if _, err := m.stageSeaweedFS(single, input); err != nil {
		renamedBack()
		return restore(err)
	}
	containerID, err := m.createSeaweedFSContainer(ctx, &single, input)
	if err != nil {
		renamedBack()
		return restore(err)
	}
	single.ContainerID = containerID
	if err := m.waitForReady(ctx, single); err != nil {
		renamedBack()
		return restore(err)
	}
	if err := m.singleCopyVolumes(ctx, single); err != nil {
		m.logger.Warn("the volumes of the storage that left its set keep two copies; new objects still get one", "id", record.ID, "error", err)
	}
	for _, role := range []swha.Role{swha.RoleMaster, swha.RoleVolume} {
		_ = m.client.RemoveContainer(ctx, seaweedfsSetContainerName(record.namePrefix(), record.ID, set.MemberIndex, role), true)
	}
	_ = m.client.RemoveContainer(ctx, setAside, true)
	if m.plugin != nil && m.plugin.setMembers != nil {
		if config, ok := m.plugin.setMembers.Config(set.SetID); ok && config.MemberID == set.MemberID {
			if err := m.plugin.setMembers.Forget(set.SetID); err != nil {
				m.logger.Warn("the member runtime keeps the storage member that left its set", "id", record.ID, "error", err)
			}
		}
	}
	if mesh := m.mesh(); mesh != nil {
		mesh.Release(ctx, set.SetID)
	}
	_ = removeStagingTree(m.seaweedfsSetDir(record.ID, set.MemberIndex))
	if input.OperationID != "" {
		single.OperationID = input.OperationID
	}
	*record = single
	m.logger.Info("managed storage left its availability set and serves as a single node", "id", record.ID)
	return nil
}

// singleCopyVolumes sets every volume of a single node to one copy and drops
// the set's bucket rule.
func (m *managedStorageManager) singleCopyVolumes(ctx context.Context, record managedStorageRecord) error {
	raw, err := m.engineExec(ctx, record.ContainerID, seaweedfsVolumeStatusCommand, "")
	if err != nil {
		return err
	}
	volumes, err := parseSeaweedFSVolumeStatus(raw)
	if err != nil {
		return err
	}
	lines := []string{"lock"}
	for _, volume := range volumes {
		lines = append(lines, fmt.Sprintf("volume.configure.replication -volumeId=%d -replication=000", volume.ID))
	}
	lines = append(lines, "fs.configure -locationPrefix=/buckets/ -delete -apply", "unlock")
	_, err = m.engineExec(ctx, record.ContainerID, seaweedfsShellCommand, strings.Join(lines, "\n")+"\n")
	return err
}
