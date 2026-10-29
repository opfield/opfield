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

// accessServer serves the access socket. It does not depend on the control session: access keeps working from the
// persisted policy while Opfield is unreachable.
type accessServer struct {
	listener net.Listener
	keptName string
	server   *http.Server
}

func startAccessServer(store *access.Store, logger interface{ Warn(string, ...any) }) (*accessServer, error) {
	if err := os.MkdirAll(filepath.Dir(accessSocketPath), 0o755); err != nil {
		return nil, err
	}
	// The socket the previous process kept is taken over (service_sockets.go): checks nginx sends during a restart
	// or update wait in the backlog.
	listener, keptName, err := listenServiceSocket(accessSocketPath)
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: access.NewServer(store).Handler(), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("access socket stopped", "error", err)
		}
	}()
	return &accessServer{listener: listener, keptName: keptName, server: server}, nil
}

// close ends the server: for good, or, once the daemon handed its sockets to the next process (handedOver), only
// this process's part of the socket.
func (s *accessServer) close(handedOver bool) {
	if s == nil {
		return
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
	server, err := startAccessServer(store, p.logger)
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
}
