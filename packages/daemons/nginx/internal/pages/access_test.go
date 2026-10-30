package pages

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const accessListID = "44444444-4444-4444-8444-444444444444"

func accessRuntime(t *testing.T) (*Runtime, string) {
	t.Helper()
	runtime, _ := newRuntime(t)
	htpasswd := filepath.Join(t.TempDir(), "htpasswd")
	if err := os.MkdirAll(htpasswd, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := runtime.SetHtpasswdDir(htpasswd); err != nil {
		t.Fatal(err)
	}
	stageRelease(t, runtime)
	return runtime, htpasswd
}

func TestPreviewAccessRendersProxyHostDirectivesAtServerLevel(t *testing.T) {
	runtime, htpasswd := accessRuntime(t)
	if err := os.WriteFile(filepath.Join(htpasswd, "access-list-"+accessListID), []byte("ops:$2y$10$hash\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	access := &PreviewAccess{
		AccessListID: accessListID,
		IPRules:      []PreviewIPRule{{Type: "allow", Value: "10.0.0.0/8"}, {Type: "deny", Value: "192.0.2.7"}},
		BasicAuth:    true,
	}
	if err := runtime.MaterializePreview(profileID, deploymentID, "abc-main.pages.example", "", "", PreviewFallback{Access: access}); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(runtime.previewConfigPath("abc-main.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"    server_name abc-main.pages.example;",
		"    satisfy all;",
		"    allow 10.0.0.0/8;",
		"    deny 192.0.2.7;",
		"    deny all;",
		"    auth_basic \"Restricted Access\";",
		"    auth_basic_user_file " + filepath.Join(htpasswd, "access-list-"+accessListID) + ";",
		"    root ",
	}, "\n")
	if !strings.Contains(string(config), want) {
		t.Fatalf("access directives are missing or out of order:\n%s", config)
	}
	// Server-level directives cover the runtime config script and assets too:
	// no location may re-open access with its own allow/auth_basic off.
	if strings.Contains(string(config), "auth_basic off") || strings.Count(string(config), "allow ") != 1 {
		t.Fatalf("unexpected per-location access override:\n%s", config)
	}
}

func TestPreviewAccessIPOnlyAndPublicPreviewsStayUnchanged(t *testing.T) {
	runtime, _ := accessRuntime(t)
	ipOnly := &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "2001:db8::/32"}}}
	if err := runtime.MaterializePreview(profileID, deploymentID, "ip.pages.example", "", "", PreviewFallback{Access: ipOnly}); err != nil {
		t.Fatal(err)
	}
	config, _ := os.ReadFile(runtime.previewConfigPath("ip.pages.example"))
	if !strings.Contains(string(config), "    satisfy all;\n    allow 2001:db8::/32;\n    deny all;\n") || strings.Contains(string(config), "auth_basic") {
		t.Fatalf("IP-only access list rendered incorrectly:\n%s", config)
	}

	if err := runtime.MaterializePreview(profileID, deploymentID, "public.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	public, _ := os.ReadFile(runtime.previewConfigPath("public.pages.example"))
	if strings.Contains(string(public), "deny all;\n    root") || strings.Contains(string(public), "auth_basic") || strings.Contains(string(public), "satisfy") {
		t.Fatalf("public preview must not render access directives:\n%s", public)
	}
}

func TestPreviewAccessFailsClosed(t *testing.T) {
	runtime, _ := accessRuntime(t)
	cases := map[string]*PreviewAccess{
		"missing credentials": {AccessListID: accessListID, BasicAuth: true},
		"invalid list id":     {AccessListID: "../../etc/passwd", IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.1"}}},
		"invalid rule type":   {AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "permit", Value: "10.0.0.1"}}},
		"injected address":    {AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.1; return 200"}}},
		"not an address":      {AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "example.com"}}},
	}
	for name, access := range cases {
		t.Run(name, func(t *testing.T) {
			hostname := "closed.pages.example"
			if err := runtime.MaterializePreview(profileID, deploymentID, hostname, "", "", PreviewFallback{Access: access}); err == nil {
				t.Fatal("expected access validation failure")
			}
			if _, err := os.Stat(runtime.previewConfigPath(hostname)); !os.IsNotExist(err) {
				t.Fatalf("rejected access list must not publish a preview: %v", err)
			}
		})
	}
}

