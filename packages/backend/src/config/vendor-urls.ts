/**
 * Addresses of the vendor services and image repositories an installation trusts. From 2.12 releases are published
 * under the Opfield names as well; this release accepts both the names it was built with and the Opfield ones, so it
 * updates to a release that names either (env.ts keeps the overrides).
 */

/** Release feed and artifact host (the update Worker): `${UPDATES_BASE_URL}/releases`, `/<package>/<tag>/<file>`. */
export const UPDATES_BASE_URL = 'https://updates.thesqlabs.com/gateway';
/**
 * Other names of the same update Worker, serving the same files at the same paths. A signed manifest may name its
 * artifact under any of them, so an artifact URL under any of them is accepted for the same path.
 */
export const ALTERNATE_UPDATES_BASE_URLS: readonly string[] = ['https://get.opfield.dev/gateway'];

/** Official Gateway image repositories: the one this release is published under, and the Opfield one. */
export const OFFICIAL_IMAGE_REPOSITORIES: readonly string[] = [
  'ghcr.io/the-square-labs/gateway',
  'ghcr.io/opfield/opfield',
];
/** The same for the managed inference core image. */
export const OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES: readonly string[] = [
  'ghcr.io/the-square-labs/inference-core',
  'ghcr.io/opfield/inference-core',
];

/**
 * Addresses of the license service, in the order they are tried. Every address serves the same license service; the
 * next one is tried only when an address does not answer as the license service does (no response, a timeout, a
 * proxy error page), never after the service itself answered.
 */
export const LICENSE_SERVICE_URLS: readonly string[] = [
  'https://license.opfield.dev',
  'https://license.thesqlabs.com',
  'https://license.wiolett.cloud',
];
