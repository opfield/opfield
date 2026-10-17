import { type ReleaseRecord, releaseFileSource } from '@/lib/release-artifacts.js';
import { compareSemver, parseSemver } from '@/lib/semver.js';
import { type TrustedOpenCodexImageArtifact, verifyOpenCodexImageManifest } from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import { INFERENCE_CORE_PROTOCOL_MAJOR } from './inference-core.contract.js';
import { LEGACY_CORE_RELEASE_LINE } from '@/lib/legacy-compat.js';

/**
 * Release channel for the managed inference core (opfield-inference, built from OpenCodex). Releases are published
 * by the core's pipeline into GitHub Releases. The signed manifest is always signature-verified before any Docker
 * mutation is considered.
 */

/** Update-feed component and artifact package of the managed inference core. */
export const OPFIELD_INFERENCE_COMPONENT = 'opfield-inference';
export const OPFIELD_INFERENCE_MANIFEST_FILE = 'opfield-inference-image.update.json';
// legacy-name: inference-core component and opencodex-image.update.json — remove once every core release is listed under opfield-inference and carries the new manifest
export const LEGACY_INFERENCE_CORE_COMPONENT = 'inference-core';
export const LEGACY_INFERENCE_CORE_MANIFEST_FILE = 'opencodex-image.update.json';

/** Where a core manifest is looked up, newest name first. */
const CORE_MANIFEST_SOURCES: readonly { packageName: string; fileName: string }[] = [
  { packageName: OPFIELD_INFERENCE_COMPONENT, fileName: OPFIELD_INFERENCE_MANIFEST_FILE },
  { packageName: LEGACY_INFERENCE_CORE_COMPONENT, fileName: LEGACY_INFERENCE_CORE_MANIFEST_FILE },
];

// Release lines in the order they replaced each other: the first line up to 2.25.0, then `-thesqlabs.N`, and
// `-opfield.N` from the repository's move to the opfield organization. Installed versions of every line must
// stay valid and comparable, so all three suffixes are accepted.
export const OPENCODEX_RELEASE_LINES = [LEGACY_CORE_RELEASE_LINE, 'thesqlabs', 'opfield'] as const;
export type OpenCodexReleaseLine = (typeof OPENCODEX_RELEASE_LINES)[number];
/** A core version without the leading `v`, as signed manifests and the API carry it. */
const RELEASE_LINE_PATTERN = OPENCODEX_RELEASE_LINES.join('|');
export const OPENCODEX_VERSION_RE = new RegExp(String.raw`^\d+\.\d+\.\d+-(?:${RELEASE_LINE_PATTERN})\.\d+$`);
export const OPENCODEX_RELEASE_TAG_RE = new RegExp(String.raw`^v\d+\.\d+\.\d+-(?:${RELEASE_LINE_PATTERN})\.\d+$`);

/**
 * Fetch the newest published core tag, or null when none exist yet. The feed is asked for the opfield-inference
 * component first; a feed that does not know it yet, or lists nothing under it, is asked for the earlier
 * inference-core component, and the newer of the two answers wins.
 */
export async function fetchLatestOpenCodexTag(releasesApiUrl: string): Promise<string | null> {
  const current = await fetchLatestComponentTag(releasesApiUrl, OPFIELD_INFERENCE_COMPONENT).catch(() => null);
  let legacy: string | null;
  try {
    // legacy-name: inference-core feed component — remove once the feed lists every core release under opfield-inference
    legacy = await fetchLatestComponentTag(releasesApiUrl, LEGACY_INFERENCE_CORE_COMPONENT);
  } catch (error) {
    if (current) return current;
    throw error;
  }
  if (!current) return legacy;
  if (!legacy) return current;
  return compareOpenCodexVersions(current, legacy) >= 0 ? current : legacy;
}

async function fetchLatestComponentTag(releasesApiUrl: string, component: string): Promise<string | null> {
  const url = new URL(releasesApiUrl);
  url.searchParams.set('component', component);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new AppError(502, 'CORE_RELEASE_UNAVAILABLE', `Failed to list core releases: ${response.status}`);
  }
  const target = ((await response.json()) as { target?: ReleaseRecord }).target;
  return target && OPENCODEX_RELEASE_TAG_RE.test(target.tag_name) ? target.tag_name : null;
}