func TestBindingInspectionComparesPreviewAccess(t *testing.T) {
	r, _, bindings := inspectionFixture(t)
	preview := bindings[1]
	if got := r.InspectBindings([]BindingExpectation{preview}); !reflect.DeepEqual(got.Matches, []bool{true}) {
		t.Fatalf("baseline inspection: %#v", got)
	}
	protected := preview
	protected.Access = &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.1"}}}
	if got := r.InspectBindings([]BindingExpectation{protected}); !reflect.DeepEqual(got.Matches, []bool{false}) {
		t.Fatalf("a newly attached access list must force re-materialization: %#v", got)
	}
	if err := r.MaterializePreview(profileID, deploymentID, preview.ID, "", "", PreviewFallback{Access: protected.Access}); err != nil {
		t.Fatal(err)
	}
	if got := r.InspectBindings([]BindingExpectation{protected}); !reflect.DeepEqual(got.Matches, []bool{true}) {
		t.Fatalf("protected inspection: %#v", got)
	}
	encoded, err := json.Marshal(protected)
	if err != nil || !strings.Contains(string(encoded), `"access":{"accessListId":"`+accessListID+`"`) {
		t.Fatalf("expectation JSON shape changed: %s %v", encoded, err)
	}
}

func TestPreviewAccessAcceptsTheAllKeyword(t *testing.T) {
	runtime, _ := accessRuntime(t)
	access := &PreviewAccess{
		AccessListID: accessListID,
		IPRules:      []PreviewIPRule{{Type: "allow", Value: "10.0.0.0/8"}, {Type: "deny", Value: "all"}},
	}
	if err := runtime.MaterializePreview(profileID, deploymentID, "all.pages.example", "", "", PreviewFallback{Access: access}); err != nil {
		t.Fatalf("the access-list schema accepts `all`; the daemon must too: %v", err)
	}
	config, _ := os.ReadFile(runtime.previewConfigPath("all.pages.example"))
	// The list's own `deny all` is rendered once (no second, implicit one).
	want := "    satisfy all;\n    allow 10.0.0.0/8;\n    deny all;\n    root "
	if !strings.Contains(string(config), want) {
		t.Fatalf("`deny all` rule rendered incorrectly:\n%s", config)
	}
	for _, value := range []string{"allx", "ALL", "all;"} {
		if validAccessAddress(value) {
			t.Fatalf("%q must not be accepted", value)
		}
	}
}

func TestProtectedPreviewRedirectsPlainHTTP(t *testing.T) {
	runtime, _ := accessRuntime(t)
	certificateID := "55555555-5555-4555-8555-555555555555"
	version := strings.Repeat("b", 64)
	access := &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.1"}}}
	if err := runtime.MaterializePreview(profileID, deploymentID, "tls.pages.example", certificateID, version, PreviewFallback{Access: access}); err != nil {
		t.Fatal(err)
	}
	config, _ := os.ReadFile(runtime.previewConfigPath("tls.pages.example"))
	redirect := "server {\n    listen 80;\n    server_name tls.pages.example;\n    return 301 https://tls.pages.example$request_uri;\n}\nserver {\n    listen 443 ssl;\n"
	if !strings.Contains(string(config), redirect) {
		t.Fatalf("a protected TLS preview must answer port 80 only with a redirect:\n%s", config)
	}
	plain := string(config)[:strings.Index(string(config), "listen 443 ssl;")]
	if strings.Count(string(config), "listen 80;") != 1 || strings.Contains(plain, "root ") || strings.Contains(plain, "allow ") {
		t.Fatalf("plain HTTP server block must carry no content:\n%s", config)
	}

	// With the page variables, an error nginx raises on the redirect server (a URI too long, a header too large) is an
	// Opfield page too.
	runtime.SetErrorPages(true)
	if err := runtime.MaterializePreview(profileID, deploymentID, "tls.pages.example", certificateID, version, PreviewFallback{Access: access}); err != nil {
		t.Fatal(err)
	}
	config, _ = os.ReadFile(runtime.previewConfigPath("tls.pages.example"))
	plain = string(config)[:strings.Index(string(config), "listen 443 ssl;")]
	if !strings.Contains(plain, "    server_name tls.pages.example;\n    error_page 401 403 404 ") || !strings.Contains(plain, "error_page 400 414 505 /.well-known/opfield-error;") ||
		!strings.Contains(plain, "    return 301 https://tls.pages.example$request_uri;\n}\n") || strings.Contains(plain, "root ") {
		t.Fatalf("redirect server with the error pages:\n%s", plain)
	}
	runtime.SetErrorPages(false)

	if err := runtime.MaterializePreview(profileID, deploymentID, "open.pages.example", certificateID, version); err != nil {
		t.Fatal(err)
	}
	open, _ := os.ReadFile(runtime.previewConfigPath("open.pages.example"))
	if strings.Contains(string(open), "return 301") || !strings.Contains(string(open), "    listen 80;\n    listen 443 ssl;") {
		t.Fatalf("unprotected previews keep serving both ports:\n%s", open)
	}
}

