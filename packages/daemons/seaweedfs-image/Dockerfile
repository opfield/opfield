# Opfield's SeaweedFS runtime image: the upstream release image with its weed
# binary rebuilt from the same upstream commit plus the patches in patches/.
# Everything else (Alpine base, entrypoint, user, layout) is the upstream
# image byte for byte. Build with scripts/build-seaweedfs-image.sh; the Image
# workflow publishes it as <image repository>/seaweedfs-gateway:tree-<tree hash> (ghcr.io/opfield/opfield, and
# ghcr.io/the-square-labs/gateway as its mirror)
# and the docker daemon pins its digest (seaweedfsImage).
#
# To move to a new upstream release: update the three ARGs below and re-apply
# each patch (`git apply --check`); drop a patch once upstream ships the fix.

# Upstream release image, multi-arch index digest (chrislusf/seaweedfs:4.47).
ARG SEAWEEDFS_BASE=docker.io/chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882
ARG GOLANG_IMAGE=docker.io/library/golang:1.26.6-alpine@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83

FROM --platform=$BUILDPLATFORM ${GOLANG_IMAGE} AS build
# The commit the upstream 4.47 image was built from (`weed version`).
ARG SEAWEEDFS_COMMIT=c5073360007d28385a33426a42ac3e4ec504c5a3
ARG GATEWAY_PATCH_LEVEL=1
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
  && git remote add origin https://github.com/seaweedfs/seaweedfs.git \
  && git fetch -q --depth 1 origin "${SEAWEEDFS_COMMIT}" \
  && git checkout -q FETCH_HEAD
COPY patches/ /patches/
RUN for patch in /patches/*.patch; do git apply --verbose "$patch"; done
ARG TARGETOS TARGETARCH
# Same flags as upstream's docker/Dockerfile.go_build (normal variant, no tags).
RUN cd weed \
  && GOOS="$TARGETOS" GOARCH="$TARGETARCH" CGO_ENABLED=0 GOTOOLCHAIN=local \
     go build -trimpath -buildvcs=false \
       -ldflags "-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=$(echo "$SEAWEEDFS_COMMIT" | cut -c1-9)-gateway.${GATEWAY_PATCH_LEVEL}" \
       -o /out/weed .

FROM ${SEAWEEDFS_BASE}
COPY --from=build /out/weed /usr/bin/weed
LABEL org.opencontainers.image.title="SeaweedFS for Gateway managed storage" \
      org.opencontainers.image.description="Upstream SeaweedFS with the patches in packages/daemons/seaweedfs-image/patches"
