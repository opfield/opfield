import { ALTERNATE_UPDATES_BASE_URLS, UPDATES_BASE_URL } from '@/config/vendor-urls.js';

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
   * The artifact's URL under every name of the update host (the configured base first). A signed manifest may name
   * the artifact under any of them; they serve the same files.
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
  const bases = [artifactBaseUrl, UPDATES_BASE_URL, ...ALTERNATE_UPDATES_BASE_URLS].map(trimTrailingSlashes);
  return {
    artifactUrl: artifact.url,
    manifestUrl: manifest.url,
    trustedPrefix: artifact.trustedPrefix,
    acceptedArtifactUrls: [...new Set(bases)].map((base) => releaseArtifactUrl(base, packageName, tag, artifactName)),
  };
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
