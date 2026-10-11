import { type ReleaseRecord, releaseFileSource } from '@/lib/release-artifacts.js';
import { compareSemver, parseSemver } from '@/lib/semver.js';
import { type TrustedOpenCodexImageArtifact, verifyOpenCodexImageManifest } from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import { INFERENCE_CORE_PROTOCOL_MAJOR } from './inference-core.contract.js';

/**
 * Release channel for the managed OpenCodex core. Releases are published by the
 * OpenCodex pipeline into GitHub Releases. The signed manifest is always
 * signature-verified before any Docker mutation is considered.
 */

// Release lines in the order they replaced each other: `-wiolett.N` up to 2.25.0, then `-thesqlabs.N`, then
// `-opfield.N` (published from ghcr.io/opfield/inference-core). Installed versions of every line must stay valid and
// comparable, so all three suffixes are accepted.
export const OPENCODEX_RELEASE_LINES = ['wiolett', 'thesqlabs', 'opfield'] as const;
export type OpenCodexReleaseLine = (typeof OPENCODEX_RELEASE_LINES)[number];
/** A core version without the leading `v`, as signed manifests and the API carry it. */
export const OPENCODEX_VERSION_RE = /^\d+\.\d+\.\d+-(?:wiolett|thesqlabs|opfield)\.\d+$/;
export const OPENCODEX_RELEASE_TAG_RE = /^v\d+\.\d+\.\d+-(?:wiolett|thesqlabs|opfield)\.\d+$/;

/** Fetch the newest published OpenCodex core tag, or null when none exist yet. */
export async function fetchLatestOpenCodexTag(releasesApiUrl: string): Promise<string | null> {
  const url = new URL(releasesApiUrl);
  url.searchParams.set('component', 'inference-core');
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
 * Compare `1.2.3-thesqlabs.4` style versions: semver first, then the release line (on the same base a later line
 * supersedes an earlier one: wiolett < thesqlabs < opfield), then the build number.
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
  const match = /^v?(\d+\.\d+\.\d+)-(wiolett|thesqlabs|opfield)\.(\d+)$/.exec(version);
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
    throw new AppError(
      400,
      'INVALID_CORE_VERSION',
      `Core release tag must match vX.Y.Z-thesqlabs.N or vX.Y.Z-opfield.N, got "${tag}"`
    );
  }
  const source = releaseFileSource(artifactBaseUrl, 'inference-core', tag, 'opencodex-image.update.json');
  const response = await fetch(source.url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new AppError(502, 'CORE_RELEASE_UNAVAILABLE', `Failed to fetch core release manifest: ${response.status}`);
  }
  const signedManifest = await response.text();
  const imageRepositories = typeof expectedImages === 'string' ? [expectedImages] : expectedImages;
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
  throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Core release artifact is not trusted');
}

/**
 * Gateway compatibility gate from the verified manifest: the installed Gateway
 * must satisfy the release's min/max bounds before an install/update proceeds.
 */
export function checkOpenCodexGatewayCompatibility(
  artifact: TrustedOpenCodexImageArtifact,
  currentGatewayVersion: string
): { compatible: boolean; reason: string | null } {
  // Development builds carry no trustworthy version number; never block them.
  if (currentGatewayVersion === 'dev') return { compatible: true, reason: null };
  const current = parseSemver(currentGatewayVersion);
  if (!current) return { compatible: true, reason: null };
  if (artifact.minGatewayVersion && compareSemver(currentGatewayVersion, artifact.minGatewayVersion) < 0) {
    return {
      compatible: false,
      reason: `Core ${artifact.version} requires Gateway ${artifact.minGatewayVersion} or newer`,
    };
  }
  if (artifact.maxGatewayVersion && compareSemver(currentGatewayVersion, artifact.maxGatewayVersion) > 0) {
    return {
      compatible: false,
      reason: `Core ${artifact.version} supports Gateway up to ${artifact.maxGatewayVersion}`,
    };
  }
  return { compatible: true, reason: null };
}
