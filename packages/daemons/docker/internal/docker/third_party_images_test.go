package docker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/opfield/opfield/daemon-shared/legacycompat"
)

const testPostgresUpstream = "docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"

func TestThirdPartyMirrorAcceptsTheOpfieldName(t *testing.T) {
	oldMirror := legacycompat.ImageRepository + "/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"
	newMirror := "ghcr.io/opfield/opfield/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"

	// Releases publish the mirror only under the Opfield name since 2.12.1
	// (valkey-bundle exists under no other), so an upstream reference pulls
	// it first and the earlier name next.
	if got := thirdPartyImageCandidates(testPostgresUpstream); !slices.Equal(got, []string{newMirror, oldMirror, testPostgresUpstream}) {
		t.Fatalf("upstream candidates = %v", got)
	}
	// A reference under the earlier name is pulled as named first.
	if got := thirdPartyImageCandidates(oldMirror); !slices.Equal(got, []string{oldMirror, newMirror, testPostgresUpstream}) {
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

// The allow-list is the release mirror list: an image the daemon pulls
// mirror-first is one the release pipeline mirrors, and each mirrored image
// gets the mirror-first pull.
func TestThirdPartyMirrorAllowListMatchesReleaseList(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "config", "third-party-images.json"))
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		MirrorRepository string `json:"mirrorRepository"`
		Images           []struct {
			Source string `json:"source"`
		} `json:"images"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		t.Fatal(err)
	}
	if list.MirrorRepository != thirdPartyMirrorRepository {
		t.Fatalf("the release list mirrors to %s, the daemon pulls %s first", list.MirrorRepository, thirdPartyMirrorRepository)
	}
	sources := map[string]struct{}{}
	for _, image := range list.Images {
		sources[image.Source] = struct{}{}
		if _, ok := thirdPartyMirroredImages[image.Source]; !ok {
			t.Errorf("%s is mirrored but not on the daemon's allow-list", image.Source)
		}
	}
	for upstream := range thirdPartyMirroredImages {
		if _, ok := sources[upstream]; !ok {
			t.Errorf("%s is on the daemon's allow-list but not mirrored", upstream)
		}
	}
	pulled := []string{volumeHelperImage}
	for _, reference := range keeperWitnessImages {
		pulled = append(pulled, reference)
	}
	for _, reference := range pulled {
		if _, ok := thirdPartyMirroredImages[reference]; !ok {
			t.Errorf("%s is pulled by the daemon but not mirrored", reference)
		}
	}
}
