#!/usr/bin/env bash
# Keyless Sigstore signatures and SBOMs for the images a build or release publishes (docs/verify-releases.md).
#
#   supply-chain.sh install
#       Installs pinned, checksum-verified cosign and syft into $RUNNER_TEMP/supply-chain and adds it to PATH.
#   supply-chain.sh sign <repository>@sha256:<digest> [--sbom <file>] [--also <repository>]...
#       Signs the digest with the workflow's GitHub OIDC identity (cosign keyless: Fulcio certificate, Rekor
#       transparency log entry) and attaches an SPDX JSON SBOM made by syft as a signed attestation. For a multi-arch
#       index the index and its linux/amd64 and linux/arm64 images are signed, and each of those images gets its own
#       SBOM attestation. A digest this repository's workflows already signed and attested is left as it is, so reruns
#       and backfills add nothing. --sbom also writes the SBOM to <file> (one file per platform for an index:
#       <file> with .spdx.json replaced by -<os>-<arch>.spdx.json) for the release assets. --also repeats the
#       signature and attestation for the same digest in another repository that carries it (the mirror).
#   supply-chain.sh sbom-file <path> <output>
#       Writes an SPDX JSON SBOM of a local file or directory (release binaries).
#
# Workflows run it only when the repository variable SIGN_IMAGES is true and grant `id-token: write`. It does not
# replace the Ed25519 update manifests installs verify; it lets anyone check an image without Opfield's tooling.
set -euo pipefail

COSIGN_VERSION=v3.1.3
COSIGN_LINUX_AMD64_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
SYFT_VERSION=1.54.1
SYFT_LINUX_AMD64_SHA256=c069905b391cc4c20a5ba65ad5c10be2a7ba074f8ea6ad203e24d14e303dad47
OIDC_ISSUER=https://token.actions.githubusercontent.com
PLATFORMS=(linux/amd64 linux/arm64)

die() {
  printf 'supply-chain: %s\n' "$*" >&2
  exit 1
}

install_tools() {
  local dir="${RUNNER_TEMP:?RUNNER_TEMP is required}/supply-chain"
  mkdir -p "$dir"
  curl -fsSL --retry 3 -o "${dir}/cosign" \
    "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"
  echo "${COSIGN_LINUX_AMD64_SHA256}  ${dir}/cosign" | sha256sum --check --strict
  chmod +x "${dir}/cosign"
  curl -fsSL --retry 3 -o "${dir}/syft.tar.gz" \
    "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_amd64.tar.gz"
  echo "${SYFT_LINUX_AMD64_SHA256}  ${dir}/syft.tar.gz" | sha256sum --check --strict
  tar -xzf "${dir}/syft.tar.gz" -C "$dir" syft
  rm -f "${dir}/syft.tar.gz"
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "$dir" >> "$GITHUB_PATH"
  fi
  "${dir}/cosign" version >/dev/null
  "${dir}/syft" version >/dev/null
}

# The certificate identity of every workflow in this repository, on a branch or a tag.
identity_regexp() {
  local repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
  printf '^https://github\\.com/%s/\\.github/workflows/[^@]+@refs/(heads|tags)/.+$' "${repository//./\\.}"
}

verify_args() {
  printf '%s\n' --certificate-identity-regexp "$(identity_regexp)" --certificate-oidc-issuer "$OIDC_ISSUER"
}

is_signed() {
  local args
  mapfile -t args < <(verify_args)
  cosign verify "${args[@]}" "$1" >/dev/null 2>&1
}

is_attested() {
  local args
  mapfile -t args < <(verify_args)
  cosign verify-attestation --type spdxjson "${args[@]}" "$1" >/dev/null 2>&1
}

sign_digest() {
  if is_signed "$1"; then
    printf 'already signed  %s\n' "$1"
    return
  fi
  cosign sign --yes "$1"
  printf 'signed          %s\n' "$1"
}

