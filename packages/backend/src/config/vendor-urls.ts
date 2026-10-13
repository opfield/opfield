/**
 * Default addresses of the vendor services every installation talks to. They live together so a rebrand moves them
 * at once; CLOUD_PORTAL_URL, RELEASES_API_URL and ARTIFACT_BASE_URL can still be overridden through the environment
 * (see env.ts).
 */
/**
 * Built-in addresses of the license service, in the order they are tried (config/license-service.json, the list CI and
 * the release scripts read, holds the same). Every address serves the same license service and stays served; the signed
 * endpoints document published with the release feed (LICENSE_ENDPOINTS_DOCUMENT) can name newer ones, and
 * LICENSE_SERVICE_URL overrides them (see license-endpoints.ts).
 */
export const LICENSE_SERVICE_URLS: readonly string[] = [
  'https://license.opfield.dev',
  'https://license.thesqlabs.com',
  'https://license.wiolett.cloud',
];
/** The signed list of license service addresses, served by the update Worker under every update host name. */
export const LICENSE_ENDPOINTS_DOCUMENT = 'license-endpoints.json';
export const DEFAULT_CLOUD_PORTAL_URL = 'https://account.opfield.dev';
/** Release feed and artifact host (the update Worker): `${UPDATES_BASE_URL}/releases`, `/<package>/<tag>/<file>`. */
export const UPDATES_BASE_URL = 'https://get.opfield.dev/gateway';
/**
 * Earlier names of the same update Worker. Installs up to 2.11.5 read the feed there by default, and they stay served
 * forever. Manifests signed before the move name their artifacts there, so an artifact URL under any of them is
 * accepted for the same path.
 */
export const LEGACY_UPDATES_BASE_URLS: readonly string[] = ['https://updates.thesqlabs.com/gateway'];
/** Node installers of a release, GitHub release download layout: `/download/<tag>/<file>`, `/latest/download/<file>`. */
export const INSTALLER_RELEASES_URL = `${UPDATES_BASE_URL}/releases`;
/**
 * Image repositories Opfield images are published under: the opfield organization, which release manifests name from
 * 2.12, and the earlier repository, which keeps receiving every release as a mirror for installs that still name it.
 * Installs from 2.11.5 accept both.
 */
export const OPFIELD_IMAGE_REPOSITORY = 'ghcr.io/opfield/opfield';
export const LEGACY_IMAGE_REPOSITORIES: readonly string[] = ['ghcr.io/the-square-labs/gateway'];
export const OFFICIAL_IMAGE_REPOSITORIES: readonly string[] = [OPFIELD_IMAGE_REPOSITORY, ...LEGACY_IMAGE_REPOSITORIES];
/**
 * The same for the managed inference core image: opfield-inference, and the repositories core releases were published
 * under before the rename, which keep receiving every release as mirrors.
 */
export const OPFIELD_INFERENCE_IMAGE_REPOSITORY = 'ghcr.io/opfield/opfield-inference';
// legacy-name: inference-core image repositories — remove once every supported core release is published to opfield-inference
export const LEGACY_INFERENCE_CORE_IMAGE_REPOSITORIES: readonly string[] = [
  'ghcr.io/opfield/inference-core',
  'ghcr.io/the-square-labs/inference-core',
];
export const OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES: readonly string[] = [
  OPFIELD_INFERENCE_IMAGE_REPOSITORY,
  ...LEGACY_INFERENCE_CORE_IMAGE_REPOSITORIES,
];
