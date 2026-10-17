package docker

import (
	"context"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/client"
)

const testPatchedSeaweedFSImage = legacycompat.ImageRepository + "/" + legacycompat.SeaweedFSImageRepository + "@sha256:" + "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"

// Before Opfield's own build is pinned the upstream image (either reference)
// is current; once it is pinned only that build is, so existing storages move
// to it at their next update or restart.
func TestSeaweedFSImageCurrent(t *testing.T) {
	mirror, ok := thirdPartyMirrorReference(seaweedfsUpstreamImage)
	if !ok {
		t.Fatal("the upstream SeaweedFS image is not mirrored")
	}
	for _, tc := range []struct {
		reference, pinned string
		current           bool
	}{
		{seaweedfsUpstreamImage, seaweedfsUpstreamImage, true},
		{mirror, seaweedfsUpstreamImage, true},
		{"docker.io/chrislusf/seaweedfs:4.47", seaweedfsUpstreamImage, false},
		{testPatchedSeaweedFSImage, testPatchedSeaweedFSImage, true},
		{seaweedfsUpstreamImage, testPatchedSeaweedFSImage, false},
		{mirror, testPatchedSeaweedFSImage, false},
	} {
		if got := seaweedfsImageCurrent(tc.reference, tc.pinned); got != tc.current {
			t.Fatalf("seaweedfsImageCurrent(%s, %s) = %v, want %v", tc.reference, tc.pinned, got, tc.current)
		}
	}
	if !isTrustedSeaweedFSImage(seaweedfsImage) || !isTrustedSeaweedFSImage(seaweedfsUpstreamImage) || !isTrustedSeaweedFSImage(mirror) {
		t.Fatal("a pinned SeaweedFS reference is not trusted")
	}
}

// fakeImageStore answers image inspect and pull for the references it holds or
// can pull, and records the pulls.
type fakeImageStore struct {
	mu       sync.Mutex
	local    map[string]bool
	pullable map[string]bool
	pulls    []string
}

func (f *fakeImageStore) client(t *testing.T) *Client {
	t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(f.serve)}))
	if err != nil {
		t.Fatal(err)
	}
	return &Client{cli: cli}
}

func (f *fakeImageStore) serve(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	respond := func(status int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1.47")
	switch {
	case path == "/images/json":
		return respond(http.StatusOK, `[]`)
	case strings.HasPrefix(path, "/images/") && strings.HasSuffix(path, "/json"):
		reference := strings.TrimSuffix(strings.TrimPrefix(path, "/images/"), "/json")
		if f.local[reference] {
			return respond(http.StatusOK, `{"Id":"sha256:1"}`)
		}
		return respond(http.StatusNotFound, `{"message":"No such image"}`)
	case path == "/images/create":
		reference := r.URL.Query().Get("fromImage")
		if tag := r.URL.Query().Get("tag"); tag != "" {
			if strings.HasPrefix(tag, "sha256:") {
				reference += "@" + tag
			} else {
				reference += ":" + tag
			}
		}
		f.pulls = append(f.pulls, reference)
		if !f.pullable[reference] {
			return respond(http.StatusNotFound, `{"message":"manifest unknown"}`)
		}
		f.local[reference] = true
		return respond(http.StatusOK, `{"status":"Downloaded"}`)
	}
	return respond(http.StatusNotFound, `{"message":"unexpected `+r.Method+" "+path+`"}`)
}

func TestEnsureSeaweedFSImagePrefersTheOpfieldBuild(t *testing.T) {
	mirror, _ := thirdPartyMirrorReference(seaweedfsUpstreamImage)
	ctx := context.Background()

	// Pinned and pullable: the build is used even with the upstream image cached.
	store := &fakeImageStore{local: map[string]bool{seaweedfsUpstreamImage: true}, pullable: map[string]bool{testPatchedSeaweedFSImage: true}}
	m := &managedStorageManager{client: store.client(t)}
	if got, err := m.ensureSeaweedFSImage(ctx, testPatchedSeaweedFSImage); err != nil || got != testPatchedSeaweedFSImage {
		t.Fatalf("pinned build: %q, %v", got, err)
	}

	// Pinned but unreachable: the upstream image keeps the storage running.
	store = &fakeImageStore{local: map[string]bool{}, pullable: map[string]bool{mirror: true}}
	m = &managedStorageManager{client: store.client(t)}
	if got, err := m.ensureSeaweedFSImage(ctx, testPatchedSeaweedFSImage); err != nil || got != mirror {
		t.Fatalf("fallback: %q, %v (pulls %v)", got, err, store.pulls)
	}

	// Not pinned yet: the upstream image as before, the cached copy without a pull.
	store = &fakeImageStore{local: map[string]bool{seaweedfsUpstreamImage: true}, pullable: map[string]bool{}}
	m = &managedStorageManager{client: store.client(t)}
	if got, err := m.ensureSeaweedFSImage(ctx, seaweedfsUpstreamImage); err != nil || got != seaweedfsUpstreamImage || len(store.pulls) != 0 {
		t.Fatalf("upstream: %q, %v (pulls %v)", got, err, store.pulls)
	}
}
