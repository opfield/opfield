// Package pages implements the nginx daemon's bounded Opfield Pages v1
// materialization runtime. It is deliberately independent from the control
// plane: commands supply opaque IDs and DNS names, while this package derives
// every path below a daemon-owned root.
package pages

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const (
	maxChunkBytes    = 8 << 20
	maxArchiveBytes  = 1 << 30
	maxExpandedBytes = 5 << 30
	maxFileBytes     = 1 << 30
	maxFileCount     = 100_000
	defaultProfileID = "default"
)

var (
	uuidPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hostnameLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	certPattern   = regexp.MustCompile(`^(?:internal-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type Nginx interface {
	TestConfig() (bool, string)
	Reload() error
}

type Runtime struct {
	root        string
	configDir   string
	certsDir    string
	htpasswdDir string
	nginx       Nginx
	// traversableBase and workerUID: see SetReaderAccess (N-22).
	traversableBase string
	workerUID       func() (int, error)
}

type uploadMeta struct {
	UploadID      string `json:"uploadId"`
	DeploymentID  string `json:"deploymentId"`
	ExpectedSize  int64  `json:"expectedSize"`
	SHA256        string `json:"sha256"`
	CreatedAtUnix int64  `json:"createdAtUnix"`
}

type releaseManifest struct {
	DeploymentID string `json:"deploymentId"`
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
	FileCount    int    `json:"fileCount"`
}

type Inventory struct {
	Deployments    []InventoryDeployment    `json:"deployments"`
	Previews       []string                 `json:"previews"`
	Routes         []string                 `json:"routes"`
	RuntimeConfigs []InventoryRuntimeConfig `json:"runtimeConfigs"`
	Bytes          int64                    `json:"bytes"`
}

type InventoryDeployment struct {
	DeploymentID string `json:"deploymentId"`
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
}

type StoragePreflight struct {
	RequiredBytes int64 `json:"requiredBytes"`
	FreeBytes     int64 `json:"freeBytes"`
	Available     bool  `json:"available"`
}

func New(root, configDir, certsDir string, nginx Nginx) (*Runtime, error) {
	if root == "" || configDir == "" || certsDir == "" || nginx == nil {
		return nil, errors.New("pages runtime requires root, nginx config/cert dirs, and manager")
	}
	if !safeNginxPath(root) || !safeNginxPath(configDir) || !safeNginxPath(certsDir) {
		return nil, errors.New("Pages runtime directories must be absolute nginx-safe paths")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve pages root: %w", err)
	}
	return &Runtime{root: absRoot, configDir: filepath.Clean(configDir), certsDir: filepath.Clean(certsDir), nginx: nginx}, nil
}

func (r *Runtime) InitUpload(uploadID, deploymentID string, expectedSize int64, digest string) error {
	if err := validateID(uploadID); err != nil {
		return fmt.Errorf("upload id: %w", err)
	}
	if err := validateID(deploymentID); err != nil {
		return fmt.Errorf("deployment id: %w", err)
	}
	if expectedSize <= 0 || expectedSize > maxArchiveBytes {
		return fmt.Errorf("invalid expected archive size")
	}
	if !sha256Pattern.MatchString(digest) {
		return errors.New("invalid archive sha256")
	}
	if err := r.ensureUploadStorage(); err != nil {
		return fmt.Errorf("create uploads dir: %w", err)
	}
	meta := uploadMeta{UploadID: uploadID, DeploymentID: deploymentID, ExpectedSize: expectedSize, SHA256: digest, CreatedAtUnix: time.Now().Unix()}
	if existing, err := r.readUploadMeta(uploadID); err == nil {
		if existing == meta || (existing.UploadID == meta.UploadID && existing.DeploymentID == meta.DeploymentID && existing.ExpectedSize == meta.ExpectedSize && existing.SHA256 == meta.SHA256) {
			return nil
		}
		return errors.New("upload id already belongs to a different artifact")
	} else if !os.IsNotExist(err) {
		return err
	}
	encoded, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return writeAtomic(r.uploadMetaPath(uploadID), encoded, 0o600)
}

func (r *Runtime) AppendUpload(uploadID string, offset int64, content []byte) (int64, error) {
	if err := validateID(uploadID); err != nil {
		return 0, fmt.Errorf("upload id: %w", err)
	}
	if offset < 0 || len(content) == 0 || len(content) > maxChunkBytes {
		return 0, errors.New("invalid upload chunk")
	}
	if err := r.ensureUploadStorage(); err != nil {
		return 0, fmt.Errorf("ensure uploads dir: %w", err)
	}
	meta, err := r.readUploadMeta(uploadID)
	if err != nil {
		return 0, err
	}
	archivePath := r.uploadArchivePath(uploadID)
	if _, err := lstatRegular(archivePath); err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	f, err := openNoFollow(archivePath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, privateFileMode)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := lstatRegularFile(f, archivePath)
	if err != nil {
		return 0, err
	}
	current := info.Size()
	if current != offset {
		return current, fmt.Errorf("upload offset mismatch: expected %d", current)
	}
	if current+int64(len(content)) > meta.ExpectedSize {
		return current, errors.New("upload exceeds declared size")
	}
	if err := f.Chmod(privateFileMode); err != nil {
		return current, err
	}
	if _, err := f.Write(content); err != nil {
		return current, err
	}
	if err := f.Sync(); err != nil {
		return current, err
	}
	return current + int64(len(content)), nil
}

func (r *Runtime) FinalizeUpload(uploadID, deploymentID string) (releaseManifest, error) {
	if err := validateID(uploadID); err != nil {
		return releaseManifest{}, fmt.Errorf("upload id: %w", err)
	}
	if err := validateID(deploymentID); err != nil {
		return releaseManifest{}, fmt.Errorf("deployment id: %w", err)
	}
	if err := r.ensureUploadStorage(); err != nil {
		return releaseManifest{}, fmt.Errorf("ensure uploads dir: %w", err)
	}
	meta, err := r.readUploadMeta(uploadID)
	if err != nil {
		return releaseManifest{}, err
	}
	if meta.DeploymentID != deploymentID {
		return releaseManifest{}, errors.New("upload does not belong to deployment")
	}
	archivePath := r.uploadArchivePath(uploadID)
	if _, err := lstatRegular(archivePath); err != nil {
		return releaseManifest{}, fmt.Errorf("stat archive: %w", err)
	}
	archive, err := openNoFollow(archivePath, os.O_RDWR, privateFileMode)
	if err != nil {
		return releaseManifest{}, fmt.Errorf("stat archive: %w", err)
	}
	defer archive.Close()
	info, err := lstatRegularFile(archive, archivePath)
	if err != nil {
		return releaseManifest{}, err
	}
	if err := archive.Chmod(privateFileMode); err != nil {
		return releaseManifest{}, err
	}
	if err := chmodNoFollowRegular(r.uploadMetaPath(uploadID), privateFileMode); err != nil {
		return releaseManifest{}, err
	}
	if info.Size() != meta.ExpectedSize {
		return releaseManifest{}, errors.New("archive is incomplete")
	}
	digest, err := fileSHA256Reader(archive)
	if err != nil {
		return releaseManifest{}, err
	}
	if digest != meta.SHA256 {
		return releaseManifest{}, errors.New("archive checksum mismatch")
	}
	if existing, err := r.readManifest(deploymentID); err == nil {
		if existing.SHA256 == digest && existing.Size == info.Size() {
			if err := r.ensurePublicRelease(deploymentID); err != nil {
				return releaseManifest{}, err
			}
			if err := r.removeUpload(uploadID); err != nil {
				return releaseManifest{}, err
			}
			return existing, nil
		}
		return releaseManifest{}, errors.New("immutable release already belongs to a different artifact")
	} else if !os.IsNotExist(err) {
		return releaseManifest{}, err
	}

	if err := ensureDirectory(r.root, publicDirectoryMode); err != nil {
		return releaseManifest{}, fmt.Errorf("create public pages root: %w", err)
	}
	if err := ensureDirectory(r.releasesDir(), publicDirectoryMode); err != nil {
		return releaseManifest{}, fmt.Errorf("create releases dir: %w", err)
	}
	stage, err := os.MkdirTemp(r.releasesDir(), ".stage-"+deploymentID+"-")
	if err != nil {
		return releaseManifest{}, fmt.Errorf("create release stage: %w", err)
	}
	defer os.RemoveAll(stage)
	manifest, err := extractArchive(archivePath, filepath.Join(stage, "content"), deploymentID, digest, info.Size())
	if err != nil {
		return releaseManifest{}, err
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return releaseManifest{}, err
	}
	if err := writeAtomic(filepath.Join(stage, "manifest.json"), encoded, publicFileMode); err != nil {
		return releaseManifest{}, err
	}
	if err := os.Rename(stage, r.releaseDir(deploymentID)); err != nil {
		if os.IsExist(err) {
			existing, readErr := r.readManifest(deploymentID)
			if readErr != nil {
				return releaseManifest{}, readErr
			}
			if existing.SHA256 != digest || existing.Size != info.Size() {
				return releaseManifest{}, errors.New("immutable release already belongs to a different artifact")
			}
			if err := r.ensurePublicRelease(deploymentID); err != nil {
				return releaseManifest{}, err
			}
			if err := r.removeUpload(uploadID); err != nil {
				return releaseManifest{}, err
			}
			return existing, nil
		}
		return releaseManifest{}, fmt.Errorf("activate release: %w", err)
	}
	if err := r.ensurePublicRelease(deploymentID); err != nil {
		return releaseManifest{}, fmt.Errorf("make release public: %w", err)
	}
	if err := r.removeUpload(uploadID); err != nil {
		return releaseManifest{}, fmt.Errorf("remove finalized upload: %w", err)
	}
	return manifest, nil
}

func (r *Runtime) VerifyRelease(deploymentID, digest string) (releaseManifest, error) {
	if err := validateID(deploymentID); err != nil {
		return releaseManifest{}, fmt.Errorf("deployment id: %w", err)
	}
	if err := r.ensurePublicRelease(deploymentID); err != nil {
		return releaseManifest{}, fmt.Errorf("validate release tree: %w", err)
	}
	manifest, err := r.readManifest(deploymentID)
	if err != nil {
		return releaseManifest{}, err
	}
	if digest != "" && manifest.SHA256 != digest {
		return releaseManifest{}, errors.New("release checksum does not match")
	}
	// A release nginx cannot read is not ready: it would answer 404 (N-22).
	if err := r.checkReaderAccess(r.releaseContentDir(deploymentID)); err != nil {
		return releaseManifest{}, err
	}
	return manifest, nil
}

// IsReleaseNotStored reports a verification error that means the release is
// not stored on this node (yet): Opfield then uploads it (N-23).
func IsReleaseNotStored(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

func (r *Runtime) MaterializePreview(profileID, deploymentID, hostname, certificateID, certificateVersion string, fallbackOptions ...PreviewFallback) error {
	if profileID != defaultProfileID {
		return errors.New("invalid Pages profile id")
	}
	if _, err := r.VerifyRelease(deploymentID, ""); err != nil {
		return err
	}
	if !validHostname(hostname) {
		return errors.New("invalid preview hostname")
	}
	if certificateID != "" && (!certPattern.MatchString(certificateID) || !sha256Pattern.MatchString(certificateVersion)) {
		return errors.New("invalid certificate id")
	}
	if certificateID == "" && certificateVersion != "" {
		return errors.New("certificate version requires certificate id")
	}
	fallback := PreviewFallback{}
	if len(fallbackOptions) > 0 {
		fallback = fallbackOptions[0]
	}
	if fallback.URL != "" && !validPagesFallbackURL(fallback.URL) {
		return errors.New("invalid Pages fallback URL")
	}
	if err := validatePreviewAccess(fallback.Access); err != nil {
		return err
	}
	if err := r.ensurePreviewCredentials(fallback.Access); err != nil {
		return err
	}
	runtimeConfigPath, err := r.RuntimeConfigPath(RuntimeConfigBindingPreview, hostname)
	if err != nil {
		return err
	}
	if err := r.ensureRuntimeConfigPublicDirs(RuntimeConfigBindingPreview, hostname); err != nil {
		return err
	}
	content := r.previewConfig(hostname, deploymentID, certificateID, certificateVersion, runtimeConfigPath, fallback)
	return r.applyConfig(r.previewConfigPath(hostname), []byte(content))
}

func (r *Runtime) RemovePreview(hostname string) error {
	if !validHostname(hostname) {
		return errors.New("invalid preview hostname")
	}
	// Keep an explicit denial vhost: deleting the server block lets this Host
	// fall through to another preview or a tag route acting as nginx's default.
	// The tombstone references neither artifacts nor certificates, survives
	// restarts, and is atomically replaced by MaterializePreview on re-enable.
	content := fmt.Sprintf(revokedPreviewMarker+"\nserver {\n    listen 80;\n    listen 443 ssl;\n    server_name %s;\n    ssl_reject_handshake on;\n    return 404;\n}\n", hostname)
	return r.applyConfig(r.previewConfigPath(hostname), []byte(content))
}

func (r *Runtime) ActivateTagRoute(routeID, deploymentID string) error {
	if err := validateID(routeID); err != nil {
		return fmt.Errorf("route id: %w", err)
	}
	if _, err := r.VerifyRelease(deploymentID, ""); err != nil {
		return err
	}
	runtimeConfigPath, err := r.RuntimeConfigPath(RuntimeConfigBindingRoute, routeID)
	if err != nil {
		return err
	}
	if err := r.ensureRuntimeConfigPublicDirs(RuntimeConfigBindingRoute, routeID); err != nil {
		return err
	}
	fragment := r.routeConfig(routeID, deploymentID, runtimeConfigPath)
	return r.applyConfig(r.routeIncludePath(routeID), []byte(fragment))
}

// revokedPreviewMarker starts the denial vhost of a revoked preview.
const revokedPreviewMarker = "# opfield-pages revoked preview"

// isRevokedPreview recognises a revoked preview under either names.
func isRevokedPreview(content []byte) bool {
	return strings.HasPrefix(naming.Normalize(string(content)), revokedPreviewMarker+"\n")
}

func (r *Runtime) routeConfig(routeID, deploymentID, runtimeConfigPath string) string {
	return fmt.Sprintf("# opfield-pages route %s\nroot %s;\nindex index.html;\nset $opfield_pages_runtime_config_path %s;\n", routeID, r.releaseContentDir(deploymentID), runtimeConfigPath)
}

func (r *Runtime) DeactivateTagRoute(routeID string) error {
	if err := validateID(routeID); err != nil {
		return fmt.Errorf("route id: %w", err)
	}
	return r.applyConfig(r.routeIncludePath(routeID), nil)
}

// RouteIncludePath returns the daemon-derived include path a normal Opfield
// Route must reference after a successful PagesActivateTagRoute command. It is
// deliberately returned only for a validated opaque Route ID; callers must not
// derive it from an operator path or hard-code the daemon default.
func (r *Runtime) RouteIncludePath(routeID string) (string, error) {
	if err := validateID(routeID); err != nil {
		return "", fmt.Errorf("route id: %w", err)
	}
	return r.routeIncludePath(routeID), nil
}

func (r *Runtime) CleanupDeployment(deploymentID string) error {
	if err := validateID(deploymentID); err != nil {
		return fmt.Errorf("deployment id: %w", err)
	}
	if _, err := r.VerifyRelease(deploymentID, ""); err != nil {
		return err
	}
	if r.isReferenced(deploymentID) {
		return errors.New("release is still referenced by a preview or tag route")
	}
	if err := os.RemoveAll(r.releaseDir(deploymentID)); err != nil {
		return fmt.Errorf("remove release: %w", err)
	}
	return nil
}

func (r *Runtime) Inventory() (Inventory, error) {
	result := Inventory{}
	entries, err := os.ReadDir(r.releasesDir())
	if err != nil && !os.IsNotExist(err) {
		return result, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !uuidPattern.MatchString(entry.Name()) {
			continue
		}
		manifest, err := r.readManifest(entry.Name())
		if err != nil {
			continue
		}
		result.Deployments = append(result.Deployments, InventoryDeployment{DeploymentID: manifest.DeploymentID, SHA256: manifest.SHA256, Size: manifest.Size})
		result.Bytes += manifest.Size
	}
	sort.Slice(result.Deployments, func(i, j int) bool { return result.Deployments[i].DeploymentID < result.Deployments[j].DeploymentID })
	previews, _ := filepath.Glob(filepath.Join(r.configDir, "pages-preview-*.conf"))
	for _, item := range previews {
		if content, err := os.ReadFile(item); err == nil && !isRevokedPreview(content) {
			for _, line := range strings.Split(string(content), "\n") {
				if hostname, found := strings.CutPrefix(strings.TrimSpace(line), "server_name "); found {
					result.Previews = append(result.Previews, strings.TrimSuffix(hostname, ";"))
					break
				}
			}
		}
	}
	routes, _ := filepath.Glob(filepath.Join(r.configDir, "pages", "routes", "*.inc"))
	for _, item := range routes {
		result.Routes = append(result.Routes, strings.TrimSuffix(filepath.Base(item), ".inc"))
	}
	runtimeConfigs, err := r.runtimeConfigInventory()
	if err != nil {
		return result, err
	}
	result.RuntimeConfigs = runtimeConfigs
	return result, nil
}

func (r *Runtime) uploadsDir() string  { return filepath.Join(r.root, "uploads") }
func (r *Runtime) releasesDir() string { return filepath.Join(r.root, "releases") }
func (r *Runtime) uploadArchivePath(uploadID string) string {
	return filepath.Join(r.uploadsDir(), uploadID+".tar.gz")
}
func (r *Runtime) uploadMetaPath(uploadID string) string {
	return filepath.Join(r.uploadsDir(), uploadID+".json")
}
func (r *Runtime) releaseDir(id string) string { return filepath.Join(r.releasesDir(), id) }
func (r *Runtime) releaseContentDir(id string) string {
	return filepath.Join(r.releaseDir(id), "content")
}
func (r *Runtime) releaseManifestPath(id string) string {
	return filepath.Join(r.releaseDir(id), "manifest.json")
}
func (r *Runtime) previewConfigPath(hostname string) string {
	hash := sha256.Sum256([]byte(hostname))
	return filepath.Join(r.configDir, "pages-preview-"+hex.EncodeToString(hash[:12])+".conf")
}
func (r *Runtime) routeIncludePath(routeID string) string {
	return filepath.Join(r.configDir, "pages", "routes", routeID+".inc")
}

func (r *Runtime) readUploadMeta(uploadID string) (uploadMeta, error) {
	var meta uploadMeta
	data, err := readFileNoFollow(r.uploadMetaPath(uploadID))
	if err != nil {
		return meta, err
	}
	err = json.Unmarshal(data, &meta)
	return meta, err
}
func (r *Runtime) readManifest(deploymentID string) (releaseManifest, error) {
	var manifest releaseManifest
	data, err := readFileNoFollow(r.releaseManifestPath(deploymentID))
	if err != nil {
		return manifest, err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return manifest, err
	}
	if manifest.DeploymentID != deploymentID || !sha256Pattern.MatchString(manifest.SHA256) {
		return manifest, errors.New("invalid release manifest")
	}
	return manifest, nil
}

func (r *Runtime) removeUpload(uploadID string) error {
	if err := os.Remove(r.uploadArchivePath(uploadID)); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Remove(r.uploadMetaPath(uploadID)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (r *Runtime) ensureUploadStorage() error {
	if err := ensureDirectory(r.root, publicDirectoryMode); err != nil {
		return err
	}
	return ensureDirectory(r.uploadsDir(), privateDirectoryMode)
}
