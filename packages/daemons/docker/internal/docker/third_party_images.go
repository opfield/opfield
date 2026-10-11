package docker

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/client"
)

// thirdPartyMirrorRepository is the Gateway-owned GHCR namespace the release
// pipeline mirrors digest-pinned third-party runtime images into
// (scripts/mirror-third-party-images.mjs, config/third-party-images.json). The
// mirror keeps the upstream index digest byte for byte, so the digest stays the
// trust anchor whichever registry serves it.
const thirdPartyMirrorRepository = "ghcr.io/the-square-labs/gateway"

var thirdPartyImageReferencePattern = regexp.MustCompile(`^([a-z0-9.-]+\.[a-z]+(?::[0-9]+)?/[a-z0-9._/-]+)@(sha256:[a-f0-9]{64})$`)

// thirdPartyMirroredImages is the allow-list of upstream references the release
// pipeline mirrors. It must equal the "source" set of
// config/third-party-images.json (TestThirdPartyMirrorAllowListMatchesReleaseList).
// Only listed references get a mirror-first pull: an unlisted or operator-chosen
// image is pulled exactly as configured.
var thirdPartyMirroredImages = map[string]struct{}{
	"docker.io/chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882":          {},
	"docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a":             {},
	"docker.io/library/postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db":             {},
	"docker.io/library/postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d":             {},
	"docker.io/library/postgres@sha256:69dddb030ab69d669d8d7c6abf67aeb448178e5270d5f123a21f4f7ac8b46a24":             {},
	"docker.io/library/postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20":             {},
	"docker.io/library/postgres@sha256:21f6013073bc6b92830a2129570e2f5ec42a6c734b5a985a41e83aa58f54c3c1":             {},
	"docker.io/library/postgres@sha256:74e110c41804365e3915fcc09d5e7a1eff50161aaa94d5da0e58e0cd75ae509c":             {},
	"docker.io/library/postgres@sha256:822f8795764a670160640888508b2a68ea5c4b045012c2de17e1d0447bdbdc99":             {},
	"docker.io/library/postgres@sha256:caf49e3b10d377aa2cfee478591d623808527beb27125d38797b418013f72d81":             {},
	"docker.io/library/postgres@sha256:962ffbe9f6418387643411b127c1db27465e5a23b9a8849bfaf45fa6323963ce":             {},
	"docker.io/valkey/valkey-bundle@sha256:dd30c59c2b2a598e83308095220a31d6d93d64c40a839c702cb1e98c8e220660":         {},
	"docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236":                {},
	"docker.io/library/redis@sha256:c88d347edef6249a6d2293f926f1eeb48bd40c57cbcd02c07f52e7f1fd2cb46b":                {},
	"docker.io/library/redis@sha256:aefcda4d4388a70e628ad5ebbf162ae65509b20ea3dd6eeac7dcbbb675d94dba":                {},
	"docker.io/library/redis@sha256:6159aff1adde991d8747d705fa1135ceda04b0414dc372b381a6af415ec3b374":                {},
	"docker.io/library/redis@sha256:616bb446d5db225ddf786052834279e7c7222c48694d4451e8af22b8f5953b28":                {},
	"docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b":                {},
	"docker.io/library/redis@sha256:16623900b6ddd58e8bac04ccb6b611b9a5d1aed165453e28bcaed251d549d62c":                {},
	"docker.io/library/redis@sha256:2a5e873bfae4bcc660b27f45c391d4a7a01799b65dea7286acc858e9c6c1e7d3":                {},
	"docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5": {},
	"docker.io/clickhouse/clickhouse-server@sha256:fdc22372465a336fa47e9deab61fad8277b9e2f2473234a1294b33b53f01d377": {},
	"docker.io/clickhouse/clickhouse-server@sha256:0d16977194aca61e26631e616e0678c2a745344d7d9da5729d2356f413dd28e1": {},
	"docker.io/clickhouse/clickhouse-server@sha256:ab3f33278b99576ea2ff2b0fa316b5e078c8b25f8ba08956cdbbb67d85c8b30f": {},
	"docker.io/clickhouse/clickhouse-server@sha256:422be85ae7344058369cdd366ac0efea9daa8428b55c9cf50258e83a7d12fcb3": {},
	"docker.io/clickhouse/clickhouse-server@sha256:a9d328123ff8a61bf6b16448528b577d59deb85758172e13b09054b0727f8adf": {},
	"docker.io/clickhouse/clickhouse-server@sha256:0ab6e7c7597232b56c2883f67ef91154e7e3b54d1fda57606334aad65275e735": {},
	"docker.io/clickhouse/clickhouse-server@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b": {},
	"docker.io/clickhouse/clickhouse-server@sha256:85b97f63dcfff47790d26bb5d5801637aaddb2b93e5e9aee27a686c2fb2b9916": {},
	"docker.io/docker/compose-bin@sha256:962d5ea7017e5ef425bfa47e492efa2c27d0492e8af58c497011e73b2ce98ee0":           {},
	"docker.io/library/docker@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c":               {},
	"docker.io/library/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8":             {},
	"docker.io/library/postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea":             {},
	"docker.io/library/redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499":                {},
}

