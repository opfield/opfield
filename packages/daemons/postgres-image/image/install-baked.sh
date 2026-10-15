#!/bin/bash
# Installs the light extensions of baked.list into the official PostgreSQL image
# (run once by the Dockerfile, as root) and records what it installed or skipped
# in /usr/local/share/opfield/extensions.txt.
set -euo pipefail
list="$1"
major="${PG_MAJOR:?the official PostgreSQL image sets PG_MAJOR}"
record=/usr/local/share/opfield/extensions.txt
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

apt_packages=()
files_packages=()
: > "$record"
while read -r id need mode packages; do
  case "$id" in '' | '#'*) continue ;; esac
  resolved=()
  missing=""
  for package in $packages; do
    package="${package//\{major\}/$major}"
    if apt-cache show --no-all-versions "$package" >/dev/null 2>&1; then
      resolved+=("$package")
    else
      missing="$package"
    fi
  done
  if [[ -n "$missing" ]]; then
    if [[ "$need" == required ]]; then
      echo "baked extension $id: PGDG has no $missing for PostgreSQL $major" >&2
      exit 1
    fi
    printf '%s\tskipped\t%s\n' "$id" "$missing" >> "$record"
    continue
  fi
  case "$mode" in
    apt) apt_packages+=("${resolved[@]}") ;;
    files) files_packages+=("${resolved[@]}") ;;
    *) echo "baked extension $id: unknown mode $mode" >&2; exit 1 ;;
  esac
  for package in "${resolved[@]}"; do
    printf '%s\t%s\t%s\n' "$id" "$mode" "$(apt-cache show --no-all-versions "$package" | awk '/^Version:/ { print $2; exit }')" >> "$record"
  done
done < "$list"

if ((${#apt_packages[@]} > 0)); then
  apt-get install -y -qq --no-install-recommends "${apt_packages[@]}"
fi
if ((${#files_packages[@]} > 0)); then
  work="$(mktemp -d)"
  (cd "$work" && apt-get download -qq "${files_packages[@]}")
  for deb in "$work"/*.deb; do
    package="$(dpkg-deb -f "$deb" Package)"
    dpkg-deb -x "$deb" "$work/root"
    # Only what the server loads: control and SQL files, the shared libraries
    # (no JIT bitcode) and the licence.
    for dir in "usr/share/postgresql/$major/extension" "usr/lib/postgresql/$major/lib"; do
      if [[ -d "$work/root/$dir" ]]; then
        mkdir -p "/$dir"
        (cd "$work/root/$dir" && find . -maxdepth 1 \( -type f -o -type l \) -exec cp -a --parents {} "/$dir/" \;)
      fi
    done
    if [[ -f "$work/root/usr/share/doc/$package/copyright" ]]; then
      install -D -m 0644 "$work/root/usr/share/doc/$package/copyright" "/usr/share/doc/$package/copyright"
    fi
    rm -rf "$work/root"
  done
  rm -rf "$work"
fi
apt-get clean
rm -rf /var/lib/apt/lists/*
cat "$record"
