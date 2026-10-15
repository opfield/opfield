package pages

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

var cloudflareClientIP = &PreviewClientIP{
	TrustedProxies: []string{"173.245.48.0/20", "2400:cb00::/32"},
	Header:         "CF-Connecting-IP",
}

func TestPreviewClientIPRendersRealIPBeforeTheAccessList(t *testing.T) {
	runtime, _ := accessRuntime(t)
	access := &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "203.0.113.7"}}}
	if err := runtime.MaterializePreview(profileID, deploymentID, "cf.pages.example", "", "", PreviewFallback{Access: access, ClientIP: cloudflareClientIP}); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(runtime.previewConfigPath("cf.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"    server_name cf.pages.example;",
		"    set_real_ip_from 173.245.48.0/20;",
		"    set_real_ip_from 2400:cb00::/32;",
		"    real_ip_header CF-Connecting-IP;",
		"    real_ip_recursive on;",
		"    satisfy all;",
		"    allow 203.0.113.7;",
		"    deny all;",
	}, "\n")
	if !strings.Contains(string(config), want) {
		t.Fatalf("client IP directives are missing or out of order:\n%s", config)
	}
}

func TestPreviewWithoutClientIPKeepsThePeerAddress(t *testing.T) {
	runtime, _ := accessRuntime(t)
	if err := runtime.MaterializePreview(profileID, deploymentID, "direct.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(runtime.previewConfigPath("direct.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "real_ip") {
		t.Fatalf("a preview without a client IP source must not trust any header:\n%s", config)
	}
}

func TestPreviewClientIPRejectsWhatNginxWouldMisread(t *testing.T) {
	for name, clientIP := range map[string]*PreviewClientIP{
		"no proxies":     {Header: "X-Real-IP"},
		"header":         {TrustedProxies: []string{"10.0.0.1"}, Header: "X-Evil"},
		"injection":      {TrustedProxies: []string{"10.0.0.1; deny all"}, Header: "X-Real-IP"},
		"all":            {TrustedProxies: []string{"all"}, Header: "X-Real-IP"},
		"unix peer":      {TrustedProxies: []string{"unix:"}, Header: "X-Real-IP"},
		"bad cidr":       {TrustedProxies: []string{"10.0.0.0/33"}, Header: "X-Forwarded-For"},
		"header newline": {TrustedProxies: []string{"10.0.0.1"}, Header: "X-Real-IP\n"},
	} {
		t.Run(name, func(t *testing.T) {
			runtime, _ := accessRuntime(t)
			if err := runtime.MaterializePreview(profileID, deploymentID, "bad.pages.example", "", "", PreviewFallback{ClientIP: clientIP}); err == nil {
				t.Fatal("an invalid client IP source must be rejected")
			}
			if _, err := os.Stat(runtime.previewConfigPath("bad.pages.example")); !os.IsNotExist(err) {
				t.Fatalf("a rejected client IP source must not publish a preview: %v", err)
			}
		})
	}
}

func TestBindingInspectionComparesPreviewClientIP(t *testing.T) {
	r, _, bindings := inspectionFixture(t)
	preview := bindings[1]
	behindCloudflare := preview
	behindCloudflare.ClientIP = cloudflareClientIP
	if got := r.InspectBindings([]BindingExpectation{behindCloudflare}); !reflect.DeepEqual(got.Matches, []bool{false}) {
		t.Fatalf("a new client IP source must force re-materialization: %#v", got)
	}
	if err := r.MaterializePreview(profileID, deploymentID, preview.ID, "", "", PreviewFallback{ClientIP: cloudflareClientIP}); err != nil {
		t.Fatal(err)
	}
	if got := r.InspectBindings([]BindingExpectation{behindCloudflare}); !reflect.DeepEqual(got.Matches, []bool{true}) {
		t.Fatalf("inspection behind Cloudflare: %#v", got)
	}
	// Changed Cloudflare ranges are a different expectation: the preview is rendered again.
	changed := behindCloudflare
	changed.ClientIP = &PreviewClientIP{TrustedProxies: []string{"173.245.48.0/20"}, Header: "CF-Connecting-IP"}
	if got := r.InspectBindings([]BindingExpectation{changed}); !reflect.DeepEqual(got.Matches, []bool{false}) {
		t.Fatalf("changed ranges must force re-materialization: %#v", got)
	}
	var decoded BindingExpectation
	if err := json.Unmarshal([]byte(`{"clientIp":{"trustedProxies":["10.0.0.1"],"header":"X-Real-IP"}}`), &decoded); err != nil ||
		!reflect.DeepEqual(decoded.ClientIP, &PreviewClientIP{TrustedProxies: []string{"10.0.0.1"}, Header: "X-Real-IP"}) {
		t.Fatalf("expectation JSON shape changed: %#v %v", decoded.ClientIP, err)
	}
}
