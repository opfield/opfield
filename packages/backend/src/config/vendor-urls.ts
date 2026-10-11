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
/**
 * Release feed and artifact host (the update Worker). Installs up to 2.11.4 hard-code this host, so it stays served
 * forever. Switch to the get.opfield.dev route of the same Worker (https://get.opfield.dev/gateway) here once that
 * route is live; the paths below the base do not change.
 */
export const UPDATES_BASE_URL = 'https://updates.thesqlabs.com/gateway';
