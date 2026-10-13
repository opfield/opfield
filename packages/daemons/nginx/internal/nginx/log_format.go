package nginx

import (
	"os"
	"strings"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const (
	// LogFormatName is the access log format the daemon defines in nginx.conf.
	LogFormatName = "opfield_combined"
	// legacy-name: log format a node defined before 2.12.1; kept while a configuration on the node uses it
	LegacyLogFormatName = "gateway_combined"

	logFormatFields = ` '$remote_addr - $remote_user [$time_local] '
    '"$request" $status $body_bytes_sent '
    '"$http_referer" "$http_user_agent" '
    '$upstream_response_time $request_time';`
	logFormatComment = "# Opfield daemon log format (auto-injected)"
)

// logFormatName is the format name under the names in effect.
func logFormatName() string {
	if naming.Legacy() {
		return LegacyLogFormatName
	}
	return LogFormatName
}

func logFormatDefinition(name string) string { return "log_format " + name + logFormatFields }

// EnsureLogFormat checks if the daemon's log format is present in nginx.conf.
// If not, injects it into the http block. Returns true if modified.
func EnsureLogFormat(nginxConfPath string) (bool, error) {
	data, err := os.ReadFile(nginxConfPath)
	if err != nil {
		return false, err
	}

	content := string(data)
	if strings.Contains(content, "log_format "+logFormatName()) {
		return false, nil // already present
	}

	// Find the http { block and inject after it
	httpIdx := strings.Index(content, "http {")
	if httpIdx == -1 {
		httpIdx = strings.Index(content, "http{")
	}
	if httpIdx == -1 {
		return false, nil // can't find http block
	}

	// Find the opening brace
	braceIdx := strings.Index(content[httpIdx:], "{")
	if braceIdx == -1 {
		return false, nil
	}
	insertAt := httpIdx + braceIdx + 1

	injection := "\n    " + logFormatComment + "\n    " + logFormatDefinition(logFormatName()) + "\n"
	newContent := content[:insertAt] + injection + content[insertAt:]

	return true, WriteAtomic(nginxConfPath, []byte(newContent))
}

// Comments the daemon and the installer wrote into nginx.conf before 2.12.1, with their Opfield wording.
// legacy-name: nginx.conf comments of nodes installed before 2.12.1 — remove once every node reports none
var globalConfigComments = [][2]string{
	{"# Gateway daemon log format (auto-injected)", logFormatComment},
	{"# Gateway Pages generated hostnames (auto-injected)", serverNamesHashComment},
	{"# Gateway Pages generated hostnames are longer than the default bucket fits.", "# Opfield Pages generated hostnames are longer than the default bucket fits."},
}

// OpfieldGlobalConfig returns the global nginx configuration with the Opfield names: the include lines and every other
// name of naming.Normalize, the comments of the blocks the daemon and the installer wrote, and the access log format.
// The log format keeps its pre-Opfield definition next to the new one when keepLegacyLogFormat (a configuration on the
// node still logs with it).
func OpfieldGlobalConfig(content string, keepLegacyLogFormat bool) string {
	next := naming.Normalize(content)
	for _, comment := range globalConfigComments {
		next = strings.ReplaceAll(next, comment[0], comment[1])
	}
	legacyDefinition := "log_format " + LegacyLogFormatName
	if !strings.Contains(next, legacyDefinition) || strings.Contains(next, "log_format "+LogFormatName) {
		return next
	}
	if !keepLegacyLogFormat {
		return strings.Replace(next, legacyDefinition, "log_format "+LogFormatName, 1)
	}
	index := strings.Index(next, legacyDefinition)
	lineStart := strings.LastIndex(next[:index], "\n") + 1
	indent := next[lineStart:index]
	if strings.TrimSpace(indent) != "" {
		indent = "    "
	}
	return next[:lineStart] + indent + logFormatDefinition(LogFormatName) + "\n" + next[lineStart:]
}

// LegacyLogFormatInUse reports whether an effective nginx configuration (nginx -T) uses the pre-Opfield log format
// anywhere but in its definition.
func LegacyLogFormatInUse(effectiveConfig string) bool {
	uses := strings.Count(effectiveConfig, LegacyLogFormatName)
	definitions := strings.Count(effectiveConfig, "log_format "+LegacyLogFormatName)
	return uses > definitions
}
