/**
 * Default addresses of the vendor services every installation talks to. They live together so a rebrand moves them
 * at once; CLOUD_PORTAL_URL, RELEASES_API_URL and ARTIFACT_BASE_URL can still be overridden through the environment
 * (see env.ts).
 */
export const LICENSE_SERVER_URL = 'https://license.opfield.dev';
/**
 * Earlier names of the same license server. They stay served forever; requests fall back to them only when the
 * primary address cannot be reached at all (DNS, egress allowlists written for older releases).
 */
export const LEGACY_LICENSE_SERVER_URLS: readonly string[] = ['https://license.thesqlabs.com'];
export const DEFAULT_CLOUD_PORTAL_URL = 'https://account.opfield.dev';
/** Release feed and artifact host (the update Worker): `${UPDATES_BASE_URL}/releases`, `/<package>/<tag>/<file>`. */
export const UPDATES_BASE_URL = 'https://get.opfield.dev/gateway';
/**
 * Earlier names of the same update Worker. Installs up to 2.11 use them and they stay served forever. Manifests signed
 * before the move name their artifacts there, so an artifact URL under any of them is accepted for the same path.
 */
export const LEGACY_UPDATES_BASE_URLS: readonly string[] = ['https://updates.thesqlabs.com/gateway'];
/** Node installers of a release, GitHub release download layout: `/download/<tag>/<file>`, `/latest/download/<file>`. */
export const INSTALLER_RELEASES_URL = `${UPDATES_BASE_URL}/releases`;
/**
 * Image repositories Opfield images are published under: the opfield organization, and the earlier repository that
 * every release keeps receiving for installs up to 2.11. Releases of 2.12 sign their manifests for the earlier
 * repository (installs up to 2.11 accept only it); every 2.12 install accepts both, so a later release can sign for
 * the opfield one.
 */
export const OPFIELD_IMAGE_REPOSITORY = 'ghcr.io/opfield/opfield';
export const LEGACY_IMAGE_REPOSITORIES: readonly string[] = ['ghcr.io/the-square-labs/gateway'];
export const OFFICIAL_IMAGE_REPOSITORIES: readonly string[] = [OPFIELD_IMAGE_REPOSITORY, ...LEGACY_IMAGE_REPOSITORIES];
/** The same for the managed inference core image. */
export const OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES: readonly string[] = [
  'ghcr.io/opfield/inference-core',
  'ghcr.io/the-square-labs/inference-core',
];
