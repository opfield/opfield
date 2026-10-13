import type { WitnessArtifact } from '@/grpc/generated/types.js';
import { isAcceptedArtifactUrl, releaseArtifactSource } from '@/lib/release-artifacts.js';
import { UpdateArtifactTrustError, verifySignedPayload } from '@/lib/update-artifact-trust.js';
import type { WitnessArtifactSource } from '@/services/relay-witness.service.js';

/**
 * Witness process binaries published with every Gateway release (config/witness-artifacts.json, built and signed by
 * scripts/release/witness-artifacts.sh). Keep both lists equal; a test checks it.
 */
export const WITNESS_ARTIFACTS: readonly { kind: string; component: string; version: string; arches: string[] }[] = [
  {
    kind: 'clickhouse_keeper',
    component: 'witness-clickhouse-keeper',
    version: '25.8.28.1',
    arches: ['amd64', 'arm64'],
  },
];

const OPFIELD_RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const FOUND_TTL_MS = 60 * 60_000;
const MISSING_TTL_MS = 5 * 60_000;

interface WitnessManifestPayload {
  kind: string;
  component: string;
  version: string;
  arch: string;
  artifactName: string;
  downloadUrl: string;
  sha256: string;
}

/** The witness version this Gateway release ships for a kind, or null when it ships none. */
export function currentWitnessVersion(kind: string): string | null {
  return WITNESS_ARTIFACTS.find((entry) => entry.kind === kind)?.version ?? null;
}

function normalizeArch(arch: string): string {
  const value = arch.trim().toLowerCase();
  if (value === 'x86_64' || value === 'x64') return 'amd64';
  if (value === 'aarch64') return 'arm64';
  return value;
}

/**
 * Resolves witness artifacts of this Gateway release from the update service: the signed manifest
 * (<artifact>.update.json, kind witness-binary) is fetched, verified with the update key and checked against the
 * expected component, version, architecture and download URL. Relay supervisors verify it again before they run
 * anything. A development build (no release tag) has no witness artifacts.
 */
export class WitnessCatalog implements WitnessArtifactSource {
  private readonly cache = new Map<string, { artifact: WitnessArtifact | null; expiresAt: number }>();

  constructor(
    private readonly env: { ARTIFACT_BASE_URL: string; APP_VERSION: string },
    private readonly fetcher: typeof fetch = fetch,
    private readonly publicKey?: string | Buffer,
    private readonly now: () => number = Date.now
  ) {}

  async resolve(kind: string, version: string, rawArch: string): Promise<WitnessArtifact | null> {
    const entry = WITNESS_ARTIFACTS.find((candidate) => candidate.kind === kind && candidate.version === version);
    const arch = normalizeArch(rawArch);
    const tag = this.env.APP_VERSION;
    if (!entry?.arches.includes(arch) || !OPFIELD_RELEASE_TAG_RE.test(tag)) return null;
    const key = `${entry.component}:${version}:${arch}:${tag}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.artifact;
    const artifact = await this.fetchArtifact(entry.component, version, arch, tag);
    this.cache.set(key, { artifact, expiresAt: this.now() + (artifact ? FOUND_TTL_MS : MISSING_TTL_MS) });
    return artifact;
  }

  private async fetchArtifact(
    component: string,
    version: string,
    arch: string,
    tag: string
  ): Promise<WitnessArtifact | null> {
    const artifactName = `${component}-${version}-linux-${arch}`;
    const source = releaseArtifactSource(this.env.ARTIFACT_BASE_URL, component, tag, artifactName);
    const response = await this.fetcher(source.manifestUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const signedManifest = await response.text();
    const payload = verifySignedPayload<WitnessManifestPayload>(signedManifest, this.publicKey);
    if (payload.kind !== 'witness-binary')
      throw new UpdateArtifactTrustError('Witness manifest kind is not witness-binary');
    if (payload.component !== component || payload.version !== version || payload.arch !== arch) {
      throw new UpdateArtifactTrustError('Witness manifest does not name this artifact');
    }
    if (payload.artifactName !== artifactName || !source.acceptedArtifactUrls.includes(payload.downloadUrl)) {
      throw new UpdateArtifactTrustError('Witness download URL mismatch');
    }
    if (!isAcceptedArtifactUrl(source, payload.downloadUrl)) {
      throw new UpdateArtifactTrustError('Witness download URL is not trusted');
    }
    if (!SHA256_RE.test(payload.sha256)) throw new UpdateArtifactTrustError('Witness checksum is invalid');
    return { version, downloadUrl: payload.downloadUrl, sha256: payload.sha256, signedManifest, component };
  }
}
