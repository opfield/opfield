# One downloadable extension bundle: the extension's PGDG packages plus every
# library and data file they need that the official PostgreSQL image of that
# major and Debian release does not have, as a rootfs fragment under files/ with
# its manifest opfield-bundle.json. The image is FROM scratch and never runs:
# the docker daemon copies its files into the database's volume
# (<volume>/extensions/<id>/<version>-pg<major>-<debian>-<arch>/) and removes it.
#
# Build with scripts/build-postgres-bundle.sh <id> <major>; the Image workflow
# publishes <image repository>/postgres-ext/<id>:<version>-pg<major>-<debian>-tree-<tree hash of this directory>.

# The official image the bundle is made for (versions.json "base" of the oldest
# catalog version of the major and Debian release).
ARG BASE
FROM ${BASE} AS build
# Bundle id, its packages, the pinned Debian version of the first package, and
# the packages of the bundles it requires (installed first, so their files stay
# out of this bundle).
ARG BUNDLE_ID
ARG BUNDLE_PACKAGES
ARG BUNDLE_PACKAGE_VERSION=""
ARG BUNDLE_REQUIRES=""
ARG BUNDLE_REQUIRES_PACKAGES=""
COPY make-bundle.sh /usr/local/bin/make-bundle.sh
RUN bash /usr/local/bin/make-bundle.sh

FROM scratch
COPY --from=build /bundle/ /
