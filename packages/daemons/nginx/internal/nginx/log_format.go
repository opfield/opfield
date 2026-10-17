package nginx

import (
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"regexp"
	"strings"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const (
	// LogFormatName is the access log format the daemon defines in nginx.conf.
	LogFormatName = "opfield_combined"
	// legacy-name: log format a node defined before 2.12.1; kept while a configuration on the node uses it
	LegacyLogFormatName = legacycompat.NginxVariablePrefix + "combined"

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

// EnsureLogFormatFirst moves the daemon's log format definitions (the Opfield one and the pre-Opfield one) in
// nginx.conf above the first include of the http block: nginx refuses a format used before its definition, and route
// configs come in through those includes (an Alpine node had the includes first). It reports whether nginx.conf now
// defines the format of the names in effect before any include, and whether it changed the file.
func EnsureLogFormatFirst(nginxConfPath string) (ready bool, modified bool, err error) {
	data, err := os.ReadFile(nginxConfPath)
	if err != nil {
		return false, false, err
	}
	next, ok := logFormatFirst(string(data))
	if !ok {
		return false, false, nil
	}
	if next == string(data) {
		return true, false, nil
	}
	return true, true, WriteAtomic(nginxConfPath, []byte(next))
}

// logFormatFirst is EnsureLogFormatFirst on the content: ok when the format of the names in effect is defined in the
// http block before its first include once the definitions are moved.
func logFormatFirst(content string) (string, bool) {
	httpStart := httpBlockBodyStart(content)
	if httpStart < 0 {
		return content, false
	}
	var moved []string
	for _, name := range []string{LogFormatName, LegacyLogFormatName} {
		start, end := logFormatStatement(content[httpStart:], name)
		if start < 0 {
			continue
		}
		start, end = start+httpStart, end+httpStart
		include := firstInclude(content[httpStart:])
		if include < 0 || start < httpStart+include {
			continue
		}
		moved = append(moved, strings.TrimSpace(content[start:end]))
		content = content[:start] + content[end:]
	}
	if len(moved) > 0 {
		injection := ""
		for _, statement := range moved {
			injection += "\n    " + statement
		}
		content = content[:httpStart] + injection + content[httpStart:]
	}
	start, _ := logFormatStatement(content[httpStart:], logFormatName())
	include := firstInclude(content[httpStart:])
	return content, start >= 0 && (include < 0 || start < include)
}

// httpBlockBodyStart is the offset just after the opening brace of the http block, or -1.
func httpBlockBodyStart(content string) int {
	match := httpBlockPattern.FindStringIndex(content)
	if match == nil {
		return -1
	}
	return match[1]
}

var (
	httpBlockPattern = regexp.MustCompile(`(?m)^\s*http\s*\{`)
	includePattern   = regexp.MustCompile(`(?m)^[ \t]*include\s`)
)

// firstInclude is the offset of the first uncommented include line in content, or -1.
func firstInclude(content string) int {
	match := includePattern.FindStringIndex(content)
	if match == nil {
		return -1
	}
	return match[0]
}

// logFormatStatement is the span of the uncommented `log_format <name> …;` statement in content, from the start of
// its line to the end of the line its semicolon is on (quoted parts may span lines), or -1, -1.
func logFormatStatement(content, name string) (int, int) {
	pattern := regexp.MustCompile(`(?m)^[ \t]*log_format\s+` + regexp.QuoteMeta(name) + `\s`)
	match := pattern.FindStringIndex(content)
	if match == nil {
		return -1, -1
	}
	quote := byte(0)
	for i := match[1]; i < len(content); i++ {
		c := content[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '\'' || c == '"':
			quote = c
		case c == ';':
			end := i + 1
			if newline := strings.IndexByte(content[end:], '\n'); newline >= 0 {
				end += newline + 1
			} else {
				end = len(content)
			}
			return match[0], end
		}
	}
	return -1, -1
}

// Comments the daemon and the installer wrote into nginx.conf before 2.12.1, with their Opfield wording.
// legacy-name: nginx.conf comments of nodes installed before 2.12.1 — remove once every node reports none
var globalConfigComments = [][2]string{
	{legacycompat.NginxLogFormatComment, logFormatComment},
	{legacycompat.NginxPagesHostnamesComment, serverNamesHashComment},
	{legacycompat.NginxPagesBucketComment, "# Opfield Pages generated hostnames are longer than the default bucket fits."},
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
