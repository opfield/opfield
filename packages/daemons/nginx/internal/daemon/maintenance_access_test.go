package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/grpc"
)

const maintenanceAccessTestHost = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

// fakeMaintenanceAccess accepts one code.
type fakeMaintenanceAccess struct {
	accepted string
	err      error
}

func (f fakeMaintenanceAccess) Redeem(_ context.Context, in *pb.MaintenanceAccessRedeemRequest, _ ...grpc.CallOption) (*pb.MaintenanceAccessReply, error) {
	if f.err != nil {
		return nil, f.err
	}
	if in.Code != f.accepted {
		return &pb.MaintenanceAccessReply{}, nil
	}
	return &pb.MaintenanceAccessReply{Allowed: true, SessionToken: "signature,1700000000"}, nil
}

func redeem(t *testing.T, client pb.MaintenanceAccessClient, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/redeem/"+maintenanceAccessTestHost, strings.NewReader(body))
	request.Header.Set("X-Opfield-Maintenance-Host", "shop.example.com")
	recorder := httptest.NewRecorder()
	maintenanceAccessHandler(client, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(recorder, request)
	return recorder
}

// TestMaintenanceAccessAnswersAWrongCodeWithForbidden: the maintenance page tells the visitor the code was not
// accepted instead of doing nothing.
func TestMaintenanceAccessAnswersAWrongCodeWithForbidden(t *testing.T) {
	good := strings.Repeat("g", 32)
	client := fakeMaintenanceAccess{accepted: good}

	if response := redeem(t, client, `{"code":"`+good+`"}`); response.Code != http.StatusNoContent || len(response.Result().Cookies()) != 2 {
		t.Fatalf("accepted code: status %d, %d cookies; want 204 with the access cookies", response.Code, len(response.Result().Cookies()))
	}
	for name, body := range map[string]string{
		"wrong code":    `{"code":"` + strings.Repeat("w", 32) + `"}`,
		"short code":    `{"code":"short"}`,
		"not JSON":      `code`,
		"no code given": `{}`,
	} {
		response := redeem(t, client, body)
		if response.Code != http.StatusForbidden || len(response.Result().Cookies()) != 0 {
			t.Errorf("%s: status %d with %d cookies, want 403 without cookies", name, response.Code, len(response.Result().Cookies()))
		}
	}
	if response := redeem(t, fakeMaintenanceAccess{err: errors.New("gateway unavailable")}, `{"code":"`+good+`"}`); response.Code != http.StatusBadGateway {
		t.Fatalf("Opfield unavailable: status %d, want 502", response.Code)
	}
}
