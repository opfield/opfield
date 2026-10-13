# Stamps the Opfield image built once for a main commit (workflow Image) with a release version
# and its digest-pinned backup runner. Only metadata and one file change, so BuildKit never pulls
# the base layers and a release takes seconds. The build context holds just
# backup-runner-image.json, written by scripts/bundle-backup-runner.mjs.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION
COPY --link backup-runner-image.json ./dist/config/backup-runner-image.json
