package nginx

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const minimumServerNamesHashBucketSize = 128

const serverNamesHashComment = "# Opfield Pages generated hostnames (auto-injected)"

var serverNamesHashBucketSizePattern = regexp.MustCompile(`(?m)^(\s*)server_names_hash_bucket_size\s+(\d+)\s*;`)

// minimumServerNamesHashMaxSize fits the server names of thousands of routes: below it nginx 1.30.6 warns that it
// "could not build optimal server_names_hash" and builds a slower one.
const minimumServerNamesHashMaxSize = 4096

const serverNamesHashMaxSizeComment = "# Opfield routes: room for the server names of many routes (auto-injected)"

var serverNamesHashMaxSizePattern = regexp.MustCompile(`(?m)^(\s*)server_names_hash_max_size\s+(\d+)\s*;`)

// EnsureServerNamesHash makes the global nginx configuration able to accept Opfield-generated Pages hostnames
// (server_names_hash_bucket_size) and the server names of many routes (server_names_hash_max_size). Returns true when
// the file changed.
func EnsureServerNamesHash(nginxConfPath string) (bool, error) {
	data, err := os.ReadFile(nginxConfPath)
	if err != nil {
		return false, err
	}
	content := string(data)
	content, bucketChanged, err := ensureHTTPDirectiveMinimum(content, serverNamesHashBucketSizePattern,
		"server_names_hash_bucket_size", minimumServerNamesHashBucketSize, serverNamesHashComment)
	if err != nil {
		return false, err
	}
	content, maxChanged, err := ensureHTTPDirectiveMinimum(content, serverNamesHashMaxSizePattern,
		"server_names_hash_max_size", minimumServerNamesHashMaxSize, serverNamesHashMaxSizeComment)
	if err != nil {
		return false, err
	}
	if !bucketChanged && !maxChanged {
		return false, nil
	}
	return true, WriteAtomic(nginxConfPath, []byte(content))
}

// ensureHTTPDirectiveMinimum raises a numeric http-level directive to minimum, or adds it at the top of the http block
// with comment when the configuration has none. An nginx.conf without an http block is left alone.
func ensureHTTPDirectiveMinimum(content string, pattern *regexp.Regexp, directive string, minimum int, comment string) (string, bool, error) {
	if match := pattern.FindStringSubmatchIndex(content); match != nil {
		value, err := strconv.Atoi(content[match[4]:match[5]])
		if err != nil {
			return content, false, fmt.Errorf("parse %s: %w", directive, err)
		}
		if value >= minimum {
			return content, false, nil
		}
		replacement := content[match[2]:match[3]] + directive + " " + strconv.Itoa(minimum) + ";"
		return content[:match[0]] + replacement + content[match[1]:], true, nil
	}

	httpIdx := strings.Index(content, "http {")
	if httpIdx == -1 {
		httpIdx = strings.Index(content, "http{")
	}
	if httpIdx == -1 {
		return content, false, nil
	}
	braceIdx := strings.Index(content[httpIdx:], "{")
	if braceIdx == -1 {
		return content, false, nil
	}
	insertAt := httpIdx + braceIdx + 1
	injection := fmt.Sprintf("\n    %s\n    %s %d;\n", comment, directive, minimum)
	return content[:insertAt] + injection + content[insertAt:], true, nil
}
