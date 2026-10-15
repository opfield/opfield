package pages

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// PreviewClientIP tells nginx where a preview takes the visitor's address from
// (realip): only a connection from one of TrustedProxies may name the client
// in Header, so the access list's IP rules and the access log see the visitor
// behind Cloudflare. Any other peer keeps its own address whatever it sends.
type PreviewClientIP struct {
	TrustedProxies []string `json:"trustedProxies,omitempty"`
	Header         string   `json:"header,omitempty"`
}

var previewClientIPHeaders = map[string]bool{
	"CF-Connecting-IP": true,
	"X-Forwarded-For":  true,
	"X-Real-IP":        true,
}

const maxPreviewTrustedProxies = 256

func validatePreviewClientIP(clientIP *PreviewClientIP) error {
	if clientIP == nil {
		return nil
	}
	if !previewClientIPHeaders[clientIP.Header] {
		return fmt.Errorf("invalid preview client IP header %q", clientIP.Header)
	}
	if len(clientIP.TrustedProxies) == 0 || len(clientIP.TrustedProxies) > maxPreviewTrustedProxies {
		return errors.New("preview client IP needs 1 to 256 trusted proxies")
	}
	for _, proxy := range clientIP.TrustedProxies {
		if !validTrustedProxy(proxy) {
			return errors.New("invalid preview trusted proxy address")
		}
	}
	return nil
}

// validTrustedProxy accepts an address or a CIDR, nothing nginx could read as
// another token (no "all", no unix: peers).
func validTrustedProxy(value string) bool {
	if value == "" || strings.Trim(value, "0123456789abcdefABCDEF:./") != "" {
		return false
	}
	if strings.Contains(value, "/") {
		_, _, err := net.ParseCIDR(value)
		return err == nil
	}
	return net.ParseIP(value) != nil
}

// previewClientIPDirectives are the server-level realip directives, rendered
// before the access list so every location of the preview uses the client.
func previewClientIPDirectives(clientIP *PreviewClientIP) []string {
	if clientIP == nil {
		return nil
	}
	lines := make([]string, 0, len(clientIP.TrustedProxies)+3)
	for _, proxy := range clientIP.TrustedProxies {
		lines = append(lines, "    set_real_ip_from "+proxy+";")
	}
	return append(lines, "    real_ip_header "+clientIP.Header+";", "    real_ip_recursive on;")
}
