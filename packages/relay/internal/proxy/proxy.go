package proxy

import (
	"context"
	"io"
	"strings"
	"sync"

	"github.com/opfield/opfield/relay/internal/codec"
	"github.com/opfield/opfield/relay/internal/peer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	opfieldPackagePrefix = "/opfield.v1."
	// legacy-name: gateway.v1 package — remove once every node reports none
	legacyPackagePrefix = "/gateway.v1."
	enrollmentService   = "NodeEnrollment/Enroll"
	// MetadataPrefix starts every identity header the relay forwards to
	// Opfield. A client's own header with this or the legacy prefix is
	// dropped, so only the relay can set them.
	MetadataPrefix = "x-opfield-relay-"
	// legacy-name: x-wiolett-relay-* headers — remove once every node reports none.
	// Still stripped from client metadata: an Opfield that reads them trusts
	// them only from a relay, never from the client behind it.
	legacyMetadataPrefix = "x-wiolett-relay-"
	// MetadataCapability tells Opfield this relay forwards the identity of a
	// verified daemon as x-opfield-relay-* and strips client headers with
	// either prefix.
	MetadataCapability = "relay_metadata_opfield_v1"
)

// proxiedMethod reports whether method belongs to the Opfield control API the
// local relay proxies, under its current or its legacy package name.
func proxiedMethod(method string) bool {
	return strings.HasPrefix(method, opfieldPackagePrefix) || strings.HasPrefix(method, legacyPackagePrefix)
}

// enrollmentMethod reports the one method a client without a certificate may call.
func enrollmentMethod(method string) bool {
	return method == opfieldPackagePrefix+enrollmentService || method == legacyPackagePrefix+enrollmentService
}

// upstreamConn is one connection to Opfield and the number of proxied RPCs on it.
type upstreamConn struct {
	conn    *grpc.ClientConn
	active  int
	retired bool
}

type Handler struct {
	mu       sync.Mutex
	current  *upstreamConn
	retiring map[*upstreamConn]struct{}
	connect  func() (*grpc.ClientConn, error)
}

func New(upstream *grpc.ClientConn, connect func() (*grpc.ClientConn, error)) *Handler {
	return &Handler{current: &upstreamConn{conn: upstream}, retiring: map[*upstreamConn]struct{}{}, connect: connect}
}

// ReloadUpstream moves new RPCs onto a fresh connection, which presents the
// relay's reloaded client certificate to Opfield. Closing the previous
// connection would cancel every daemon stream proxied over it, so RPCs already
// running keep it until they end, and it closes after the last one.
func (h *Handler) ReloadUpstream() error {
	next, err := h.connect()
	if err != nil {
		return err
	}
	h.mu.Lock()
	previous := h.current
	if previous.conn == next {
		h.mu.Unlock()
		return nil
	}
	h.current = &upstreamConn{conn: next}
	previous.retired = true
	idle := previous.active == 0
	if !idle {
		h.retiring[previous] = struct{}{}
	}
	h.mu.Unlock()
	if idle {
		return previous.conn.Close()
	}
	return nil
}

func (h *Handler) Close() error {
	h.mu.Lock()
	connections := []*grpc.ClientConn{h.current.conn}
	for retired := range h.retiring {
		connections = append(connections, retired.conn)
	}
	h.retiring = map[*upstreamConn]struct{}{}
	h.mu.Unlock()
	var first error
	for _, connection := range connections {
		if err := connection.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (h *Handler) acquire() *upstreamConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.current.active++
	return h.current
}

func (h *Handler) release(used *upstreamConn) {
	h.mu.Lock()
	used.active--
	idleRetired := used.retired && used.active == 0
	if idleRetired {
		delete(h.retiring, used)
	}
	h.mu.Unlock()
	if idleRetired {
		_ = used.conn.Close()
	}
}

func (h *Handler) Handle(_ any, downstream grpc.ServerStream) error {
	method, ok := grpc.MethodFromServerStream(downstream)
	if !ok || !proxiedMethod(method) {
		return status.Error(codes.Unimplemented, "relay method is not registered")
	}
	identity, authenticated := peer.FromContext(downstream.Context())
	if !enrollmentMethod(method) && !authenticated {
		return status.Error(codes.Unauthenticated, "verified daemon certificate required")
	}
	incoming, _ := metadata.FromIncomingContext(downstream.Context())
	outgoing := sanitizeMetadata(incoming)
	if authenticated {
		outgoing.Set(MetadataPrefix+"node-id", identity.SubjectID)
		outgoing.Set(MetadataPrefix+"cert-serial", identity.CertificateSerial)
		outgoing.Set(MetadataPrefix+"cert-sha256", identity.CertificateFingerprint)
	}
	used := h.acquire()
	defer h.release(used)
	ctx, cancel := context.WithCancel(metadata.NewOutgoingContext(downstream.Context(), outgoing))
	defer cancel()
	upstream, err := used.conn.NewStream(ctx, &grpc.StreamDesc{ServerStreams: true, ClientStreams: true}, method, grpc.ForceCodec(codec.Codec{}))
	if err != nil {
		return err
	}
	clientResult := make(chan error, 1)
	go func() {
		for {
			var frame codec.Frame
			if err := downstream.RecvMsg(&frame); err != nil {
				if err == io.EOF {
					clientResult <- upstream.CloseSend()
					return
				}
				clientResult <- err
				// The receive loop below blocks on the upstream; end it too.
				cancel()
				return
			}
			if err := upstream.SendMsg(&frame); err != nil {
				clientResult <- err
				cancel()
				return
			}
		}
	}()
	header, err := upstream.Header()
	if err != nil {
		return err
	}
	if len(header) > 0 {
		if err := downstream.SendHeader(header); err != nil {
			return err
		}
	}
	for {
		var frame codec.Frame
		recvErr := upstream.RecvMsg(&frame)
		if recvErr != nil {
			downstream.SetTrailer(upstream.Trailer())
			if recvErr == io.EOF {
				return nil
			}
			select {
			case clientErr := <-clientResult:
				if clientErr != nil && clientErr != io.EOF {
					return clientErr
				}
			default:
			}
			return recvErr
		}
		if err := downstream.SendMsg(&frame); err != nil {
			return err
		}
		select {
		case clientErr := <-clientResult:
			if clientErr != nil && clientErr != io.EOF {
				return clientErr
			}
		default:
		}
	}
}

func sanitizeMetadata(source metadata.MD) metadata.MD {
	result := metadata.MD{}
	for key, values := range source {
		lower := strings.ToLower(key)
		if strings.HasPrefix(lower, MetadataPrefix) || strings.HasPrefix(lower, legacyMetadataPrefix) {
			continue
		}
		result[key] = append([]string(nil), values...)
	}
	return result
}
