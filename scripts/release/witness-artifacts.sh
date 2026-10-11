#!/usr/bin/env bash
# Builds and signs the witness artifacts of a Gateway release (config/witness-artifacts.json):
# extracts each binary from its digest-pinned image (GHCR mirror first, upstream digest otherwise),
# writes <component>-<version>-linux-<arch> and its signed manifest (<artifact>.update.json, kind
# witness-binary) into OUT_DIR. The update Worker serves them at
# ${ARTIFACT_BASE_URL}/<component>/<tag>/<artifact>.
#
# Usage: scripts/release/witness-artifacts.sh <tag> <out-dir>
# Env:   UPDATE_SIGNING_PRIVATE_KEY_PEM_B64 (required), ARTIFACT_BASE_URL (default the public update
#        service), GIT_COMMIT_SHA (optional), WITNESS_DRY_RUN=1 extracts and hashes without signing.
set -euo pipefail

tag="${1:?usage: witness-artifacts.sh <tag> <out-dir>}"
out_dir="${2:?usage: witness-artifacts.sh <tag> <out-dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
base_url="${ARTIFACT_BASE_URL:-https://get.opfield.dev/gateway}"
base_url="${base_url%/}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "not a Gateway release tag: $tag" >&2; exit 1; }
if [[ "${WITNESS_DRY_RUN:-}" != "1" && -z "${UPDATE_SIGNING_PRIVATE_KEY_PEM_B64:-}" ]]; then
  echo 'UPDATE_SIGNING_PRIVATE_KEY_PEM_B64 is required' >&2
  exit 1
fi
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

# One line per artifact: component version arch binary-path upstream-ref mirror-ref
entries="$(node --input-type=module - "$root" <<'NODE'
import { readFileSync } from 'node:fs';
const root = process.argv[2];
const witnesses = JSON.parse(readFileSync(`${root}/config/witness-artifacts.json`, 'utf8'));
const images = JSON.parse(readFileSync(`${root}/config/third-party-images.json`, 'utf8'));
for (const witness of witnesses.witnesses) {
  const image = images.images.find((entry) => entry.name === witness.image.name && entry.tag === witness.image.tag);
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image.source)) {
    throw new Error(`${witness.component}: no digest-pinned image ${witness.image.name}:${witness.image.tag}`);
  }
  if (!/^[a-z0-9-]+$/.test(witness.component) || !/^[0-9.]+$/.test(witness.version)) {
    throw new Error(`${witness.component}: invalid component or version`);
  }
  const digest = image.source.slice(image.source.indexOf('@') + 1);
  const mirror = `${images.mirrorRepository}/${image.name}@${digest}`;
  for (const arch of witness.arches) {
    console.log([witness.component, witness.version, arch, witness.binary, image.source, mirror].join(' '));
  }
}
NODE
)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
while read -r component version arch binary upstream mirror; do
  [[ -n "$component" ]] || continue
  artifact="${component}-${version}-linux-${arch}"
  ref="$mirror"
  if ! docker pull --quiet --platform "linux/${arch}" "$ref" >/dev/null 2>&1; then
    echo "mirror ${mirror} unavailable; using ${upstream}" >&2
    ref="$upstream"
    docker pull --quiet --platform "linux/${arch}" "$ref" >/dev/null
  fi
  container="$(docker create --platform "linux/${arch}" "$ref")"
  docker cp -L "${container}:${binary}" "${work}/${artifact}"
  docker rm "$container" >/dev/null
  # The binary must be an ELF executable of the right machine (EM_X86_64 62, EM_AARCH64 183).
  node --input-type=module - "${work}/${artifact}" "$arch" <<'NODE'
import { openSync, readSync } from 'node:fs';
const [path, arch] = process.argv.slice(2);
const header = Buffer.alloc(20);
readSync(openSync(path, 'r'), header, 0, 20, 0);
const machine = header.readUInt16LE(18);
const want = { amd64: 62, arm64: 183 }[arch];
if (header.toString('latin1', 0, 4) !== '\x7fELF' || machine !== want) {
  throw new Error(`${path} is not a linux/${arch} ELF executable (machine ${machine})`);
}
NODE
  chmod 0755 "${work}/${artifact}"
  mv "${work}/${artifact}" "${out_dir}/${artifact}"
  sha="$(sha256sum "${out_dir}/${artifact}" | cut -d' ' -f1)"
  url="${base_url}/${component}/${tag}/${artifact}"
  echo "${artifact} sha256=${sha} url=${url}"
  if [[ "${WITNESS_DRY_RUN:-}" == "1" ]]; then
    continue
  fi
  (
    cd "${root}/packages/daemons"
    go run ./shared/cmd/update-trust sign \
      --kind witness-binary \
      --component "$component" \
      --version "$version" \
      --arch "$arch" \
      --artifact-name "$artifact" \
      --download-url "$url" \
      --sha256 "$sha" \
      --git-commit-sha "${GIT_COMMIT_SHA:-}" \
      --out "${out_dir}/${artifact}.update.json"
  )
done <<<"$entries"
