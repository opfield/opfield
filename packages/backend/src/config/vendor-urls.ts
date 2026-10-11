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
 * Earlier names of the same update Worker. Installs up to 2.11 use them and they stay served forever. Manifests signed
 * before the move name their artifacts there, so an artifact URL under any of them is accepted for the same path.
 */
export const LEGACY_UPDATES_BASE_URLS: readonly string[] = ['https://updates.thesqlabs.com/gateway'];
/** Node installers of a release, GitHub release download layout: `/download/<tag>/<file>`, `/latest/download/<file>`. */
export const INSTALLER_RELEASES_URL = `${UPDATES_BASE_URL}/releases`;
