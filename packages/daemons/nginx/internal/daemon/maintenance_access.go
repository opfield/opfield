package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

const maintenanceAccessSocketPath = "/run/nginx-daemon/maintenance-access.sock"

var maintenanceAccessHostID = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

const (
	// The access cookies a redeemed code sets; route configs check them with secure_link.
	maintenanceAccessSignatureCookie = "opfield_maintenance_access_sig"
	maintenanceAccessExpiryCookie    = "opfield_maintenance_access_exp"
	// maintenanceAccessHostMetadata carries the requested host to Opfield.
	maintenanceAccessHostMetadata = "x-opfield-maintenance-host"
)

// maintenanceAccessHeader is a header nginx adds to a redemption (X-Opfield-Maintenance-<name>).
func maintenanceAccessHeader(r *http.Request, name string) string {
	if value := r.Header.Get("X-Opfield-Maintenance-" + name); value != "" {
		return value
	}
	// legacy-name: X-Gateway-Maintenance-* of route configs rendered for the pre-Opfield names — remove once every node reports none
	return r.Header.Get("X-Gateway-Maintenance-" + name)
}

type maintenanceAccessServer struct {
	listener net.Listener
	keptName string
	server   *http.Server
}

func startMaintenanceAccessServer(conn *grpc.ClientConn, logger interface{ Warn(string, ...any) }) (*maintenanceAccessServer, error) {
	if err := os.MkdirAll(filepath.Dir(maintenanceAccessSocketPath), 0o755); err != nil {
		return nil, err
	}
	// The socket the previous process kept is taken over (service_sockets.go).
	listener, keptName, err := listenServiceSocket(maintenanceAccessSocketPath)
	if err != nil {
		return nil, err
	}

	mux := maintenanceAccessHandler(pb.NewMaintenanceAccessClient(conn), logger)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("maintenance access socket stopped", "error", err)
		}
	}()
	return &maintenanceAccessServer{listener: listener, keptName: keptName, server: server}, nil
}

// close ends the server: for good, or, once the daemon handed its sockets to the next process (handedOver), only
// this process's part of the socket.
func (s *maintenanceAccessServer) close(handedOver bool) {
	if s == nil {
		return
	}
	remove := releaseServiceSocket(s.listener, maintenanceAccessSocketPath, s.keptName, handedOver)
	_ = s.server.Close()
	_ = s.listener.Close()
	remove()
}

// maintenanceAccessHandler redeems an access code the maintenance page posts. 204 sets the access cookies; 403 means
// the code was not accepted (wrong, expired, already used, for another route or host), and the page says so; 502
// means Opfield could not be asked.
func maintenanceAccessHandler(client pb.MaintenanceAccessClient, logger interface{ Warn(string, ...any) }) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/redeem/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		hostID := strings.TrimPrefix(r.URL.Path, "/redeem/")
		if !maintenanceAccessHostID.MatchString(hostID) || strings.Contains(hostID, "/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 512)).Decode(&body); err != nil || len(body.Code) < 32 || len(body.Code) > 128 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		requestHost := maintenanceAccessHeader(r, "Host")
		if requestHost == "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs(maintenanceAccessHostMetadata, requestHost))
		reply, err := client.Redeem(ctx, &pb.MaintenanceAccessRedeemRequest{HostId: hostID, Code: body.Code})
		if err != nil {
			logger.Warn("maintenance access redemption failed", "error", err)
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if !reply.Allowed || reply.SessionToken == "" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		signature, expires, ok := strings.Cut(reply.SessionToken, ",")
		if !ok || signature == "" || expires == "" {
			logger.Warn("maintenance access redemption returned an invalid session token")
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		secure := maintenanceAccessHeader(r, "Secure") == "on"
		// The names the route configs of this node check: those of the names in effect (naming.Render).
		http.SetCookie(w, &http.Cookie{
			Name:     naming.Render(maintenanceAccessSignatureCookie),
			Value:    signature,
			Path:     "/",
			MaxAge:   60 * 60,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
		http.SetCookie(w, &http.Cookie{
			Name:     naming.Render(maintenanceAccessExpiryCookie),
			Value:    expires,
			Path:     "/",
			MaxAge:   60 * 60,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
		w.WriteHeader(http.StatusNoContent)
	})

	return mux
}