attest_digest() {
  local ref=$1 sbom=$2
  if is_attested "$ref"; then
    printf 'already attested %s\n' "$ref"
    return
  fi
  cosign attest --yes --type spdxjson --predicate "$sbom" "$ref"
  printf 'attested        %s\n' "$ref"
}

# Prints "<digest> <os/arch>" for the linux/amd64 and linux/arm64 images of an index, or "<digest> -" for an image.
platform_images() {
  local ref=$1 raw
  raw=$(docker buildx imagetools inspect --raw "$ref")
  if jq -e '.manifests? | type == "array"' >/dev/null <<<"$raw"; then
    local platform found=0
    for platform in "${PLATFORMS[@]}"; do
      local digest
      digest=$(jq -r --arg os "${platform%/*}" --arg arch "${platform#*/}" \
        '[.manifests[] | select(.platform.os == $os and .platform.architecture == $arch and ((.platform.variant // "") | IN("", "v8")))][0].digest // empty' \
        <<<"$raw")
      if [[ -n "$digest" ]]; then
        printf '%s %s\n' "$digest" "$platform"
        found=1
      fi
    done
    [[ "$found" == 1 ]] || die "${ref} has neither a linux/amd64 nor a linux/arm64 image"
  else
    printf '%s -\n' "${ref#*@}"
  fi
}

sign_image() {
  local ref=$1
  shift
  local sbom_out='' also=()
  while (($# > 0)); do
    case "$1" in
      --sbom) sbom_out=${2:?--sbom needs a file}; shift 2 ;;
      --also) also+=("${2:?--also needs a repository}"); shift 2 ;;
      *) die "unknown argument $1" ;;
    esac
  done
  [[ "$ref" =~ ^[^@]+@sha256:[0-9a-f]{64}$ ]] || die "${ref} is not <repository>@sha256:<digest>"
  local repository=${ref%@*} digest=${ref#*@}
  local repositories=("$repository" "${also[@]}")
  local work images line
  work=$(mktemp -d)
  mapfile -t images < <(platform_images "$ref")
  ((${#images[@]} > 0)) || die "could not read ${ref}"

  local child platform sbom target needs_sbom index=0 is_index=0
  for line in "${images[@]}"; do
    child=${line% *}
    platform=${line#* }
    index=$((index + 1))
    [[ "$platform" == - ]] || is_index=1
    sbom="${work}/sbom-${index}.spdx.json"
    needs_sbom=0
    [[ -n "$sbom_out" ]] && needs_sbom=1
    for target in "${repositories[@]}"; do
      is_attested "${target}@${child}" || needs_sbom=1
    done
    if [[ "$needs_sbom" == 1 ]]; then
      syft scan "registry:${repository}@${child}" --quiet -o "spdx-json=${sbom}"
    fi
    for target in "${repositories[@]}"; do
      sign_digest "${target}@${child}"
      if [[ -s "$sbom" ]]; then
        attest_digest "${target}@${child}" "$sbom"
      fi
    done
    if [[ -n "$sbom_out" ]]; then
      if [[ "$platform" == - ]]; then
        cp "$sbom" "$sbom_out"
      else
        cp "$sbom" "${sbom_out%.spdx.json}-${platform%/*}-${platform#*/}.spdx.json"
      fi
    fi
  done
  rm -rf "$work"

  # The index itself, which a tag resolves to: `cosign verify <repository>:<tag>` checks this signature.
  if [[ "$is_index" == 1 ]]; then
    for target in "${repositories[@]}"; do
      sign_digest "${target}@${digest}"
    done
  fi
}

case "${1:-}" in
  install) install_tools ;;
  sign) shift; sign_image "$@" ;;
  sbom-file)
    [[ $# -eq 3 ]] || die 'usage: supply-chain.sh sbom-file <path> <output>'
    syft scan "file:$2" --quiet -o "spdx-json=$3"
    ;;
  *) die 'usage: supply-chain.sh install | sign <repository>@sha256:<digest> [--sbom <file>] [--also <repository>]... | sbom-file <path> <output>' ;;
esac
