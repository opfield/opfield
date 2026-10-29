package pages

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

// defaultHtpasswdDir matches the nginx daemon's canonical htpasswd directory and
// the auth_basic_user_file path proxy host templates render.
const defaultHtpasswdDir = naming.EtcDir + "/htpasswd"

// PreviewIPRule is one ordered allow/deny directive of a preview access list.
type PreviewIPRule struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// PreviewAccess protects every location of a preview with its access list, like a proxy host's. Once the daemon's
// access socket has the list's policy (SetAccessChecks), nginx asks it about every request (auth_request). Until then
// the fallback Opfield sends applies: ordered IP rules followed by `deny all`, and optional basic authentication from
// the list's deployed htpasswd file, both together (nginx `satisfy all`); a list with neither denies everyone.
type PreviewAccess struct {
	AccessListID string          `json:"accessListId"`
	IPRules      []PreviewIPRule `json:"ipRules,omitempty"`
	BasicAuth    bool            `json:"basicAuth,omitempty"`
}

// Enabled reports whether the access list renders any directive.
func (a *PreviewAccess) Enabled() bool {
	return a != nil && (a.AccessListID != "" || len(a.IPRules) > 0 || a.BasicAuth)
}

// SetAccessChecks tells the runtime how to learn whether nginx can ask the daemon's access socket about a list:
// previews with that list then check access with auth_request.
func (r *Runtime) SetAccessChecks(available func(accessListID string) bool) {
	r.accessChecks = available
}

func (r *Runtime) accessChecked(access *PreviewAccess) bool {
	return access != nil && r.accessChecks != nil && r.accessChecks(access.AccessListID)
}

// The access socket nginx asks (auth_request) and the locations a checked preview answers the sign-in flow on.
const (
	accessSocket            = "http://unix:/run/nginx-daemon/access.sock"
	accessCheckPath         = "/_opfield/access/check"
	accessCallbackPath      = "/_opfield/access/callback"
	accessChallengeLocation = "@opfield_access_challenge"
)

// SetHtpasswdDir points basic-auth previews at the daemon's htpasswd directory.
func (r *Runtime) SetHtpasswdDir(dir string) error {
	if dir == "" || !safeNginxPath(dir) {
		return errors.New("Pages htpasswd directory must be an absolute nginx-safe path")
	}
	r.htpasswdDir = filepath.Clean(dir)
	return nil
}

func (r *Runtime) htpasswdPath(accessListID string) string {
	dir := r.htpasswdDir
	if dir == "" {
		dir = naming.Path(defaultHtpasswdDir)
	}
	return filepath.Join(dir, "access-list-"+accessListID)
}

func validatePreviewAccess(access *PreviewAccess) error {
	if access == nil {
		return nil
	}
	if !uuidPattern.MatchString(access.AccessListID) {
		return errors.New("invalid preview access list id")
	}
	if len(access.IPRules) > 1000 {
		return errors.New("too many preview access rules")
	}
	for _, rule := range access.IPRules {
		if rule.Type != "allow" && rule.Type != "deny" {
			return fmt.Errorf("invalid preview access rule type %q", rule.Type)
		}
		if !validAccessAddress(rule.Value) {
			return errors.New("invalid preview access rule address")
		}
	}
	return nil
}

func validAccessAddress(value string) bool {
	if value == "" || strings.ContainsAny(value, " \t\r\n;{}'\"\\$#`") {
		return false
	}
	// The access-list schema accepts `all` (e.g. `deny all`), as nginx does.
	if value == "all" {
		return true
	}
	if strings.Contains(value, "/") {
		_, _, err := net.ParseCIDR(value)
		return err == nil
	}
	return net.ParseIP(value) != nil
}