func TestUsesAccessListFindsProtectedPreviews(t *testing.T) {
	runtime, htpasswd := accessRuntime(t)
	if err := os.WriteFile(filepath.Join(htpasswd, "access-list-"+accessListID), []byte("ops:hash\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if runtime.UsesAccessList(accessListID) {
		t.Fatal("no preview references the list yet")
	}
	access := &PreviewAccess{AccessListID: accessListID, BasicAuth: true}
	if err := runtime.MaterializePreview(profileID, deploymentID, "auth.pages.example", "", "", PreviewFallback{Access: access}); err != nil {
		t.Fatal(err)
	}
	if !runtime.UsesAccessList(accessListID) || runtime.UsesAccessList("66666666-6666-4666-8666-666666666666") || runtime.UsesAccessList("../x") {
		t.Fatal("UsesAccessList must match exactly the referenced list")
	}
}

// Once the access socket has the list's policy, the preview asks it about every request; the fallback rules and
// credentials are no longer rendered or needed.
func TestPreviewAccessChecksOnTheAccessSocket(t *testing.T) {
	runtime, _ := accessRuntime(t)
	runtime.SetErrorPages(true)
	synced := map[string]bool{accessListID: true}
	runtime.SetAccessChecks(func(id string) bool { return synced[id] })
	// Basic authentication without a deployed htpasswd file: checked previews do not read it.
	access := &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.0/8"}}, BasicAuth: true}
	if err := runtime.MaterializePreview(profileID, deploymentID, "checked.pages.example", "", "", PreviewFallback{Access: access}); err != nil {
		t.Fatal(err)
	}
	config, _ := os.ReadFile(runtime.previewConfigPath("checked.pages.example"))
	text := string(config)
	// Every X-Opfield-Access-* header the socket reads is set by nginx in the locations a visitor reaches directly.
	visitorHeaders := "        proxy_set_header X-Opfield-Access-List \"" + accessListID + "\";\n        proxy_set_header X-Opfield-Access-Host $host;\n" +
		"        proxy_set_header X-Opfield-Access-Client-Ip $remote_addr;\n        proxy_set_header X-Opfield-Access-Uri \"\";\n" +
		"        proxy_set_header X-Opfield-Access-Secure $https;\n        proxy_set_header X-Opfield-Access-Scheme $scheme;\n"
	for _, want := range []string{
		"    recursive_error_pages on;\n",
		"    server_name checked.pages.example;\n    auth_request /_opfield/access/check;\n    error_page 401 = @opfield_access_challenge;\n",
		"    location = /_opfield/access/check {\n        internal;\n        auth_request off;\n        proxy_pass http://unix:/run/nginx-daemon/access.sock:/check;\n        proxy_pass_request_body off;\n        proxy_set_header Content-Length \"\";\n        proxy_set_header X-Opfield-Access-List \"" + accessListID + "\";\n        proxy_set_header X-Opfield-Access-Host $host;\n        proxy_set_header X-Opfield-Access-Client-Ip $remote_addr;\n        proxy_set_header X-Opfield-Access-Uri $request_uri;\n        proxy_set_header X-Opfield-Access-Secure $https;\n        proxy_set_header X-Opfield-Access-Scheme $scheme;\n    }\n",
		"    location = /_opfield/access/callback {\n        auth_request off;\n        access_log off;\n        proxy_pass http://unix:/run/nginx-daemon/access.sock:/callback;\n",
		"    location @opfield_access_challenge {\n        auth_request off;\n        rewrite ^ /challenge break;\n        proxy_pass http://unix:/run/nginx-daemon/access.sock;\n",
		"        auth_basic off;\n        auth_request off;\n",
		// The preview's own sign-in page.
		"    location ^~ /_opfield/access/ {\n        access_log off;\n        auth_request off;\n        proxy_pass http://unix:/run/nginx-daemon/access.sock:/ui/;\n        proxy_hide_header Referrer-Policy;\n        proxy_hide_header X-Content-Type-Options;\n        add_header Referrer-Policy no-referrer always;\n        add_header X-Content-Type-Options nosniff always;\n" + visitorHeaders + "    }\n",
		// The old callback reads the scheme too; a visitor cannot send it.
		"proxy_pass http://unix:/run/nginx-daemon/access.sock:/callback;\n" + visitorHeaders + "    }\n",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "allow 10.0.0.0/8") || strings.Contains(text, "auth_basic_user_file") || strings.Contains(text, "satisfy all") {
		t.Fatalf("fallback directives rendered next to the check:\n%s", text)
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "    error_page ") && strings.Contains(line, " 401 ") && !strings.HasSuffix(line, "@opfield_access_challenge;") {
			t.Fatalf("401 must reach the access challenge: %q", line)
		}
	}
	if runtime.UsesAccessList(accessListID) {
		t.Fatal("a checked preview does not use the list's htpasswd file")
	}

	// Without the list's policy the fallback applies; a named list without fallback rules lets nobody in.
	delete(synced, accessListID)
	if err := runtime.MaterializePreview(profileID, deploymentID, "closed.pages.example", "", "", PreviewFallback{Access: &PreviewAccess{AccessListID: accessListID}}); err != nil {
		t.Fatal(err)
	}
	closed, _ := os.ReadFile(runtime.previewConfigPath("closed.pages.example"))
	if !strings.Contains(string(closed), "    satisfy all;\n    deny all;\n    root ") || strings.Contains(string(closed), "auth_request") {
		t.Fatalf("unsynced list without fallback rules must deny everyone:\n%s", closed)
	}
}

