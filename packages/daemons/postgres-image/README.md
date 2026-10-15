# Opfield's managed PostgreSQL image and extension bundles

Managed PostgreSQL databases offer a curated set of extensions. They come three ways:

| Delivery | Where it lives | Enabling it |
| --- | --- | --- |
| contrib | in the official PostgreSQL image | works on every image |
| baked | in Opfield's image (`image/`): light PGDG extensions, each at most about 10 MB with the libraries it needs | needs Opfield's image of the database's version |
| bundle | downloaded into the database's own volume (`bundle/`): PostGIS and pgRouting, which need GDAL, GEOS, PROJ and Boost | needs Opfield's image and the bundle installed on every server of the database |

The curated list, the catalog versions and the pinned bundles are the three manifests in
`packages/daemons/docker/internal/pgext/catalog/` (compiled into the docker daemon; the controller keeps an identical
copy that its tests compare):

- `extensions.json` — every extension Opfield offers: category, one-line description, delivery, the bundle it needs,
  the `shared_preload_libraries` entries it needs. The daemon refuses every other name. `neverExposed` lists names
  that must never be added (file_fdw, adminpack, pageinspect, pg_surgery, untrusted languages, xml2, sepgsql, …).
- `versions.json` — every catalog version with its official image (`base`, always accepted) and Opfield's image of it
  (`image`, `null` until published and pinned).
- `bundles.json` — the published bundle builds per bundle, PostgreSQL major and Debian release, with their digest and
  installed size per architecture. Empty until published and pinned.

## Image (`image/`)

The pinned official image of one catalog version plus the packages of `baked.list` and an entrypoint wrapper. The
official entrypoint, users, data directory layout and `PG_MAJOR` stay as they are, so a database moves to Opfield's
image of its version with its data kept (the same-major image update). `opfield-entrypoint.sh` runs
`opfield-extensions wire` as root, then the official `docker-entrypoint.sh`.

```bash
scripts/build-postgres-image.sh 17.10                       # local image opfield-postgres:17.10-local
scripts/build-postgres-image.sh --push <repo>/postgres:<tag> 17.10   # multi-arch (CI)
```

## Bundles (`bundle/`)

A bundle is a FROM-scratch image with `opfield-bundle.json` and `files/`: the extension's PGDG packages plus every
library and data file they need that the official image of that major and Debian release lacks, as a fragment of the
root filesystem under `usr/lib` and `usr/share`. `make-bundle.sh` fails when the packages would change a file the image
already has. The manifest lists every file with its size and sha256 and every link with its target.

```bash
scripts/build-postgres-bundle.sh --resolve postgis 17       # base, Debian release, package version PGDG serves now
scripts/build-postgres-bundle.sh postgis 17                 # local bundle
scripts/build-postgres-bundle.sh --push <repo>/postgres-ext/postgis:<tag> postgis 17 <package version>   # CI
```

On a host whose Docker engine has no bridge network, set `DOCKER_BUILD_NETWORK=host` for the local builds.

The docker daemon installs a bundle when a database's `postgresConfig.extensionBundles` names it (create, update,
every member of a set, a rebuilt member, a recreate on another image): it refuses up front when the volume lacks the
space, pulls the pinned digest, copies `files/` into
`<volume>/extensions/<id>/<version>-pg<major>-<debian>-<arch>/files` (on the database's own disk, outside PGDATA),
accepts exactly the manifest's entries, removes the image, and links the files into the running container with
`opfield-extensions wire`. A bundle no longer named is removed, unless an extension it provides is still created in the
database. At every container start the entrypoint links the bundles again before the server starts, so preloaded
libraries from bundles work.

## Publishing and pinning

The Image workflow (`.github/workflows/image.yml`, jobs `postgres` and `postgres-bundles`) builds every catalog
version as `<image repository>/postgres:<version>-tree-<tree hash of image/>` and every bundle as
`<image repository>/postgres-ext/<id>:<version>-pg<major>-<debian>-tree-<tree hash of bundle/>`, for amd64 and arm64,
skips tags that exist, copies them to the mirror repository, signs them like the other images and prints the digests
(and each bundle's installed size per architecture). Publishing needs the owner's approval. The pin is a following
commit: `image` of each version in `versions.json` and the entries of `bundles.json` from the printed values (a
reference under the legacy repository name needs a `config/legacy-brand-allowlist.json` entry), and the controller
catalog's default image of each version becomes `image` with `base` still accepted. Until then databases run the
official images, contrib extensions work, and baked and bundle extensions report that they need an image update or are
unavailable.

`TestPostgresCatalogAgreement` (docker daemon) and `TestCatalogAgreesWithTheBuildLists` (pgext) keep the manifests,
the daemon's image allow-list, `config/third-party-images.json` and the build lists in agreement.

## Measured sizes

Installed size the packages add to the official image (apt `Installed-Size`, PGDG for Debian trixie, amd64,
2026-10-15). Baked when at most about 10 MB.

| Extension | 14 | 15 | 16 | 17 | 18 | Delivery |
| --- | --- | --- | --- | --- | --- | --- |
| pgvector | 0.8 MB | 0.8 MB | 0.8 MB | 0.8 MB | 0.8 MB | baked |
| pg_cron | 0.2 MB | 0.2 MB | 0.2 MB | 0.2 MB | 0.2 MB | baked |
| pg_partman (extension files only; its Python helpers would add 23 MB) | 8.2 MB | 8.2 MB | 8.2 MB | 8.2 MB | 8.2 MB | baked |
| pgaudit, hypopg, pg_hint_plan, pg_repack, semver, pg_uuidv7, prefix, pg_stat_kcache, pg_qualstats, pg_squeeze, pg_show_plans | ≤ 0.3 MB each | | | | | baked |
| plpgsql_check, rum, ip4r, periods, h3 (+ libh3) | 0.5–0.8 MB each | | | | | baked |
| orafce, pgtap, age | 1.2 / 1.8 / 1.9–2.3 MB | | | | | baked |
| pgmq | no PGDG package | | | | | (skipped) |
| PostGIS (+ GDAL, GEOS, PROJ, SFCGAL, …) | 232 MB | 232 MB | 232 MB | 232 MB | 232 MB | bundle |
| pgRouting (+ Boost), on top of PostGIS | 3.4 MB package, 239 MB with PostGIS | | | | | bundle |

The built bundles (amd64, every major): `postgis` 214 MB in 1650 files, `pgrouting` 17 MB (its SQL scripts and Boost
libraries; requires `postgis`). Opfield's image against the official one: 14.23 462 / 441 MB, 15.18 466 / 445 MB,
16.14 472 / 451 MB, 17.10 475 / 454 MB, 18.4 478 / 456 MB (about +21 MB each).
