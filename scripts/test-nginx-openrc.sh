#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
# No host networking, service directories or daemon state are mounted. All
# service lifecycle changes happen inside this disposable Alpine container.
docker run --rm \
  --mount "type=bind,source=${repo_root},target=/workspace,readonly" \
  --workdir /workspace/packages/daemons \
  --env OPFIELD_OPENRC_CONTAINER_TEST=1 \
  --env CGO_ENABLED=0 \
  golang:1.24.4-alpine3.22@sha256:68932fa6d4d4059845c8f40ad7e654e626f3ebd3706eef7846f319293ab5cb7a sh -ec '
    apk add --no-cache nginx openrc bash >/dev/null
    mkdir -p /run/openrc
    touch /run/openrc/softlevel
    printf "%s\n" "server { listen 18080; location / { return 200 \"openrc-ok\\n\"; } }" > /etc/nginx/http.d/opfield-compat-test.conf
    go test -mod=readonly -count=1 ./nginx/...
    go vet ./nginx/...
  '
