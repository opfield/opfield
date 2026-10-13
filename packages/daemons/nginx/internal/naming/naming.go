// Package naming holds the names Opfield gives its files, directories and nginx identifiers on an ingress node, and
// the names of the product's former brand (Opfield) that a node keeps until its daemon moved it to the new ones.
//
// A node runs in one of two schemes. Opfield names are the default: every new install and every node the daemon has
// moved. Pre-Opfield names stay in effect on a node until the update that brings this daemon is committed by the
// launcher: before that the launcher may still roll back to a daemon that knows only those names, so the daemon
// keeps writing them (opfield_names.go in the daemon package moves the node and switches the scheme).
//
// Content is always generated with the Opfield names; Render turns it into the names of the scheme in effect.
// Normalize turns pre-Opfield names in content that arrives (a config Opfield rendered for an older daemon, a raw
// config written before, a file on disk) into the Opfield ones. The same pairs are applied by Opfield itself
// (backend nginx-node-names.ts), for a node that does not report Capability yet.
package naming

import (
	"strings"
	"sync/atomic"
)

// Capability tells Opfield the node runs with the Opfield names: render its configs with them.
const Capability = "nginx_opfield_names_v1"

// Directories of the node, under their Opfield and their pre-Opfield names.
const (
	EtcDir                 = "/etc/nginx/opfield"
	SecureLinkSocketDir    = "/run/opfield-secure-links"
	RegistrySocketDir      = "/run/opfield-registry-links"
	IngressHealthSocketDir = "/run/opfield-ingress-health"

	// legacy-name: pre-Opfield directories of nodes installed before 2.12.1 — remove once every node reports none
	LegacyEtcDir                 = "/etc/nginx/gateway"
	LegacySecureLinkSocketDir    = "/run/gateway-secure-links"
	LegacyRegistrySocketDir      = "/run/gateway-registry-links"
	LegacyIngressHealthSocketDir = "/run/gateway-ingress-health"
)

// The reserved ingress health path. The pre-Opfield one stays answered for good: load balancers and monitors of
// customers probe it.
const (
	IngressHealthPath = "/.well-known/opfield-ingress-health"
	// legacy-name: health path external monitors were set up with — remove once no customer monitor probes it
	LegacyIngressHealthPath = "/.well-known/gateway-ingress-health"
)

// The Pages runtime configuration script. The pre-Opfield path is documented for customer pages and stays answered.
const (
	PagesConfigScriptPath = "/_opfield/pages/config.js"
	// legacy-name: Pages runtime configuration path customer pages may load directly — remove once no page loads it
	LegacyPagesConfigScriptPath = "/_gateway/pages/config.js"
)

// DirPair is one directory under its pre-Opfield and its Opfield name.
type DirPair struct {
	Legacy  string
	Current string
}

// Dirs are the directories the daemon moves to their Opfield names.
func Dirs() []DirPair {
	return []DirPair{
		{Legacy: LegacyEtcDir, Current: EtcDir},
		{Legacy: LegacySecureLinkSocketDir, Current: SecureLinkSocketDir},
		{Legacy: LegacyRegistrySocketDir, Current: RegistrySocketDir},
		{Legacy: LegacyIngressHealthSocketDir, Current: IngressHealthSocketDir},
	}
}

