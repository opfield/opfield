import { LEGACY_UPDATES_BASE_URLS, UPDATES_BASE_URL } from '@/config/vendor-urls.js';

/** Release asset of the signed app image manifest. */
export const OPFIELD_IMAGE_MANIFEST_ASSET = 'opfield-image.update.json';

export interface ReleaseRecord {
  tag_name: string;
  description?: unknown;
  body?: unknown;
  html_url?: unknown;
  _links?: { self?: unknown };
}

export interface ReleaseArtifactSource {
  artifactUrl: string;
  manifestUrl: string;
  trustedPrefix: string;
  /**
   * The artifact's URL under every name of the update host (the configured base first). A signed manifest names the
   * host that was current when it was signed, so an older release names an earlier one.
   */
  acceptedArtifactUrls: string[];
}

export interface ReleaseFileSource {
  url: string;
  trustedPrefix: string;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function releaseArtifactUrl(
  artifactBaseUrl: string,
  packageName: string,
  tag: string,
  artifactName: string
): string {
  const base = trimTrailingSlashes(artifactBaseUrl);
  return `${base}/${encodePathSegment(packageName)}/${encodePathSegment(tag)}/${encodePathSegment(artifactName)}`;
}

export function releaseArtifactSource(
  artifactBaseUrl: string,
  packageName: string,
  tag: string,
  artifactName: string
): ReleaseArtifactSource {
  const artifact = releaseFileSource(artifactBaseUrl, packageName, tag, artifactName);
  const manifest = releaseFileSource(artifactBaseUrl, packageName, tag, `${artifactName}.update.json`);
  const bases = [artifactBaseUrl, UPDATES_BASE_URL, ...LEGACY_UPDATES_BASE_URLS].map(trimTrailingSlashes);
  return {
    artifactUrl: artifact.url,
    manifestUrl: manifest.url,
    trustedPrefix: artifact.trustedPrefix,
    acceptedArtifactUrls: [...new Set(bases)].map((base) => releaseArtifactUrl(base, packageName, tag, artifactName)),
  };
}

/** Whether a signed manifest's download URL is this artifact under one of the update host's names, over HTTPS. */
export function isAcceptedArtifactUrl(source: ReleaseArtifactSource, downloadUrl: string): boolean {
  return downloadUrl.startsWith('https://') && source.acceptedArtifactUrls.includes(downloadUrl);
}

export function releaseFileSource(
  artifactBaseUrl: string,
  packageName: string,
  tag: string,
  fileName: string
): ReleaseFileSource {
  return {
    url: releaseArtifactUrl(artifactBaseUrl, packageName, tag, fileName),
    trustedPrefix: `${trimTrailingSlashes(artifactBaseUrl)}/`,
  };
}

export function releaseNotes(release: ReleaseRecord): string {
  if (typeof release.description === 'string') return release.description;
  if (typeof release.body === 'string') return release.body;
  return '';
}

export function releaseUrl(release: ReleaseRecord): string {
  if (typeof release._links?.self === 'string') return release._links.self;
  if (typeof release.html_url === 'string') return release.html_url;
  return '';
}
