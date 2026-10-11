package docker

import (
	"slices"
	"testing"
)

const testPostgresUpstream = "docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"

func TestThirdPartyMirrorAcceptsTheOpfieldName(t *testing.T) {
	oldMirror := "ghcr.io/the-square-labs/gateway/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"
	newMirror := "ghcr.io/opfield/opfield/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"

	// The pull order of the names a 2.11.4 peer sends does not change.
	if got := thirdPartyImageCandidates(testPostgresUpstream); !slices.Equal(got, []string{oldMirror, testPostgresUpstream}) {
		t.Fatalf("upstream candidates = %v", got)
	}
	if got := thirdPartyImageCandidates(oldMirror); !slices.Equal(got, []string{oldMirror, testPostgresUpstream}) {
		t.Fatalf("mirror candidates = %v", got)
	}
	// The Opfield name is pulled as named, with the earlier mirror and upstream behind it.
	if got := thirdPartyImageCandidates(newMirror); !slices.Equal(got, []string{newMirror, oldMirror, testPostgresUpstream}) {
		t.Fatalf("opfield mirror candidates = %v", got)
	}
	for _, mirror := range []string{oldMirror, newMirror} {
		if upstream, ok := thirdPartyUpstreamReference(mirror); !ok || upstream != testPostgresUpstream {
			t.Fatalf("%s maps to %q, %v", mirror, upstream, ok)
		}
		if !isThirdPartyMirrorOf(mirror, testPostgresUpstream) {
			t.Fatalf("%s is a mirror of %s", mirror, testPostgresUpstream)
		}
		if !isCuratedDigestImage("postgres", mirror) {
			t.Fatalf("%s is a curated postgres image", mirror)
		}
	}
	if !isTrustedSeaweedFSImage("ghcr.io/opfield/opfield/seaweedfs@" + seaweedfsImageDigest) {
		t.Fatal("the Opfield mirror of upstream SeaweedFS is trusted")
	}

	for _, foreign := range []string{
		"ghcr.io/opfield/other/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a",
		"ghcr.io/opfield/opfield/postgres@sha256:" + "0000000000000000000000000000000000000000000000000000000000000000",
		"ghcr.io/opfield/opfield/redis@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a",
	} {
		if _, ok := thirdPartyUpstreamReference(foreign); ok {
			t.Fatalf("%s is not a mirror", foreign)
		}
		if isCuratedDigestImage("postgres", foreign) {
			t.Fatalf("%s is not a curated image", foreign)
		}
		if got := thirdPartyImageCandidates(foreign); !slices.Equal(got, []string{foreign}) {
			t.Fatalf("%s candidates = %v", foreign, got)
		}
	}
}
