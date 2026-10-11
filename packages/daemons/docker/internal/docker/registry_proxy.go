package docker

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/listenerkeep"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
)

const (
	registryRelayOwnerKind = "registry_secure_link"
	registryProxyAddress   = "127.0.0.1"
	registryProxyPort      = 5443
	registryProxyServer    = "127.0.0.1"
)

var registryRepositoryPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$`)

type registryProxyBinding struct {
	id            string
	role          string
	generation    uint64
	repository    string
	actions       map[string]struct{}
	authorization string
	expiresAt     time.Time
	active        map[net.Conn]struct{}
}

type dockerRegistryProxyManager struct {
	mu        sync.RWMutex
	plugin    *DockerPlugin
	directory string
	trustRoot string
	bindings  map[string]*registryProxyBinding
	listener  net.Listener
	server    *http.Server
	// keptName names the listening socket's copy in the listener keeper; adopted is the socket the previous process
	// kept, until startListener claims it; handingOver is set once the socket went to the next process
	// (registry_proxy_handover.go).
	keptName    string
	adopted     *os.File
	handingOver bool
	// identityMu serializes identity checks; identity is read lock-free by
	// the TLS handshake so a reissued leaf is served without a restart.
	identityMu sync.Mutex
	identity   atomic.Pointer[registryProxyIdentity]
}

// registryProxyIdentity is the CA and the server certificate it signed.
type registryProxyIdentity struct {
	caPEM []byte
	cert  *tls.Certificate
}

type registryProxyStatus struct {
	Address    string `json:"address"`
	Port       int    `json:"port"`
	ServerName string `json:"serverName"`
	CAPEM      string `json:"caPem"`
	Bindings   int    `json:"bindings"`
}

func newDockerRegistryProxyManager(plugin *DockerPlugin) (*dockerRegistryProxyManager, error) {
	directory := filepath.Join(plugin.cfg.StateDir, "registry-proxy")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	manager := &dockerRegistryProxyManager{
		plugin: plugin, directory: directory, trustRoot: "/etc/docker/certs.d", bindings: map[string]*registryProxyBinding{},
	}
	if plugin.cfg.Docker.Mode == "builder" {
		manager.trustRoot = filepath.Join(plugin.cfg.StateDir, "builder-registry-trust")
	}
	if value := strings.TrimSpace(os.Getenv("GATEWAY_DOCKER_CERTS_DIR")); value != "" {
		manager.trustRoot = value
	}
	if err := manager.loadOrCreateIdentity(); err != nil {
		return nil, err
	}
	manager.adoptKeptListener()
	return manager, nil
}

func (m *dockerRegistryProxyManager) sync(command *pb.SyncDockerRegistryBindingsCommand) (registryProxyStatus, error) {
	if command == nil {
		return registryProxyStatus{}, errors.New("docker registry bindings are required")
	}
	now := time.Now()
	next := make(map[string]*registryProxyBinding, len(command.Bindings))
	repositories := map[string]struct{}{}
	for _, input := range command.Bindings {
		if input == nil || !proxySecureLinkIDPattern.MatchString(input.BindingId) || input.RelayOwnerKind != registryRelayOwnerKind || input.RelayOwnerId != input.BindingId {
			return registryProxyStatus{}, errors.New("invalid registry relay binding identity")
		}
		if input.LocalAddress != registryProxyAddress || input.LocalPort != registryProxyPort {
			return registryProxyStatus{}, errors.New("registry proxy endpoint is immutable")
		}
		if !registryRepositoryPattern.MatchString(input.Repository) {
			return registryProxyStatus{}, errors.New("invalid registry repository")
		}
		if _, exists := repositories[input.Repository]; exists {
			return registryProxyStatus{}, fmt.Errorf("duplicate registry repository %s", input.Repository)
		}
		repositories[input.Repository] = struct{}{}
		actions, err := validateRegistryBindingActions(input.Role, input.Actions)
		if err != nil {
			return registryProxyStatus{}, err
		}
		if err := validateRegistryBindingProfile(m.plugin.cfg.Docker.Mode, input.Role); err != nil {
			return registryProxyStatus{}, err
		}
		expiresAt := time.Unix(input.AuthorizationExpiresAtUnix, 0)
		if !strings.HasPrefix(input.Authorization, "Bearer ") || !expiresAt.After(now.Add(5*time.Second)) || expiresAt.After(now.Add(10*time.Minute)) {
			return registryProxyStatus{}, errors.New("registry authorization is missing, expired, or exceeds the maximum lifetime")
		}
		if current := m.currentBinding(input.BindingId); current != nil && input.Generation < current.generation {
			return registryProxyStatus{}, fmt.Errorf("stale registry binding generation for %s", input.BindingId)
		}
		next[input.BindingId] = &registryProxyBinding{
			id: input.BindingId, role: input.Role, generation: input.Generation, repository: input.Repository,
			actions: actions, authorization: input.Authorization, expiresAt: expiresAt, active: map[net.Conn]struct{}{},
		}
	}

	m.mu.Lock()
	for id, current := range m.bindings {
		if replacement := next[id]; replacement != nil {
			replacement.active = current.active
			continue
		}
		for connection := range current.active {
			_ = connection.Close()
		}
	}
	m.bindings = next
	shouldStart := len(next) > 0 && m.listener == nil && !m.handingOver
	shouldStop := len(next) == 0 && m.listener != nil
	m.mu.Unlock()

	if shouldStop {
		m.stopListener()
	}
	if shouldStart {
		if err := m.startListener(); err != nil {
			m.failClosed()
			return registryProxyStatus{}, err
		}
	}
	if len(next) > 0 {
		if err := m.installDockerTrust(); err != nil {
			m.failClosed()
			return registryProxyStatus{}, err
		}
	}
	return registryProxyStatus{Address: registryProxyAddress, Port: registryProxyPort, ServerName: registryProxyServer, CAPEM: string(m.currentCAPEM()), Bindings: len(next)}, nil
}

func validateRegistryBindingProfile(mode, role string) error {
	if mode == "builder" && role != "builder" {
		return errors.New("builder profile accepts only builder registry bindings")
	}
	if mode != "builder" && role != "runtime" && role != "mirror" {
		return errors.New("runtime profile accepts only runtime or mirror registry bindings")
	}
	return nil
}

func validateRegistryBindingActions(role string, values []string) (map[string]struct{}, error) {
	if role != "builder" && role != "runtime" && role != "mirror" {
		return nil, errors.New("registry binding role must be builder, runtime, or mirror")
	}
	actions := map[string]struct{}{}
	for _, action := range values {
		if action != "pull" && action != "push" {
			return nil, errors.New("registry binding action must be pull or push")
		}
		if role == "runtime" && action != "pull" {
			return nil, errors.New("runtime registry bindings are pull-only")
		}
		actions[action] = struct{}{}
	}
	if len(actions) == 0 {
		return nil, errors.New("registry binding requires at least one action")
	}
	return actions, nil
}

func (m *dockerRegistryProxyManager) currentBinding(id string) *registryProxyBinding {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.bindings[id]
}

func (m *dockerRegistryProxyManager) startListener() error {
	listener, keptName, err := m.listenKept()
	if err != nil {
		return fmt.Errorf("listen for registry proxy: %w", err)
	}
	tlsListener := tls.NewListener(listener, &tls.Config{GetCertificate: m.getCertificate, MinVersion: tls.VersionTLS13})
	server := &http.Server{Handler: http.HandlerFunc(m.serveHTTP), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	m.mu.Lock()
	if m.listener != nil || len(m.bindings) == 0 || m.handingOver {
		m.mu.Unlock()
		_ = tlsListener.Close()
		if keptName != "" {
			_ = listenerkeep.Drop(keptName)
		}
		return nil
	}
	m.listener = tlsListener
	m.keptName = keptName
	m.server = server
	m.mu.Unlock()
	go func() {
		if err := server.Serve(tlsListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			m.mu.RLock()
			handingOver := m.handingOver
			m.mu.RUnlock()
			if handingOver {
				return // the socket went to the next process
			}
			m.plugin.logger.Error("registry proxy stopped", "error", err)
			m.failClosed()
		}
	}()
	return nil
}

func (m *dockerRegistryProxyManager) stopListener() {
	m.mu.Lock()
	server, listener, keptName := m.server, m.listener, m.keptName
	m.server, m.listener, m.keptName = nil, nil, ""
	m.mu.Unlock()
	if keptName != "" {
		_ = listenerkeep.Drop(keptName)
	}
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = server.Shutdown(ctx)
		cancel()
	}
	if listener != nil {
		_ = listener.Close()
	}
}

func (m *dockerRegistryProxyManager) failClosed() {
	m.mu.Lock()
	bindings := m.bindings
	m.bindings = map[string]*registryProxyBinding{}
	m.mu.Unlock()
	for _, binding := range bindings {
		for connection := range binding.active {
			_ = connection.Close()
		}
	}
	m.stopListener()
}

func (m *dockerRegistryProxyManager) reconcileGrants() {
	m.mu.Lock()
	defer m.mu.Unlock()
	bundle := m.plugin.relayGrants.get()
	for _, binding := range m.bindings {
		if findRelayAssignment(bundle, "connect", registryRelayOwnerKind, binding.id) != nil {
			continue
		}
		for connection := range binding.active {
			_ = connection.Close()
		}
	}
}

func (m *dockerRegistryProxyManager) serveHTTP(response http.ResponseWriter, request *http.Request) {
	repository, action, ok := registryRequestScope(request.Method, request.URL.Path)
	if !ok {
		http.Error(response, "registry request is outside the configured repository scope", http.StatusForbidden)
		return
	}
	binding := m.bindingForRepository(repository, action)
	if binding == nil {
		http.Error(response, "registry authorization is unavailable", http.StatusServiceUnavailable)
		return
	}
	request = request.Clone(request.Context())
	request.URL.RawQuery = sanitizeRegistryProxyQuery(request.Method, request.URL.Path, request.URL.Query()).Encode()
	request.URL.Scheme = "http"
	request.URL.Host = "registry.internal"
	request.Host = "registry.internal"
	request.RequestURI = ""
	request.Header.Del("Authorization")
	request.Header.Set("Authorization", binding.authorization)
	request.Header.Del("Forwarded")
	request.Header.Del("X-Forwarded-For")
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return m.openRelayConnection(ctx, binding)
		},
	}
	defer transport.CloseIdleConnections()
	upstream, err := roundTripRegistryRead(request, transport.RoundTrip)
	if err != nil {
		http.Error(response, "internal registry is unavailable", http.StatusBadGateway)
		return
	}
	defer upstream.Body.Close()
	for key, values := range upstream.Header {
		for _, value := range values {
			if strings.EqualFold(key, "Location") {
				value = rewriteRegistryLocation(value)
			}
			response.Header().Add(key, value)
		}
	}
	response.WriteHeader(upstream.StatusCode)
	_, _ = io.Copy(response, upstream.Body)
}

func sanitizeRegistryProxyQuery(method, path string, values url.Values) url.Values {
	next := make(url.Values, len(values))
	for key, items := range values {
		next[key] = append([]string(nil), items...)
	}
	if method == http.MethodPost && strings.HasSuffix(path, "/blobs/uploads/") {
		// BuildKit opportunistically asks the registry to mount a blob from a
		// different build repository. Builder credentials are deliberately scoped
		// to exactly one output repository, so forwarding that request produces an
		// auth challenge for the foreign source repository. Keep the boundary
		// fail-closed and force a normal upload into the authorized repository.
		next.Del("mount")
		next.Del("from")
	}
	return next
}

func rewriteRegistryLocation(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() || parsed.User != nil {
		return value
	}
	if parsed.Scheme != "http" || !strings.EqualFold(parsed.Hostname(), "registry.internal") {
		return value
	}
	if port := parsed.Port(); port != "" && port != "5000" {
		return value
	}
	parsed.Scheme = "https"
	parsed.Host = fmt.Sprintf("%s:%d", registryProxyAddress, registryProxyPort)
	return parsed.String()
}

func (m *dockerRegistryProxyManager) bindingForRepository(repository, action string) *registryProxyBinding {
	m.mu.RLock()
	defer m.mu.RUnlock()
	now := time.Now()
	for _, binding := range m.bindings {
		if repository != "" && binding.repository != repository {
			continue
		}
		if _, allowed := binding.actions[action]; !allowed && repository != "" {
			continue
		}
		if binding.expiresAt.After(now.Add(5 * time.Second)) {
			return binding
		}
	}
	return nil
}

func registryRequestScope(method, path string) (string, string, bool) {
	if path == "/v2/" || path == "/v2" {
		if method == http.MethodGet || method == http.MethodHead {
			return "", "pull", true
		}
		return "", "", false
	}
	if !strings.HasPrefix(path, "/v2/") || strings.Contains(path, "/_catalog") {
		return "", "", false
	}
	if method == http.MethodDelete {
		return "", "", false
	}
	remainder := strings.TrimPrefix(path, "/v2/")
	end := len(remainder)
	for _, marker := range []string{"/manifests/", "/blobs/", "/tags/", "/referrers/"} {
		if index := strings.Index(remainder, marker); index >= 0 && index < end {
			end = index
		}
	}
	if end == len(remainder) || !registryRepositoryPattern.MatchString(remainder[:end]) {
		return "", "", false
	}
	action := "pull"
	if method != http.MethodGet && method != http.MethodHead {
		action = "push"
	}
	return remainder[:end], action, true
}

func (m *dockerRegistryProxyManager) openRelayConnection(ctx context.Context, binding *registryProxyBinding) (net.Conn, error) {
	assignment := m.plugin.relayGrants.lookup("connect", registryRelayOwnerKind, binding.id)
	if assignment == nil {
		return nil, errors.New("registry relay grant is unavailable")
	}
	candidates := relaybridge.PoolCandidates(assignment, false)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.Grant}}
	}
	// The tunnel is open before the dial returns, so a relay that refuses it is
	// followed by the next candidate instead of failing the request.
	route := relayRouteKey(registryRelayOwnerKind, binding.id)
	refusal := errors.New("registry relay lane is unavailable")
	for _, candidate := range m.plugin.orderRelayCandidates(route, candidates, "") {
		router := m.plugin.relayRouter(candidate.GetRelayInstanceId())
		if router == nil || candidate.GetGrant() == nil {
			continue
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// A relay demoted for its admission pressure takes what it refused only at a paced rate (pulls retry).
		if held := m.plugin.relayPenalties.HoldDemoted(candidate.GetRelayInstanceId(), route); held != nil {
			refusal = held
			continue
		}
		tunnel, err := router.openSource(candidate.GetGrant())
		m.plugin.recordRelayOpen(candidate.GetRelayInstanceId(), route, err)
		if err != nil {
			refusal = err
			continue
		}
		// Registry streams end at the local relay: never resumable.
		tunnel.localService = true
		client, relaySide := net.Pipe()
		m.trackConnection(binding.id, client, true)
		go func() {
			defer relaySide.Close()
			tunnel.bridge(relaySide)
		}()
		connection := &trackedRegistryConnection{Conn: client, closed: make(chan struct{}), close: func() { m.trackConnection(binding.id, client, false) }}
		// The transport never cancels a dial context once the dial succeeded:
		// waiting for it alone kept this goroutine for the life of the process.
		go func() {
			select {
			case <-ctx.Done():
				_ = client.Close()
			case <-connection.closed:
			}
		}()
		return connection, nil
	}
	return nil, refusal
}

type trackedRegistryConnection struct {
	net.Conn
	once   sync.Once
	closed chan struct{}
	close  func()
}

func (c *trackedRegistryConnection) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		close(c.closed)
		c.close()
	})
	return err
}

func (m *dockerRegistryProxyManager) trackConnection(bindingID string, connection net.Conn, add bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	binding := m.bindings[bindingID]
	if binding == nil {
		_ = connection.Close()
		return
	}
	if add {
		binding.active[connection] = struct{}{}
	} else {
		delete(binding.active, connection)
	}
}

func (m *dockerRegistryProxyManager) installDockerTrust() error {
	// Serialized with identity renewal so a sync never overwrites the trust
	// written for a CA that is being swapped in.
	m.identityMu.Lock()
	defer m.identityMu.Unlock()
	return m.writeDockerTrust(m.currentCAPEM())
}

func (m *dockerRegistryProxyManager) dockerTrustPath() string {
	return filepath.Join(m.trustRoot, fmt.Sprintf("%s:%d", registryProxyAddress, registryProxyPort), "ca.crt")
}

func (m *dockerRegistryProxyManager) writeDockerTrust(caPEM []byte) error {
	if len(caPEM) == 0 {
		return errors.New("registry proxy CA is unavailable")
	}
	path := m.dockerTrustPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create Docker registry trust directory: %w", err)
	}
	// Docker reads ca.crt on every connection: never let it see a partial file.
	return writeRegistryProxyFileAtomic(path, caPEM, 0o644)
}

// currentCAPEM returns the CA of the identity currently served.
func (m *dockerRegistryProxyManager) currentCAPEM() []byte {
	if identity := m.identity.Load(); identity != nil {
		return identity.caPEM
	}
	return nil
}

// getCertificate serves the current leaf, so a reissued certificate is used
// by the running listener for every new handshake.
func (m *dockerRegistryProxyManager) getCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	identity := m.identity.Load()
	if identity == nil || identity.cert == nil {
		return nil, errors.New("registry proxy certificate is unavailable")
	}
	return identity.cert, nil
}

// Registry proxy identity lifetimes. The leaf is renewed once a third of its
// lifetime or 30 days remain. It is reissued from the stored CA while the CA
// has more than a year left; otherwise, or when the CA key was never stored
// (installs before ca-key.pem existed), the CA is regenerated too.
const (
	registryProxyCAValidityYears       = 10
	registryProxyLeafValidityYears     = 2
	registryProxyLeafRenewBefore       = 30 * 24 * time.Hour
	registryProxyCAMinRemaining        = 365 * 24 * time.Hour
	registryProxyIdentityCheckInterval = 12 * time.Hour
)

type registryProxyIdentityOutcome string

const (
	registryProxyIdentityUnchanged     registryProxyIdentityOutcome = "unchanged"
	registryProxyIdentityLeafReissued  registryProxyIdentityOutcome = "leaf_reissued"
	registryProxyIdentityCARegenerated registryProxyIdentityOutcome = "ca_regenerated"
)

func (m *dockerRegistryProxyManager) loadOrCreateIdentity() error {
	_, err := m.refreshIdentity(time.Now())
	return err
}

// runIdentityRenewal re-checks the served identity every 12 hours until ctx
// ends, reissuing the leaf (or the CA) before it expires.
func (m *dockerRegistryProxyManager) runIdentityRenewal(ctx context.Context) {
	ticker := time.NewTicker(registryProxyIdentityCheckInterval)
	defer ticker.Stop()
	for {
		if _, err := m.refreshIdentity(time.Now()); err != nil {
			m.log().Warn("registry proxy certificate check failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// refreshIdentity loads the stored identity, renews whatever is due and
// publishes the result to the listener. It reports the outcome.
func (m *dockerRegistryProxyManager) refreshIdentity(now time.Time) (registryProxyIdentityOutcome, error) {
	m.identityMu.Lock()
	defer m.identityMu.Unlock()

	previous := m.identity.Load()
	identity, outcome, reason, err := loadOrRenewRegistryProxyIdentity(m.directory, now)
	if err != nil {
		return outcome, err
	}
	caChanged := outcome == registryProxyIdentityCARegenerated ||
		(previous != nil && !bytes.Equal(previous.caPEM, identity.caPEM))
	trustUpdated := false
	if caChanged && m.shouldRefreshDockerTrust() {
		trust := identity.caPEM
		if previous != nil && !bytes.Equal(previous.caPEM, identity.caPEM) {
			// Trust both CAs across the swap so a handshake that already got
			// the old leaf still verifies. The next binding sync rewrites the
			// file with the new CA only.
			trust = append(append([]byte{}, identity.caPEM...), previous.caPEM...)
		}
		if err := m.writeDockerTrust(trust); err != nil {
			// Keep serving the previous identity; the next check retries.
			return outcome, fmt.Errorf("install renewed registry proxy CA: %w", err)
		}
		trustUpdated = true
	} else if repaired, err := m.repairDockerTrust(identity.caPEM); err != nil {
		m.log().Warn("registry proxy Docker trust does not match its CA and could not be rewritten", "error", err)
	} else if repaired {
		trustUpdated = true
		m.log().Info("registry proxy Docker trust rewritten to match its CA")
	}
	m.identity.Store(identity)
	if outcome != registryProxyIdentityUnchanged {
		m.log().Info("registry proxy certificate issued",
			"outcome", string(outcome),
			"reason", reason,
			"expires_at", identity.cert.Leaf.NotAfter.UTC().Format(time.RFC3339),
			"docker_trust_updated", trustUpdated,
		)
	}
	return outcome, nil
}

// repairDockerTrust rewrites an existing certs.d trust file that does not
// contain the served CA, e.g. after a CA swap whose trust write failed before
// a restart. A missing file is left for the next binding sync to install.
func (m *dockerRegistryProxyManager) repairDockerTrust(caPEM []byte) (bool, error) {
	current, err := os.ReadFile(m.dockerTrustPath())
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err == nil && bytes.Contains(current, bytes.TrimSpace(caPEM)) {
		return false, nil
	}
	if err := m.writeDockerTrust(caPEM); err != nil {
		return false, err
	}
	return true, nil
}

// shouldRefreshDockerTrust reports whether Docker already trusts this proxy:
// the trust file exists or bindings are active. Otherwise the next binding
// sync installs the trust.
func (m *dockerRegistryProxyManager) shouldRefreshDockerTrust() bool {
	m.mu.RLock()
	active := len(m.bindings) > 0
	m.mu.RUnlock()
	if active {
		return true
	}
	_, err := os.Stat(m.dockerTrustPath())
	return err == nil
}

func (m *dockerRegistryProxyManager) log() *slog.Logger {
	if m.plugin != nil && m.plugin.logger != nil {
		return m.plugin.logger
	}
	return slog.Default()
}

type registryProxyIdentityPaths struct {
	caCert, caKey, serverCert, serverKey string
}

func newRegistryProxyIdentityPaths(directory string) registryProxyIdentityPaths {
	return registryProxyIdentityPaths{
		caCert:     filepath.Join(directory, "ca.pem"),
		caKey:      filepath.Join(directory, "ca-key.pem"),
		serverCert: filepath.Join(directory, "server.pem"),
		serverKey:  filepath.Join(directory, "server-key.pem"),
	}
}

// loadOrRenewRegistryProxyIdentity returns the stored identity when its leaf
// is healthy, reissues the leaf from the stored CA when possible, and
// otherwise generates a new CA and leaf. Every write is atomic.
func loadOrRenewRegistryProxyIdentity(directory string, now time.Time) (*registryProxyIdentity, registryProxyIdentityOutcome, string, error) {
	paths := newRegistryProxyIdentityPaths(directory)
	caPEM, caCert := readRegistryProxyCA(paths.caCert)
	var caKey *ecdsa.PrivateKey
	if caCert != nil {
		caKey = readRegistryProxyCAKey(paths.caKey, caCert)
	}
	pair, pairErr := tls.LoadX509KeyPair(paths.serverCert, paths.serverKey)
	reason := registryProxyLeafRenewalReason(&pair, pairErr, caCert, now)
	if reason == "" {
		return &registryProxyIdentity{caPEM: caPEM, cert: &pair}, registryProxyIdentityUnchanged, "", nil
	}

	if caKey != nil && registryProxyCAReusable(caCert, now) {
		serverPEM, serverKeyPEM, err := issueRegistryProxyLeaf(caCert, caKey, now)
		if err != nil {
			return nil, registryProxyIdentityUnchanged, reason, err
		}
		cert, err := writeRegistryProxyLeaf(paths, serverPEM, serverKeyPEM)
		if err != nil {
			return nil, registryProxyIdentityUnchanged, reason, err
		}
		return &registryProxyIdentity{caPEM: caPEM, cert: cert}, registryProxyIdentityLeafReissued, reason, nil
	}

	switch {
	case caCert == nil:
		reason += "; CA certificate missing or invalid"
	case caKey == nil:
		reason += "; CA key not stored"
	default:
		reason += "; CA expires within a year"
	}
	newCAPEM, newCACert, newCAKey, err := generateRegistryProxyCA(now)
	if err != nil {
		return nil, registryProxyIdentityUnchanged, reason, err
	}
	serverPEM, serverKeyPEM, err := issueRegistryProxyLeaf(newCACert, newCAKey, now)
	if err != nil {
		return nil, registryProxyIdentityUnchanged, reason, err
	}
	caKeyDER, err := x509.MarshalPKCS8PrivateKey(newCAKey)
	if err != nil {
		return nil, registryProxyIdentityUnchanged, reason, err
	}
	caKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: caKeyDER})
	// A crash between these writes leaves a CA key that does not match
	// ca.pem (ignored) or a leaf not signed by ca.pem (reissued next load).
	if err := writeRegistryProxyFileAtomic(paths.caKey, caKeyPEM, 0o600); err != nil {
		return nil, registryProxyIdentityUnchanged, reason, fmt.Errorf("write registry proxy CA key: %w", err)
	}
	if err := writeRegistryProxyFileAtomic(paths.caCert, newCAPEM, 0o644); err != nil {
		return nil, registryProxyIdentityUnchanged, reason, fmt.Errorf("write registry proxy CA: %w", err)
	}
	cert, err := writeRegistryProxyLeaf(paths, serverPEM, serverKeyPEM)
	if err != nil {
		return nil, registryProxyIdentityUnchanged, reason, err
	}
	return &registryProxyIdentity{caPEM: newCAPEM, cert: cert}, registryProxyIdentityCARegenerated, reason, nil
}

// registryProxyLeafRenewalReason explains why the stored leaf must be
// renewed, or returns "" when it is healthy. On success it sets pair.Leaf.
func registryProxyLeafRenewalReason(pair *tls.Certificate, pairErr error, caCert *x509.Certificate, now time.Time) string {
	if pairErr != nil || len(pair.Certificate) == 0 {
		return "server certificate missing or invalid"
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return "server certificate unparseable"
	}
	pair.Leaf = leaf
	if caCert == nil {
		return "CA certificate missing or invalid"
	}
	if caCert.NotAfter.Sub(now) <= registryProxyLeafRenewBefore {
		return "CA certificate expires within 30 days"
	}
	if err := leaf.CheckSignatureFrom(caCert); err != nil {
		return "server certificate is not signed by the stored CA"
	}
	if leaf.VerifyHostname(registryProxyServer) != nil {
		return "server certificate does not cover the registry proxy address"
	}
	if now.Before(leaf.NotBefore) {
		return "server certificate is not valid yet"
	}
	lifetime := leaf.NotAfter.Sub(leaf.NotBefore)
	remaining := leaf.NotAfter.Sub(now)
	if remaining <= registryProxyLeafRenewBefore || remaining <= lifetime/3 {
		return fmt.Sprintf("server certificate expires in %s", remaining.Round(time.Hour))
	}
	return ""
}

func registryProxyCAReusable(caCert *x509.Certificate, now time.Time) bool {
	return caCert != nil && caCert.IsCA && !now.Before(caCert.NotBefore) &&
		caCert.NotAfter.Sub(now) > registryProxyCAMinRemaining
}

func readRegistryProxyCA(path string) ([]byte, *x509.Certificate) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, nil
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !cert.IsCA {
		return nil, nil
	}
	return data, cert
}

// readRegistryProxyCAKey returns the stored CA key when it belongs to caCert.
func readRegistryProxyCAKey(path string, caCert *x509.Certificate) *ecdsa.PrivateKey {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil
	}
	public, ok := caCert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !key.PublicKey.Equal(public) {
		return nil
	}
	return key
}

func generateRegistryProxyCA(now time.Time) ([]byte, *x509.Certificate, *ecdsa.PrivateKey, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, err
	}
	caTemplate := &x509.Certificate{
		SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: "Gateway Registry Proxy CA"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(registryProxyCAValidityYears, 0, 0), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, nil, err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return nil, nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), caCert, caKey, nil
}

// issueRegistryProxyLeaf signs a new server certificate for the proxy
// address, valid for two years but never past the CA.
func issueRegistryProxyLeaf(caCert *x509.Certificate, caKey *ecdsa.PrivateKey, now time.Time) ([]byte, []byte, error) {
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	notAfter := now.AddDate(registryProxyLeafValidityYears, 0, 0)
	if notAfter.After(caCert.NotAfter) {
		notAfter = caCert.NotAfter
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: registryProxyServer},
		NotBefore: now.Add(-time.Minute), NotAfter: notAfter,
		IPAddresses: []net.IP{net.ParseIP(registryProxyAddress)}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCert, &serverKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	serverKeyDER, err := x509.MarshalPKCS8PrivateKey(serverKey)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: serverKeyDER}), nil
}

// writeRegistryProxyLeaf installs the key before the certificate; a crash in
// between leaves a mismatched pair that the next load reissues.
func writeRegistryProxyLeaf(paths registryProxyIdentityPaths, serverPEM, serverKeyPEM []byte) (*tls.Certificate, error) {
	cert, err := tls.X509KeyPair(serverPEM, serverKeyPEM)
	if err != nil {
		return nil, err
	}
	if cert.Leaf == nil {
		if cert.Leaf, err = x509.ParseCertificate(cert.Certificate[0]); err != nil {
			return nil, err
		}
	}
	if err := writeRegistryProxyFileAtomic(paths.serverKey, serverKeyPEM, 0o600); err != nil {
		return nil, fmt.Errorf("write registry proxy server key: %w", err)
	}
	if err := writeRegistryProxyFileAtomic(paths.serverCert, serverPEM, 0o644); err != nil {
		return nil, fmt.Errorf("write registry proxy server certificate: %w", err)
	}
	return &cert, nil
}

// writeRegistryProxyFileAtomic replaces path with data through a synced temporary file in
// the same directory, so readers see the old or the new content only.
func writeRegistryProxyFileAtomic(path string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	cleanup := func() { _ = os.Remove(temp) }
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		cleanup()
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		cleanup()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		cleanup()
		return err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		cleanup()
		return err
	}
	return nil
}

func randomSerial() *big.Int {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	value, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return big.NewInt(time.Now().UnixNano())
	}
	return value
}

func (p *DockerPlugin) SyncDockerRegistryBindings(command *pb.SyncDockerRegistryBindingsCommand) (string, error) {
	if p.registryProxy == nil {
		return "", errors.New("docker registry proxy is unavailable")
	}
	status, err := p.registryProxy.sync(command)
	if err != nil {
		return "", err
	}
	p.reconcileRelayRegistrations()
	detail, err := json.Marshal(status)
	return string(detail), err
}

func sortedRegistryBindingIDs(bindings map[string]*registryProxyBinding) []string {
	ids := make([]string, 0, len(bindings))
	for id := range bindings {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