// thirdPartyMirrorReference returns the GHCR mirror reference of an
// allow-listed upstream reference. The mirror name is the last path segment
// of the upstream repository.
func thirdPartyMirrorReference(upstream string) (string, bool) {
	if _, ok := thirdPartyMirroredImages[upstream]; !ok {
		return "", false
	}
	match := thirdPartyImageReferencePattern.FindStringSubmatch(upstream)
	if match == nil {
		return "", false
	}
	repository := match[1]
	name := repository[strings.LastIndex(repository, "/")+1:]
	return thirdPartyMirrorRepository + "/" + name + "@" + match[2], true
}

// thirdPartyUpstreamReference maps a GHCR mirror reference back to the
// allow-listed upstream reference with the same name and digest.
func thirdPartyUpstreamReference(mirror string) (string, bool) {
	if !strings.HasPrefix(mirror, thirdPartyMirrorRepository+"/") {
		return "", false
	}
	for upstream := range thirdPartyMirroredImages {
		if candidate, ok := thirdPartyMirrorReference(upstream); ok && candidate == mirror {
			return upstream, true
		}
	}
	return "", false
}

// thirdPartyImageCandidates returns the references to try, in order, for one
// digest-pinned image: the GHCR mirror first and the upstream reference as the
// fallback when the image is allow-listed, otherwise the reference alone.
func thirdPartyImageCandidates(reference string) []string {
	upstream := reference
	if mapped, ok := thirdPartyUpstreamReference(reference); ok {
		upstream = mapped
	}
	if mirror, ok := thirdPartyMirrorReference(upstream); ok {
		return []string{mirror, upstream}
	}
	return []string{reference}
}

// isThirdPartyMirrorOf reports whether candidate is the GHCR mirror of upstream.
func isThirdPartyMirrorOf(candidate, upstream string) bool {
	mirror, ok := thirdPartyMirrorReference(upstream)
	return ok && candidate == mirror
}

// thirdPartyImagePullError reports that no candidate registry could provide a
// digest-pinned image. Attempts keep the candidate order.
type thirdPartyImagePullError struct {
	Reference string
	Attempts  []thirdPartyImagePullAttempt
}

type thirdPartyImagePullAttempt struct {
	Reference string
	Err       error
}

func (e *thirdPartyImagePullError) Error() string {
	parts := make([]string, 0, len(e.Attempts))
	for _, attempt := range e.Attempts {
		parts = append(parts, fmt.Sprintf("%s: %v", attempt.Reference, attempt.Err))
	}
	return fmt.Sprintf("image %s is unavailable (%s)", e.Reference, strings.Join(parts, "; "))
}

// EnsureThirdPartyImage makes a digest-pinned third-party image available
// locally and returns the exact reference containers must be created from.
// A copy already present under any candidate reference is used as is, so an
// existing node keeps its docker.io image and never re-pulls. Otherwise the
// GHCR mirror is pulled first and the upstream reference is the fallback.
func (c *Client) EnsureThirdPartyImage(ctx context.Context, reference string) (string, error) {
	candidates := thirdPartyImageCandidates(reference)
	for _, candidate := range candidates {
		present, err := c.localImagePresent(ctx, candidate)
		if err != nil {
			return "", err
		}
		if present {
			return candidate, nil
		}
	}
	failure := &thirdPartyImagePullError{Reference: reference}
	for _, candidate := range candidates {
		if err := c.PullImage(ctx, candidate, ""); err != nil {
			failure.Attempts = append(failure.Attempts, thirdPartyImagePullAttempt{Reference: candidate, Err: err})
			if ctx.Err() != nil {
				break
			}
			continue
		}
		present, err := c.localImagePresent(ctx, candidate)
		if err != nil {
			return "", err
		}
		if present {
			return candidate, nil
		}
		failure.Attempts = append(failure.Attempts, thirdPartyImagePullAttempt{Reference: candidate, Err: errors.New("image is not present after pull")})
	}
	return "", failure
}

// localImagePresent reports whether an exact reference resolves in the local
// image store without contacting a registry.
func (c *Client) localImagePresent(ctx context.Context, reference string) (bool, error) {
	if _, err := c.cli.ImageInspect(ctx, reference); err == nil {
		return true, nil
	} else if !cerrdefs.IsNotFound(err) {
		return false, fmt.Errorf("inspect image: %w", err)
	}
	listed, err := c.cli.ImageList(ctx, client.ImageListOptions{
		All:     true,
		Filters: make(client.Filters).Add("reference", reference),
	})
	if err != nil {
		return false, fmt.Errorf("list local images after inspect miss: %w", err)
	}
	for _, image := range listed.Items {
		if containsExactImageReference(image.RepoTags, reference) || containsExactImageReference(image.RepoDigests, reference) {
			return true, nil
		}
	}
	return false, nil
}