/**
 * Compare `1.2.3-opfield.4` style versions: semver first, then the release line (on the same base a later
 * line supersedes an earlier one: LEGACY_CORE_RELEASE_LINE < thesqlabs < opfield), then the build number.
 */
export function compareOpenCodexVersions(a: string, b: string): number {
  const parsedA = parseOpenCodexVersion(a);
  const parsedB = parseOpenCodexVersion(b);
  if (!parsedA || !parsedB) return 0;
  const semverOrder = compareSemver(parsedA.base, parsedB.base);
  if (semverOrder !== 0) return semverOrder;
  if (parsedA.line !== parsedB.line) {
    return OPENCODEX_RELEASE_LINES.indexOf(parsedA.line) - OPENCODEX_RELEASE_LINES.indexOf(parsedB.line);
  }
  return parsedA.build - parsedB.build;
}

export function parseOpenCodexVersion(
  version: string
): { base: string; line: OpenCodexReleaseLine; build: number } | null {
  const match = new RegExp(String.raw`^v?(\d+\.\d+\.\d+)-(${RELEASE_LINE_PATTERN})\.(\d+)$`).exec(version);
  if (!match || !parseSemver(match[1])) return null;
  return { base: match[1], line: match[2] as OpenCodexReleaseLine, build: Number(match[3]) };
}

/**
 * Download and verify the signed manifest for one tag. Throws AppError(502)
 * on transport problems and AppError(502, UNTRUSTED_UPDATE_ARTIFACT) on any
 * trust failure — the caller must treat both as "no Docker mutation happened".
 */
export async function fetchOpenCodexImageManifest(
  artifactBaseUrl: string,
  tag: string,
  expectedImages: string | readonly string[],
  publicKey?: string | Buffer
): Promise<TrustedOpenCodexImageArtifact> {
  if (!OPENCODEX_RELEASE_TAG_RE.test(tag)) {
    throw new AppError(400, 'INVALID_CORE_VERSION', `Core release tag must match vX.Y.Z-opfield.N, got "${tag}"`);
  }
  const imageRepositories = typeof expectedImages === 'string' ? [expectedImages] : expectedImages;
  let lastStatus: number | null = null;
  let fetched = false;
  // Releases from the opfield-inference rename on carry both manifests; earlier ones only the legacy file.
  for (const candidate of CORE_MANIFEST_SOURCES) {
    const source = releaseFileSource(artifactBaseUrl, candidate.packageName, tag, candidate.fileName);
    const response = await fetch(source.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) {
      lastStatus = response?.status ?? lastStatus;
      continue;
    }
    fetched = true;
    const signedManifest = await response.text();
    for (const image of imageRepositories) {
      try {
        return verifyOpenCodexImageManifest(
          signedManifest,
          {
            image,
            coreProtocolMajor: INFERENCE_CORE_PROTOCOL_MAJOR,
            version: tag.slice(1),
            tag,
          },
          publicKey
        );
      } catch {
        // Try the next explicitly trusted repository during the registry bridge.
      }
    }
  }
  if (!fetched) {
    throw new AppError(
      502,
      'CORE_RELEASE_UNAVAILABLE',
      `Failed to fetch core release manifest: ${lastStatus ?? 'unreachable'}`
    );
  }
  throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Core release artifact is not trusted');
}

/**
 * Opfield compatibility gate from the verified manifest: the installed Opfield
 * must satisfy the release's min/max bounds before an install/update proceeds.
 */
export function checkOpenCodexOpfieldCompatibility(
  artifact: TrustedOpenCodexImageArtifact,
  currentOpfieldVersion: string
): { compatible: boolean; reason: string | null } {
  // Development builds carry no trustworthy version number; never block them.
  if (currentOpfieldVersion === 'dev') return { compatible: true, reason: null };
  const current = parseSemver(currentOpfieldVersion);
  if (!current) return { compatible: true, reason: null };
  if (artifact.minOpfieldVersion && compareSemver(currentOpfieldVersion, artifact.minOpfieldVersion) < 0) {
    return {
      compatible: false,
      reason: `Core ${artifact.version} requires Opfield ${artifact.minOpfieldVersion} or newer`,
    };
  }
  if (artifact.maxOpfieldVersion && compareSemver(currentOpfieldVersion, artifact.maxOpfieldVersion) > 0) {
    return {
      compatible: false,
      reason: `Core ${artifact.version} supports Opfield up to ${artifact.maxOpfieldVersion}`,
    };
  }
  return { compatible: true, reason: null };
}
