#!/bin/sh
# Entrypoint of Opfield's PostgreSQL image: wires the extension bundles of the
# database's volume (opfield-extensions), then hands over to the official
# entrypoint unchanged. The wiring needs root, which the official image starts
# as before it drops to the postgres user; without root there is nothing to wire.
set -e
if [ "$(id -u)" = "0" ]; then
	if ! /usr/local/bin/opfield-extensions wire; then
		echo "opfield: the extension bundles could not be wired; extensions from them are unavailable" >&2
	fi
fi
exec docker-entrypoint.sh "$@"
