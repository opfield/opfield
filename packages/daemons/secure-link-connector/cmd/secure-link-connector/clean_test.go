package main

import (
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"strings"
	"testing"
)

func TestCleanModeRefusesOtherDirectories(t *testing.T) {
	for _, directory := range []string{"/", legacycompat.ConnectorRunDir, legacycompat.RunDirPrefix + "clean/..", "relative"} {
		if err := emptyCleanDirectory(directory); err == nil || !strings.Contains(err.Error(), cleanDirectoryMount) {
			t.Fatalf("directory %q: error = %v, want a refusal", directory, err)
		}
	}
}
