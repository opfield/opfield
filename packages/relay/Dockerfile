FROM docker.io/library/golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 AS build
ARG RELAY_BUILD_VERSION=dev
WORKDIR /src
COPY packages/daemons/shared ./packages/daemons/shared
COPY packages/relay ./packages/relay
WORKDIR /src/packages/relay
# legacy-name: /gateway-relay entrypoint — remove once every node reports none.
# Compose files written by Opfield 2.12.0 (kept until the app host moves) start the relay and run its healthcheck at
# /gateway-relay; a symlink keeps them working without a second copy of the binary.
RUN mkdir /out \
  && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.buildVersion=${RELAY_BUILD_VERSION}" -o /out/opfield-relay ./cmd/opfield-relay \
  && ln -s /opfield-relay /out/gateway-relay

FROM scratch
# COPY keeps the symlink of the build stage as a symlink.
COPY --from=build /out/ /
ENTRYPOINT ["/opfield-relay"]
