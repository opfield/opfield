package controlpath

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

type recordingServer struct {
	pb.UnimplementedNodeEnrollmentServer
	pb.UnimplementedNodeControlServer

	mu    sync.Mutex
	paths []string
}

func (s *recordingServer) note(ctx context.Context) {
	method, _ := grpc.Method(ctx)
	s.mu.Lock()
	s.paths = append(s.paths, method)
	s.mu.Unlock()
}

func (s *recordingServer) seen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.paths...)
}

func (s *recordingServer) Enroll(ctx context.Context, request *pb.EnrollRequest) (*pb.EnrollResponse, error) {
	s.note(ctx)
	return &pb.EnrollResponse{NodeId: "node-for-" + request.GetToken()}, nil
}

// CommandStream answers every daemon message with a command naming the node
// that registered, so the client sees whether its first message arrived.
func (s *recordingServer) CommandStream(stream pb.NodeControl_CommandStreamServer) error {
	s.note(stream.Context())
	for {
		message, err := stream.Recv()
		if err != nil {
			return nil
		}
		if err := stream.Send(&pb.OpfieldCommand{CommandId: "ack-" + message.GetRegister().GetNodeId()}); err != nil {
			return err
		}
	}
}

// serve starts a server with the two services under the given package name:
// The legacy package stands for a 2.12.0 relay, which forwards no other name.
func serve(t *testing.T, packageName string) (*grpc.ClientConn, *recordingServer) {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	impl := &recordingServer{}
	enrollment, control := pb.NodeEnrollment_ServiceDesc, pb.NodeControl_ServiceDesc
	enrollment.ServiceName, control.ServiceName = packageName+".NodeEnrollment", packageName+".NodeControl"
	server.RegisterService(&enrollment, impl)
	server.RegisterService(&control, impl)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient("passthrough:///bufconn", append([]grpc.DialOption{
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return listener.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	}, DialOptions()...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, impl
}

func TestUnaryCallFallsBackOnlyBehindAnOldRelay(t *testing.T) {
	for _, tc := range []struct {
		packageName string
		want        []string
	}{
		{"opfield.v1", []string{"/opfield.v1.NodeEnrollment/Enroll"}},
		{"gateway.v1", []string{"/gateway.v1.NodeEnrollment/Enroll"}},
	} {
		conn, server := serve(t, tc.packageName)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		response, err := pb.NewNodeEnrollmentClient(conn).Enroll(ctx, &pb.EnrollRequest{Token: "tok"})
		cancel()
		if err != nil || response.GetNodeId() != "node-for-tok" {
			t.Fatalf("%s: enroll = %v, %v", tc.packageName, response, err)
		}
		if got := server.seen(); len(got) != 1 || got[0] != tc.want[0] {
			t.Fatalf("%s: server saw %v, want %v", tc.packageName, got, tc.want)
		}
	}
}

func TestStreamReopensUnderTheLegacyNameAndResendsWhatWasSent(t *testing.T) {
	for _, tc := range []struct {
		packageName string
		want        string
	}{
		{"opfield.v1", "/opfield.v1.NodeControl/CommandStream"},
		{"gateway.v1", "/gateway.v1.NodeControl/CommandStream"},
	} {
		conn, server := serve(t, tc.packageName)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		stream, err := pb.NewNodeControlClient(conn).CommandStream(ctx)
		if err != nil {
			cancel()
			t.Fatalf("%s: open: %v", tc.packageName, err)
		}
		register := &pb.DaemonMessage{Payload: &pb.DaemonMessage_Register{Register: &pb.RegisterMessage{NodeId: "n1"}}}
		if err := stream.Send(register); err != nil {
			cancel()
			t.Fatalf("%s: send: %v", tc.packageName, err)
		}
		// The caller may reuse its message after Send.
		register.GetRegister().NodeId = "changed"
		first, err := stream.Recv()
		if err != nil || first.GetCommandId() != "ack-n1" {
			cancel()
			t.Fatalf("%s: first answer = %v, %v", tc.packageName, first, err)
		}
		if err := stream.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_Register{Register: &pb.RegisterMessage{NodeId: "n2"}}}); err != nil {
			cancel()
			t.Fatalf("%s: second send: %v", tc.packageName, err)
		}
		second, err := stream.Recv()
		cancel()
		if err != nil || second.GetCommandId() != "ack-n2" {
			t.Fatalf("%s: second answer = %v, %v", tc.packageName, second, err)
		}
		if got := server.seen(); len(got) != 1 || got[0] != tc.want {
			t.Fatalf("%s: server saw %v, want [%s]", tc.packageName, got, tc.want)
		}
	}
}

func TestLegacyMethod(t *testing.T) {
	if got, ok := LegacyMethod("/opfield.v1.NodeControl/CommandStream"); !ok || got != "/gateway.v1.NodeControl/CommandStream" {
		t.Fatalf("LegacyMethod = %q, %v", got, ok)
	}
	if _, ok := LegacyMethod("/relay.v1.TunnelBroker/Open"); ok {
		t.Fatal("relay.v1 paths have no legacy name")
	}
}