// pairs are the names that differ between the schemes, Opfield name first. Only names that tie two places together
// (a path the daemon serves, a variable a daemon file defines, a header the daemon reads, a marker it looks for) are
// listed; names that live inside one config alone need no pair. The reserved health path and the Pages script path are
// absent on purpose: both names stay answered, and a config may carry a location for each.
// Kept identical with NGINX_NAME_PAIRS in the backend (nginx-node-names.ts).
// legacy-name: pre-Opfield names of nodes and of configs stored before 2.12.1 — remove once every node reports none
var pairs = [][2]string{
	{EtcDir + "/", LegacyEtcDir + "/"},
	{SecureLinkSocketDir + "/", LegacySecureLinkSocketDir + "/"},
	{RegistrySocketDir + "/", LegacyRegistrySocketDir + "/"},
	{IngressHealthSocketDir + "/", LegacyIngressHealthSocketDir + "/"},
	{"/_opfield/maintenance-access", "/_gateway/maintenance-access"},
	{"opfield_maintenance", "gateway_maintenance"},
	{"opfield-maintenance", "gateway-maintenance"},
	{"opfield_ingress_generation", "gateway_ingress_generation"},
	{"X-Opfield-Maintenance-", "X-Gateway-Maintenance-"},
	{"X-Opfield-Ingress-Generation", "X-Gateway-Ingress-Generation"},
	{"opfield-managed-secure-link-upstream", "gateway-managed-secure-link-upstream"},
	{"opfield_pages_", "gateway_pages_"},
	{"# opfield-pages ", "# gateway-pages "},
	{"opfield_secure_link_", "gateway_secure_link_"},
	{"opfield_additional_secure_link_", "gateway_additional_secure_link_"},
	{"ingress-health.opfield.invalid", "ingress-health.gateway.invalid"},
}

var toCurrent, toLegacy = func() (*strings.Replacer, *strings.Replacer) {
	current := make([]string, 0, 2*len(pairs))
	legacyNames := make([]string, 0, 2*len(pairs))
	for _, pair := range pairs {
		current = append(current, pair[1], pair[0])
		legacyNames = append(legacyNames, pair[0], pair[1])
	}
	return strings.NewReplacer(current...), strings.NewReplacer(legacyNames...)
}()

// legacy is set while the node runs with the pre-Opfield names.
var legacy atomic.Bool

// Legacy reports whether the node still runs with the pre-Opfield names.
func Legacy() bool { return legacy.Load() }

// SetLegacy switches the scheme in effect.
func SetLegacy(value bool) { legacy.Store(value) }

// Normalize replaces the pre-Opfield names in content by the Opfield ones.
func Normalize(content string) string { return toCurrent.Replace(content) }

// ToLegacy replaces the Opfield names in content by the pre-Opfield ones.
func ToLegacy(content string) string { return toLegacy.Replace(content) }

// Render returns content (generated with the Opfield names) with the names of the scheme in effect, and content that
// arrives with either names in that scheme.
func Render(content string) string {
	if Legacy() {
		return ToLegacy(content)
	}
	return Normalize(content)
}

// RenderBytes is Render for file content.
func RenderBytes(content []byte) []byte {
	if content == nil {
		return nil
	}
	return []byte(Render(string(content)))
}

// Path returns path (a file or directory of the node under either name) under the name of the scheme in effect.
func Path(path string) string {
	for _, dir := range Dirs() {
		from, to := dir.Legacy, dir.Current
		if Legacy() {
			from, to = dir.Current, dir.Legacy
		}
		if path == from {
			return to
		}
		if strings.HasPrefix(path, from+"/") {
			return to + strings.TrimPrefix(path, from)
		}
	}
	return path
}

// AliasOf returns the other name of path (inside one of Dirs) and whether it has one.
func AliasOf(path string) (string, bool) {
	for _, dir := range Dirs() {
		for _, names := range [][2]string{{dir.Current, dir.Legacy}, {dir.Legacy, dir.Current}} {
			if path == names[0] {
				return names[1], true
			}
			if strings.HasPrefix(path, names[0]+"/") {
				return names[1] + strings.TrimPrefix(path, names[0]), true
			}
		}
	}
	return "", false
}

// SameDir reports whether a and b name the same directory of Dirs, under either name.
func SameDir(a, b string) bool {
	if a == b {
		return true
	}
	alias, ok := AliasOf(a)
	return ok && alias == b
}

// File returns the name of a file the daemon keeps (named with "opfield") in the scheme in effect.
func File(name string) string {
	if Legacy() {
		return strings.Replace(name, "opfield", "gateway", 1)
	}
	return name
}

// LegacyFile returns the pre-Opfield name of a file the daemon keeps.
func LegacyFile(name string) string { return strings.Replace(name, "opfield", "gateway", 1) }
