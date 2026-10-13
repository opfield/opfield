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

// EnsureServerNamesHashBucketSize makes the global nginx configuration able to
// accept Opfield-generated Pages hostnames. Returns true when the file changed.
func EnsureServerNamesHashBucketSize(nginxConfPath string) (bool, error) {
	data, err := os.ReadFile(nginxConfPath)
	if err != nil {
		return false, err
	}

	content := string(data)
	if match := serverNamesHashBucketSizePattern.FindStringSubmatchIndex(content); match != nil {
		value, err := strconv.Atoi(content[match[4]:match[5]])
		if err != nil {
			return false, fmt.Errorf("parse server_names_hash_bucket_size: %w", err)
		}
		if value >= minimumServerNamesHashBucketSize {
			return false, nil
		}

		replacement := content[match[2]:match[3]] + "server_names_hash_bucket_size " + strconv.Itoa(minimumServerNamesHashBucketSize) + ";"
		updated := content[:match[0]] + replacement + content[match[1]:]
		return true, WriteAtomic(nginxConfPath, []byte(updated))
	}

	httpIdx := strings.Index(content, "http {")
	if httpIdx == -1 {
		httpIdx = strings.Index(content, "http{")
	}
	if httpIdx == -1 {
		return false, nil
	}

	braceIdx := strings.Index(content[httpIdx:], "{")
	if braceIdx == -1 {
		return false, nil
	}
	insertAt := httpIdx + braceIdx + 1
	injection := fmt.Sprintf(
		"\n    %s\n    server_names_hash_bucket_size %d;\n",
		serverNamesHashComment,
		minimumServerNamesHashBucketSize,
	)
	updated := content[:insertAt] + injection + content[insertAt:]

	return true, WriteAtomic(nginxConfPath, []byte(updated))
}