// A preview materialized before its list's policy reached the access socket switches to access checks when the
// policy arrives, and back to the fallback when the list leaves it.
func TestPreviewAccessFollowsThePolicy(t *testing.T) {
	runtime, _ := accessRuntime(t)
	synced := map[string]bool{}
	runtime.SetAccessChecks(func(id string) bool { return synced[id] })
	access := &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.0/8"}}}
	if err := runtime.MaterializePreview(profileID, deploymentID, "follow.pages.example", "", "", PreviewFallback{SPAFallback: true, Access: access}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.MaterializePreview(profileID, deploymentID, "public.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	read := func() string {
		config, err := os.ReadFile(runtime.previewConfigPath("follow.pages.example"))
		if err != nil {
			t.Fatal(err)
		}
		return string(config)
	}
	fallback := read()
	if strings.Contains(fallback, "auth_request") {
		t.Fatalf("unsynced list rendered with checks:\n%s", fallback)
	}

	synced[accessListID] = true
	if changed, err := runtime.RefreshAccessChecks(); err != nil || changed != 1 {
		t.Fatalf("refresh after the policy arrived: %d %v", changed, err)
	}
	checked := read()
	if !strings.Contains(checked, "    auth_request /_opfield/access/check;\n") || strings.Contains(checked, "allow 10.0.0.0/8") || !strings.Contains(checked, "try_files $uri $uri/ /index.html;") {
		t.Fatalf("preview not rendered with checks:\n%s", checked)
	}
	if changed, err := runtime.RefreshAccessChecks(); err != nil || changed != 0 {
		t.Fatalf("a refresh without policy changes rendered again: %d %v", changed, err)
	}

	delete(synced, accessListID)
	if changed, err := runtime.RefreshAccessChecks(); err != nil || changed != 1 || read() != fallback {
		t.Fatalf("refresh after the list left the policy: %d %v\n%s", changed, err, read())
	}

	if err := runtime.RemovePreview("follow.pages.example"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(runtime.previewAccessRecordPath("follow.pages.example")); !os.IsNotExist(err) {
		t.Fatalf("record of a removed preview kept: %v", err)
	}
}

// A preview an earlier daemon rendered gets the error page codes added since, and a node without the page variables
// changes nothing.
func TestUpgradeErrorPagesOfEarlierPreviews(t *testing.T) {
	runtime, _ := accessRuntime(t)
	runtime.SetErrorPages(true)
	if err := runtime.MaterializePreview(profileID, deploymentID, "earlier.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	path := runtime.previewConfigPath("earlier.pages.example")
	current, _ := os.ReadFile(path)
	earlier := strings.Replace(strings.Replace(string(current), " 500 501 502 ", " 500 502 ", 1), "error_page 400 414 505 /", "error_page 400 414 /", 1)
	if earlier == string(current) {
		t.Fatal("the preview names 501 and 505")
	}
	if err := os.WriteFile(path, []byte(earlier), 0o640); err != nil {
		t.Fatal(err)
	}
	runtime.SetErrorPages(false)
	if previous, err := runtime.UpgradeErrorPages(); err != nil || len(previous) != 0 {
		t.Fatalf("without the variables: %v %v", previous, err)
	}
	runtime.SetErrorPages(true)
	previous, err := runtime.UpgradeErrorPages()
	if err != nil || string(previous[path]) != earlier {
		t.Fatalf("upgrade: %v %v", previous, err)
	}
	if upgraded, _ := os.ReadFile(path); string(upgraded) != string(current) {
		t.Fatalf("upgraded preview:\n%s", upgraded)
	}
	if again, _ := runtime.UpgradeErrorPages(); len(again) != 0 {
		t.Fatal("an upgraded preview is left alone")
	}
	if err := RestoreConfigs(previous); err != nil {
		t.Fatal(err)
	}
	if restored, _ := os.ReadFile(path); string(restored) != earlier {
		t.Fatal("restore")
	}
}
