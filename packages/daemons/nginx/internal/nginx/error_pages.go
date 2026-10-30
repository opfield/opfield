package nginx

import (
	"bytes"
	"path/filepath"

	"github.com/opfield/opfield/nginx-daemon/internal/errorpages"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const errorPagesFilename = "00-opfield-error-pages.conf"

// ErrorPagesCapability tells Opfield the node keeps the page variables of errorpages.Config, so the route configs it
// renders may hand nginx's own error responses to them (nginx-error-pages.ts in Opfield).
const ErrorPagesCapability = "nginx_error_pages_v1"

// ErrorPagesV2Capability tells Opfield the page variables also hold the pages of errorpages.V2Codes (501, 505), so
// route configs may hand those codes to them too.
const ErrorPagesV2Capability = "nginx_error_pages_v2"

// ErrorPagesConfigPath is the managed file in the config directory that holds the page variables.
func ErrorPagesConfigPath(configDir string) string {
	return filepath.Join(configDir, naming.File(errorPagesFilename))
}

// EnsureErrorPagesConfig writes the page variables when they are missing or differ. It returns the content it
// replaced (nil when the file was missing) and whether it wrote.
func EnsureErrorPagesConfig(configDir string) (previous []byte, written bool, err error) {
	path := ErrorPagesConfigPath(configDir)
	// A copy under the other scheme's name (the installer's placeholder on a node that runs the other names) would
	// define the variables twice.
	other := filepath.Join(configDir, errorPagesFilename)
	if naming.File(errorPagesFilename) == errorPagesFilename {
		other = filepath.Join(configDir, naming.LegacyFile(errorPagesFilename))
	}
	if other != path {
		if err := RemoveFile(other); err != nil {
			return nil, false, err
		}
	}
	existing, err := ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	desired := []byte(errorpages.Config())
	if bytes.Equal(existing, desired) {
		return existing, false, nil
	}
	return existing, true, WriteAtomic(path, desired)
}
