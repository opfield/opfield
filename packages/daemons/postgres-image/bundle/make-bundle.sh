#!/bin/bash
# Builds one extension bundle inside the official PostgreSQL image (Dockerfile,
# as root): installs the packages of the required bundles, snapshots /usr,
# installs the bundle's packages, and copies what they added under usr/lib and
# usr/share to /bundle/files with the manifest /bundle/opfield-bundle.json.
# Fails when the install changed a file the image already had (the bundle could
# not run against the image's copy) or a path cannot be written to the manifest.
set -euo pipefail
: "${BUNDLE_ID:?}" "${BUNDLE_PACKAGES:?}"
major="${PG_MAJOR:?the official PostgreSQL image sets PG_MAJOR}"
export DEBIAN_FRONTEND=noninteractive
packages() { local p; for p in $1; do echo "${p//\{major\}/$major}"; done; }

apt-get update -qq
if [[ -n "${BUNDLE_REQUIRES_PACKAGES:-}" ]]; then
	# shellcheck disable=SC2046
	apt-get install -y -qq --no-install-recommends $(packages "$BUNDLE_REQUIRES_PACKAGES")
fi
mapfile -t install < <(packages "$BUNDLE_PACKAGES")
primary="${install[0]}"
if [[ -n "${BUNDLE_PACKAGE_VERSION:-}" ]]; then
	install[0]="$primary=$BUNDLE_PACKAGE_VERSION"
fi

snapshot() {
	find /usr -xdev \( -type f -o -type l \) -printf '%p\t%s\t%T@\n' | LC_ALL=C sort
}
snapshot > /tmp/before
apt-get install -y -qq --no-install-recommends "${install[@]}"
snapshot > /tmp/after

changed="$(LC_ALL=C join -t $'\t' -j 1 /tmp/before /tmp/after | awk -F '\t' '$2 != $4 || $3 != $5 { print $1 }' | grep -E '^/usr/(lib|share)/' | grep -vE '^/usr/share/(doc|man|info|locale|lintian)/' || true)"
if [[ -n "$changed" ]]; then
	echo "the bundle's packages change files of the image:" >&2
	echo "$changed" >&2
	exit 1
fi

wanted() {
	case "$1" in
		/usr/share/doc/*/copyright) return 0 ;;
		/usr/share/doc/* | /usr/share/man/* | /usr/share/info/* | /usr/share/locale/* | /usr/share/lintian/* | /usr/share/bug/* | /usr/share/doc-base/*) return 1 ;;
		/usr/lib/postgresql/*/lib/bitcode/* | /usr/lib/postgresql/*/bin/*) return 1 ;;
		/usr/lib/* | /usr/share/*) return 0 ;;
	esac
	return 1
}

out=/bundle/files
mkdir -p "$out"
LC_ALL=C join -t $'\t' -v 2 -j 1 /tmp/before /tmp/after | cut -f1 > /tmp/added
while IFS= read -r path; do
	wanted "$path" || continue
	if [[ ! "$path" =~ ^[A-Za-z0-9._+@/,=~-]+$ ]]; then
		echo "unsupported character in $path" >&2
		exit 1
	fi
	if [[ -L "$path" ]]; then
		target="$(readlink "$path")"
		if [[ "$target" == /* ]]; then
			# Absolute links (update-alternatives names the default extension
			# version this way: postgis.control -> /etc/alternatives/… ->
			# postgis-3.control) become relative links to their final target
			# when that is a file of the bundle; others cannot be carried.
			final="$(readlink -f "$path")"
			if ! grep -qxF "$final" /tmp/added || ! wanted "$final" || [[ -L "$final" ]]; then
				echo "skipping $path -> $target" >&2
				continue
			fi
			target="$(realpath -m --relative-to="$(dirname "$path")" "$final")"
		fi
		mkdir -p "$out$(dirname "$path")"
		ln -s "$target" "$out$path"
	else
		mkdir -p "$out$(dirname "$path")"
		cp -p "$path" "$out$path"
		chmod u+rw,go+r,go-w,ug-s "$out$path"
	fi
done < /tmp/added

version="$(dpkg-query -W -f '${Version}' "$primary" | sed -E 's/^[0-9]+://; s/[-+~].*$//')"
. /etc/os-release
arch="$(dpkg --print-architecture)"
json_list() {
	local first=1 item
	printf '['
	for item in "$@"; do
		[[ -n "$item" ]] || continue
		((first)) || printf ','
		printf '"%s"' "$item"
		first=0
	done
	printf ']'
}
provides=()
if [[ -d "$out/usr/share/postgresql/$major/extension" ]]; then
	mapfile -t provides < <(find "$out/usr/share/postgresql/$major/extension" -maxdepth 1 -name '*.control' -printf '%f\n' | sed 's/\.control$//' | LC_ALL=C sort)
fi
read -r -a requires <<< "${BUNDLE_REQUIRES:-}"
total=0
{
	printf '{"schemaVersion":1,"id":"%s","version":"%s","major":"%s","debian":"%s","arch":"%s",' \
		"$BUNDLE_ID" "$version" "$major" "${VERSION_CODENAME:?}" "$arch"
	printf '"package":"%s","packageVersion":"%s",' "$primary" "$(dpkg-query -W -f '${Version}' "$primary")"
	printf '"provides":%s,"requires":%s,"files":[' "$(json_list "${provides[@]}")" "$(json_list "${requires[@]}")"
	first=1
	while IFS= read -r -d '' rel; do
		rel="${rel#./}"
		((first)) || printf ','
		first=0
		if [[ -L "$out/$rel" ]]; then
			printf '{"path":"%s","type":"symlink","target":"%s"}' "$rel" "$(readlink "$out/$rel")"
		else
			size="$(stat -c '%s' "$out/$rel")"
			total=$((total + size))
			printf '{"path":"%s","type":"file","size":%s,"mode":"%s","sha256":"%s"}' \
				"$rel" "$size" "$(stat -c '%a' "$out/$rel")" "$(sha256sum "$out/$rel" | cut -d' ' -f1)"
		fi
	done < <(cd "$out" && find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z)
	printf '],"sizeBytes":%s}\n' "$total"
} > /bundle/opfield-bundle.json
echo "bundle $BUNDLE_ID $version pg$major $VERSION_CODENAME $arch: $(du -sh "$out" | cut -f1), provides ${provides[*]:-nothing}"
