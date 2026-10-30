package daemon

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/access"
)

// accessSocketPath is where nginx asks whether a request to a route with an access list may pass (auth_request).
const accessSocketPath = "/run/nginx-daemon/access.sock"

// accessAuthCapability: the node answers access checks on accessSocketPath from the policy Opfield syncs
// (SyncAccessPolicyCommand), and its nginx has the auth_request module route configs use.
const accessAuthCapability = "nginx_access_auth_v1"

// accessSignInCapability: the access socket also serves the route's own sign-in page under /ui/ (route configs
// proxy /_opfield/access/ there) and asks Opfield about its sign-ins over the daemon's control channel.
const accessSignInCapability = "nginx_access_signin_v3"

// accessServer serves the access socket. It does not depend on the control session: access keeps working from the
// persisted policy while Opfield is unreachable.
type accessServer struct {
	handler  *access.Server
	listener net.Listener
	keptName string
	server   *http.Server
	done     chan struct{}
}

// startAccessServer serves the access socket. Only nginx's workers ask it (auth_request): like the maintenance access
// socket it is 0660 and belongs to their group (workerGID), 0666 when the daemon cannot give it to that group.
func startAccessServer(store *access.Store, logger interface{ Warn(string, ...any) }, workerGID func() (int, error)) (*accessServer, error) {
	if err := os.MkdirAll(filepath.Dir(accessSocketPath), 0o755); err != nil {
		return nil, err
	}
	// The socket the previous process kept is taken over (service_sockets.go): checks nginx sends during a restart
	// or update wait in the backlog.
	listener, keptName, err := listenServiceSocket(accessSocketPath, 0o660)
	if err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go grantSocketToGroup(accessSocketPath, workerGID, maintenanceAccessGroupRetry, done, logger)
	handler := access.NewServer(store)
	handler.SetLogger(logger)
	// The sign-in page waits for Opfield at most signInTimeout (8 s) per question.
	server := &http.Server{Handler: handler.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("access socket stopped", "error", err)
		}
	}()
	return &accessServer{handler: handler, listener: listener, keptName: keptName, server: server, done: done}, nil
}

// setSignInClient gives the sign-in page the control channel of a session (nil when the session ends): without it
// the page says sign-in is unavailable, while checks keep answering from the persisted policy.
func (s *accessServer) setSignInClient(client pb.AccessSignInClient) {
	if s != nil {
		s.handler.SetSignInClient(client)
	}
}

// close ends the server: for good, or, once the daemon handed its sockets to the next process (handedOver), only
// this process's part of the socket.
func (s *accessServer) close(handedOver bool) {
	if s == nil {
		return
	}
	if s.done != nil {
		close(s.done)
	}
	remove := releaseServiceSocket(s.listener, accessSocketPath, s.keptName, handedOver)
	_ = s.server.Close()
	_ = s.listener.Close()
	remove()
}

// nginxBuildHasAuthRequest reports whether nginx was built with the auth_request module access checks need.
func nginxBuildHasAuthRequest(binary string) (bool, error) {
	output, err := exec.Command(binary, "-V").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("nginx build check failed: %w", err)
	}
	return strings.Contains(string(output), "--with-http_auth_request_module"), nil
}

// startAccess opens the persisted access policy and the access socket. Without the auth_request module or the
// socket the node does not advertise accessAuthCapability; Opfield then renders the IP and basic authentication
// directives it can still enforce.
func (p *NginxPlugin) startAccess(stateDir string) {
	store, err := access.OpenStore(stateDir)
	if err != nil {
		// Checks answer 503 until Opfield syncs the policy again.
		p.logger.Warn("stored access policy is unusable; access-protected routes are closed until Opfield syncs it", "error", err)
	}
	p.accessStore = store
	available, err := nginxBuildHasAuthRequest(p.cfg.Nginx.Binary)
	if err != nil {
		p.logger.Warn("cannot tell whether nginx has the auth_request module; sign-in access lists are disabled", "error", err)
		return
	}
	if !available {
		p.logger.Warn("nginx was built without the auth_request module; sign-in access lists are disabled")
		return
	}
	workers := newNginxPeerAuthority(canonicalExecutablePath(p.cfg.Nginx.Binary), p.mgr.CachedPID)
	server, err := startAccessServer(store, p.logger, workers.workerGroupGID)
	if err != nil {
		p.logger.Warn("access socket is unavailable; sign-in access lists are disabled", "path", accessSocketPath, "error", err)
		return
	}
	p.accessServer = server
}

// accessChecksAvailable reports whether nginx can ask this daemon about the list: Pages previews then check access
// on the access socket instead of rendering the list's fallback directives.
func (p *NginxPlugin) accessChecksAvailable(accessListID string) bool {
	return p.accessServer != nil && p.accessStore.HasList(accessListID)
}

func (h *Handler) handleSyncAccessPolicy(cmd *pb.SyncAccessPolicyCommand, result *pb.CommandResult) {
	if h.accessPolicy == nil {
		result.Success = false
		result.Error = "access checks are unavailable on this node"
		return
	}
	applied, err := h.accessPolicy.Apply(cmd)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("sync access policy: %v", err)
		return
	}
	if !applied {
		result.Detail = fmt.Sprintf("access policy revision %d is not newer than the applied revision %d", cmd.GetRevision(), h.accessPolicy.Policy().Revision)
		return
	}
	result.Detail = fmt.Sprintf("access policy revision %d applied", cmd.Revision)
	h.logger.Info("access policy applied", "revision", cmd.Revision, "lists", len(cmd.Lists))
	// Protected Pages previews switch between access checks and their lists' fallback directives.
	if h.pagesRuntime != nil {
		rendered, err := h.pagesRuntime.RefreshAccessChecks()
		if err != nil {
			h.logger.Warn("some protected Pages previews were not rendered for the new access policy", "error", err)
		}
		if rendered > 0 {
			h.logger.Info("protected Pages previews rendered for the new access policy", "previews", rendered)
		}
	}
}
