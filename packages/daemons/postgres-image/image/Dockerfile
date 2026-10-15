# Opfield's managed PostgreSQL image: the pinned official image of one catalog
# version, plus
#   - the light extensions of baked.list (installed from the PGDG repository the
#     official image already configures; each adds at most about 10 MB), and
#   - an entrypoint wrapper that wires the downloadable extension bundles the
#     docker daemon installed into the database's own volume
#     (/var/lib/postgresql/data/extensions) before the official entrypoint runs.
# Entrypoint behaviour, data directory layout, users and PG_MAJOR stay the
# official image's, so a database switches to this image of the same major with
# its data kept.
#
# Build with scripts/build-postgres-image.sh <version>; the Image workflow
# publishes <image repository>/postgres:<version>-tree-<tree hash of this
# directory> for every entry of
# packages/daemons/docker/internal/pgext/catalog/versions.json, and the docker
# daemon accepts its digest once it is pinned there.

# The official image of the catalog version, multi-arch index digest
# (versions.json "base"); no default, so a build always names it.
ARG BASE
FROM ${BASE}
ARG OPFIELD_IMAGE_LEVEL=1
COPY baked.list install-baked.sh /usr/local/share/opfield/
RUN bash /usr/local/share/opfield/install-baked.sh /usr/local/share/opfield/baked.list
COPY opfield-entrypoint.sh opfield-extensions /usr/local/bin/
RUN chmod 0755 /usr/local/bin/opfield-entrypoint.sh /usr/local/bin/opfield-extensions
ENTRYPOINT ["opfield-entrypoint.sh"]
CMD ["postgres"]
LABEL org.opencontainers.image.title="PostgreSQL for Opfield managed databases" \
      org.opencontainers.image.description="The official PostgreSQL image with light extensions and extension bundle wiring (packages/daemons/postgres-image)" \
      net.opfield.postgres-image.level="${OPFIELD_IMAGE_LEVEL}"
