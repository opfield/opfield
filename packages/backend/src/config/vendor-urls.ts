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
