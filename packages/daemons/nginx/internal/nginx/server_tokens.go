package nginx

import (
	"os"
	"regexp"
	"strings"
)

var serverTokensPattern = regexp.MustCompile(`(?m)^(\s*)server_tokens\s+([A-Za-z]+)\s*;`)

// EnsureServerTokensOff keeps nginx's version out of every response and page nginx answers itself (nodes installed
// before the installer wrote `server_tokens off;`): an explicit value in the global configuration becomes off, and an
// http block without one gets it. It returns the previous content so a caller whose test of the result fails (an
// included file sets it too) can put it back, and whether the file changed.
func EnsureServerTokensOff(nginxConfPath string) ([]byte, bool, error) {
	data, err := os.ReadFile(nginxConfPath)
	if err != nil {
		return nil, false, err
	}
	content := string(data)
	next := content
	if serverTokensPattern.MatchString(content) {
		next = serverTokensPattern.ReplaceAllString(content, "${1}server_tokens off;")
	} else {
		httpIdx := strings.Index(content, "http {")
		if httpIdx == -1 {
			httpIdx = strings.Index(content, "http{")
		}
		if httpIdx == -1 {
			return data, false, nil
		}
		insertAt := httpIdx + strings.Index(content[httpIdx:], "{") + 1
		next = content[:insertAt] + "\n    # Opfield: no nginx version in responses (auto-injected)\n    server_tokens off;\n" + content[insertAt:]
	}
	if next == content {
		return data, false, nil
	}
	return data, true, WriteAtomic(nginxConfPath, []byte(next))
}