// ensurePreviewCredentials fails closed: a basic-auth preview is never
// published before the control plane deployed the list's htpasswd file, so a
// missing file cannot turn into an nginx 500 or an unintended open preview.
func (r *Runtime) ensurePreviewCredentials(access *PreviewAccess) error {
	// A checked preview does not read the file.
	if access == nil || !access.BasicAuth || r.accessChecked(access) {
		return nil
	}
	info, err := os.Stat(r.htpasswdPath(access.AccessListID))
	if err != nil {
		return fmt.Errorf("preview access credentials are missing: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return errors.New("preview access credentials are invalid")
	}
	return nil
}

// previewAccessDirectives mirrors the proxy host access-list rendering
// (buildAccessListDirectives in the control plane) at server level, so the
// runtime config script, static assets, and every fallback share the policy.
func (r *Runtime) previewAccessDirectives(access *PreviewAccess) []string {
	if !access.Enabled() {
		return nil
	}
	if r.accessChecked(access) {
		return previewAccessCheckDirectives(access.AccessListID)
	}
	// Explicit, like nginx's default: IP rules and basic auth must both pass.
	lines := make([]string, 0, len(access.IPRules)+4)
	lines = append(lines, "    satisfy all;")
	for _, rule := range access.IPRules {
		lines = append(lines, "    "+rule.Type+" "+rule.Value+";")
	}
	// A list that ends in its own "deny all" needs no second one; a list with neither rules nor basic authentication
	// lets nobody in.
	if (len(access.IPRules) > 0 || !access.BasicAuth) && lines[len(lines)-1] != "    deny all;" {
		lines = append(lines, "    deny all;")
	}
	if access.BasicAuth {
		lines = append(lines, "    auth_basic \"Restricted Access\";", "    auth_basic_user_file "+r.htpasswdPath(access.AccessListID)+";")
	}
	return lines
}

// previewAccessCheckDirectives has nginx ask the access socket about every request (the server-level auth_request
// covers the runtime config script and assets too). A visitor who must sign in or authenticate gets the socket's
// challenge; the sign-in page returns them through the callback location. A preview serves files, so there is no
// upstream to hand the identity to.
func previewAccessCheckDirectives(accessListID string) []string {
	requestHeaders := []string{
		"        proxy_pass_request_body off;",
		"        proxy_set_header Content-Length \"\";",
		"        proxy_set_header X-Opfield-Access-List \"" + accessListID + "\";",
		"        proxy_set_header X-Opfield-Access-Host $host;",
		"        proxy_set_header X-Opfield-Access-Client-Ip $remote_addr;",
		"        proxy_set_header X-Opfield-Access-Uri $request_uri;",
		"        proxy_set_header X-Opfield-Access-Secure $https;",
	}
	lines := []string{
		"    auth_request " + accessCheckPath + ";",
		"    error_page 401 = " + accessChallengeLocation + ";",
		"    location = " + accessCheckPath + " {",
		"        internal;",
		"        auth_request off;",
		"        proxy_pass " + accessSocket + ":/check;",
	}
	lines = append(lines, requestHeaders...)
	lines = append(lines, "    }",
		"    location = "+accessCallbackPath+" {",
		"        auth_request off;",
		// The request line carries the access token.
		"        access_log off;",
		"        proxy_pass "+accessSocket+":/callback;",
		"        proxy_set_header X-Opfield-Access-Host $host;",
		"        proxy_set_header X-Opfield-Access-Secure $https;",
		"    }",
		"    location "+accessChallengeLocation+" {",
		"        auth_request off;",
		"        rewrite ^ /challenge break;",
		"        proxy_pass "+accessSocket+";",
	)
	lines = append(lines, requestHeaders...)
	return append(lines, "    }")
}

// UsesAccessList reports whether a materialized preview references the access
// list's htpasswd file, so a proxy-side removal or rollback must keep it.
func (r *Runtime) UsesAccessList(accessListID string) bool {
	if !uuidPattern.MatchString(accessListID) {
		return false
	}
	needle := "auth_basic_user_file " + r.htpasswdPath(accessListID) + ";"
	paths, _ := filepath.Glob(filepath.Join(r.configDir, "pages-preview-*.conf"))
	for _, path := range paths {
		if content, err := os.ReadFile(path); err == nil && strings.Contains(string(content), needle) {
			return true
		}
	}
	return false
}
