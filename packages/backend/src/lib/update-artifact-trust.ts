import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPDATE_SIGNING_KEY_ID = 'wiolett-update-v1';

export const UPDATE_SIGNING_PUBLIC_KEY_PEM = loadSigningPublicKey('update-signing-public-key.pem');
export const OPENCODEX_SIGNING_PUBLIC_KEY_PEM = loadSigningPublicKey('opencodex-signing-public-key.pem');

const UPDATE_SCHEMA_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const GATEWAY_COMPONENT_VERSION_RE = /^v?\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

export class UpdateArtifactTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateArtifactTrustError';
  }
}

interface SignedUpdateEnvelope {
  schemaVersion: number;
  keyId: string;
  payload: string;
  signature: string;
}

export interface DaemonUpdateManifestPayload {
  kind: 'daemon-binary';
  version: string;
  tag: string;
  daemonType: 'nginx' | 'docker' | 'monitoring' | 'relay' | 'relay-worker';
  arch: string;
  artifactName: string;
  downloadUrl: string;
  sha256: string;
  createdAt: string;
  gitCommitSha?: string;
  gitPipelineId?: string;
}

export interface GatewayImageManifestPayload {
  kind: 'gateway-image';
  version: string;
  tag: string;
  image: string;
  digest: string;
  imageRef: string;
  databaseConnectorImage?: string;
  secureLinkConnectorImage?: string;
  createdAt: string;
  gitCommitSha?: string;
  gitPipelineId?: string;
}

export interface RelayImageManifestPayload {
  kind: 'relay-image';
  version: string;
  tag: string;
  image: string;
  digest: string;
  imageRef: string;
  protocolMajor: number;
  minGatewayVersion?: string;
  /** Legacy field accepted only so existing Relay manifests remain readable. */
  databaseConnectorImage?: string;
  secureLinkConnectorImage: string;
  createdAt: string;
  gitCommitSha?: string;
  gitPipelineId?: string;
}

export interface OpenCodexImageManifestPayload {
  kind: 'opencodex-image';
  version: string;
  tag: string;
  image: string;
  digest: string;
  imageRef: string;
  sizeBytes: number;
  coreProtocolMajor: number;
  stateSchemaVersion: number;
  minGatewayVersion?: string;
  maxGatewayVersion?: string;
  releaseNotesUrl?: string;
  buildRevision: string;
  createdAt: string;
  gitCommitSha?: string;
  gitPipelineId?: string;
}

export interface TrustedDaemonUpdateArtifact {
  payload: DaemonUpdateManifestPayload;
  signedManifest: string;
  downloadUrl: string;
  checksum: string;
}

export interface TrustedGatewayUpdateArtifact {
  payload: GatewayImageManifestPayload;
  signedManifest: string;
  imageRef: string;
  digest: string;
  secureLinkConnectorImage?: string;
}

export interface TrustedRelayUpdateArtifact {
  payload: RelayImageManifestPayload;
  signedManifest: string;
  imageRef: string;
  digest: string;
  buildVersion: string;
  protocolMajor: number;
  minGatewayVersion: string;
  secureLinkConnectorImage: string;
}

export interface TrustedOpenCodexImageArtifact {
  payload: OpenCodexImageManifestPayload;
  signedManifest: string;
  imageRef: string;
  digest: string;
  version: string;
  sizeBytes: number;
  coreProtocolMajor: number;
  stateSchemaVersion: number;
  minGatewayVersion?: string;
  maxGatewayVersion?: string;
  releaseNotesUrl?: string;
}

export interface DaemonUpdateManifestExpectation {
  daemonType: DaemonUpdateManifestPayload['daemonType'];
  version: string;
  tag: string;
  arch: string;
  artifactName: string;
  downloadUrl: string;
  trustedPackagePrefix: string;
  /** The same artifact under the update host's other names (manifests signed before a host move name those). */
  acceptedDownloadUrls?: readonly string[];
}

export interface GatewayImageManifestExpectation {
  version: string;
  tag: string;
  image: string;
}

export interface RelayImageManifestExpectation {
  version: string;
  tag: string;
  image: string;
  protocolMajor: number;
}

export interface OpenCodexImageManifestExpectation {
  image: string;
  coreProtocolMajor: number;
  version?: string;
  tag?: string;
}

export function verifyDaemonUpdateManifest(
  signedManifest: string,
  expected: DaemonUpdateManifestExpectation,
  publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM
): TrustedDaemonUpdateArtifact {
  const payload = verifySignedPayload<DaemonUpdateManifestPayload>(signedManifest, publicKey);
  if (payload.kind !== 'daemon-binary') throw new UpdateArtifactTrustError('Update manifest kind is not daemon-binary');
  if (payload.daemonType !== expected.daemonType) throw new UpdateArtifactTrustError('Update daemon type mismatch');
  if (payload.version !== expected.version) throw new UpdateArtifactTrustError('Update version mismatch');
  if (payload.tag !== expected.tag) throw new UpdateArtifactTrustError('Update tag mismatch');
  if (payload.arch !== expected.arch) throw new UpdateArtifactTrustError('Update architecture mismatch');
  if (payload.artifactName !== expected.artifactName)
    throw new UpdateArtifactTrustError('Update artifact name mismatch');
  if (payload.downloadUrl === expected.downloadUrl) {
    if (!isTrustedHttpsUrl(payload.downloadUrl, expected.trustedPackagePrefix)) {
      throw new UpdateArtifactTrustError('Update download URL is not trusted');
    }
  } else if (!expected.acceptedDownloadUrls?.includes(payload.downloadUrl)) {
    throw new UpdateArtifactTrustError('Update download URL mismatch');
  } else if (!payload.downloadUrl.startsWith('https://')) {
    throw new UpdateArtifactTrustError('Update download URL is not trusted');
  }
  if (!SHA256_RE.test(payload.sha256)) throw new UpdateArtifactTrustError('Update checksum is invalid');

  return {
    payload,
    signedManifest,
    downloadUrl: payload.downloadUrl,
    checksum: payload.sha256,
  };
}

export function verifyGatewayImageManifest(
  signedManifest: string,
  expected: GatewayImageManifestExpectation,
  publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM
): TrustedGatewayUpdateArtifact {
  const payload = verifySignedPayload<GatewayImageManifestPayload>(signedManifest, publicKey);
  if (payload.kind !== 'gateway-image') throw new UpdateArtifactTrustError('Update manifest kind is not gateway-image');
  if (payload.version !== expected.version) throw new UpdateArtifactTrustError('Opfield update version mismatch');
  if (payload.tag !== expected.tag) throw new UpdateArtifactTrustError('Opfield update tag mismatch');
  if (payload.image !== expected.image) throw new UpdateArtifactTrustError('Opfield update image mismatch');
  if (!DIGEST_RE.test(payload.digest)) throw new UpdateArtifactTrustError('Opfield update digest is invalid');
  if (payload.imageRef !== `${payload.image}@${payload.digest}`) {
    throw new UpdateArtifactTrustError('Opfield update image reference is not digest pinned');
  }
  if (
    payload.databaseConnectorImage !== undefined &&
    (typeof payload.databaseConnectorImage !== 'string' ||
      !isDigestPinnedImageRef(payload.databaseConnectorImage, `${payload.image}/database-connector`))
  ) {
    throw new UpdateArtifactTrustError('Opfield update database connector image reference is not digest pinned');
  }
  if (
    payload.secureLinkConnectorImage !== undefined &&
    (typeof payload.secureLinkConnectorImage !== 'string' ||
      !isDigestPinnedImageRef(payload.secureLinkConnectorImage, `${payload.image}/secure-link-connector`))
  ) {
    throw new UpdateArtifactTrustError('Opfield update secure-link connector image reference is not digest pinned');
  }

  return {
    payload,
    signedManifest,
    imageRef: payload.imageRef,
    digest: payload.digest,
    ...(payload.secureLinkConnectorImage ? { secureLinkConnectorImage: payload.secureLinkConnectorImage } : {}),
  };
}

export function verifyRelayImageManifest(
  signedManifest: string,
  expected: RelayImageManifestExpectation,
  publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM
): TrustedRelayUpdateArtifact {
  const payload = verifySignedPayload<RelayImageManifestPayload>(signedManifest, publicKey);
  if (payload.kind !== 'relay-image') throw new UpdateArtifactTrustError('Update manifest kind is not relay-image');
  if (payload.version !== expected.version) throw new UpdateArtifactTrustError('Relay update version mismatch');
  if (payload.tag !== expected.tag) throw new UpdateArtifactTrustError('Relay update tag mismatch');
  if (payload.image !== expected.image) throw new UpdateArtifactTrustError('Relay update image mismatch');
  if (!DIGEST_RE.test(payload.digest)) throw new UpdateArtifactTrustError('Relay update digest is invalid');
  if (payload.imageRef !== `${payload.image}@${payload.digest}`) {
    throw new UpdateArtifactTrustError('Relay update image reference is not digest pinned');
  }
  if (!GATEWAY_COMPONENT_VERSION_RE.test(payload.version)) {
    throw new UpdateArtifactTrustError('Relay update build version is invalid');
  }
  if (!Number.isInteger(payload.protocolMajor) || payload.protocolMajor !== expected.protocolMajor) {
    throw new UpdateArtifactTrustError('Relay update protocol major is incompatible');
  }
  if (payload.minGatewayVersion !== undefined && !GATEWAY_COMPONENT_VERSION_RE.test(payload.minGatewayVersion)) {
    throw new UpdateArtifactTrustError('Relay update minimum Opfield version is invalid');
  }
  const gatewayRepository = payload.image.endsWith('/relay') ? payload.image.slice(0, -'/relay'.length) : '';
  if (
    payload.databaseConnectorImage !== undefined &&
    (typeof payload.databaseConnectorImage !== 'string' ||
      !gatewayRepository ||
      !isDigestPinnedImageRef(payload.databaseConnectorImage, `${gatewayRepository}/database-connector`))
  ) {
    throw new UpdateArtifactTrustError('Relay update database connector image reference is not digest pinned');
  }
  if (
    typeof payload.secureLinkConnectorImage !== 'string' ||
    !gatewayRepository ||
    !isDigestPinnedImageRef(payload.secureLinkConnectorImage, `${gatewayRepository}/secure-link-connector`)
  ) {
    throw new UpdateArtifactTrustError('Relay update secure-link connector image reference is not digest pinned');
  }

  return {
    payload,
    signedManifest,
    imageRef: payload.imageRef,
    digest: payload.digest,
    buildVersion: payload.version,
    protocolMajor: payload.protocolMajor,
    minGatewayVersion: payload.minGatewayVersion ?? payload.version,
    secureLinkConnectorImage: payload.secureLinkConnectorImage,
  };
}

export function verifyOpenCodexImageManifest(
  signedManifest: string,
  expected: OpenCodexImageManifestExpectation,
  publicKey: string | Buffer = OPENCODEX_SIGNING_PUBLIC_KEY_PEM
): TrustedOpenCodexImageArtifact {
  const payload = verifySignedPayload<OpenCodexImageManifestPayload>(signedManifest, publicKey);
  if (payload.kind !== 'opencodex-image')
    throw new UpdateArtifactTrustError('Update manifest kind is not opencodex-image');
  if (expected.version !== undefined && payload.version !== expected.version) {
    throw new UpdateArtifactTrustError('OpenCodex update version mismatch');
  }
  if (expected.tag !== undefined && payload.tag !== expected.tag) {
    throw new UpdateArtifactTrustError('OpenCodex update tag mismatch');
  }
  if (payload.image !== expected.image) throw new UpdateArtifactTrustError('OpenCodex update image mismatch');
  if (!/^\d+\.\d+\.\d+-(?:wiolett|thesqlabs|opfield)\.\d+$/.test(payload.version)) {
    throw new UpdateArtifactTrustError('OpenCodex update version is not an Opfield release');
  }
  if (!DIGEST_RE.test(payload.digest)) throw new UpdateArtifactTrustError('OpenCodex update digest is invalid');
  if (payload.imageRef !== `${payload.image}@${payload.digest}`) {
    throw new UpdateArtifactTrustError('OpenCodex update image reference is not digest pinned');
  }
  if (!Number.isInteger(payload.sizeBytes) || payload.sizeBytes <= 0) {
    throw new UpdateArtifactTrustError('OpenCodex update size is invalid');
  }
  if (!Number.isInteger(payload.coreProtocolMajor) || payload.coreProtocolMajor !== expected.coreProtocolMajor) {
    throw new UpdateArtifactTrustError('OpenCodex core protocol major is incompatible');
  }
  if (!Number.isInteger(payload.stateSchemaVersion) || payload.stateSchemaVersion <= 0) {
    throw new UpdateArtifactTrustError('OpenCodex state schema version is invalid');
  }
  if (payload.minGatewayVersion !== undefined && !/^v?\d+\.\d+\.\d+$/.test(payload.minGatewayVersion)) {
    throw new UpdateArtifactTrustError('OpenCodex minimum Opfield version is invalid');
  }
  if (payload.maxGatewayVersion !== undefined && !/^v?\d+\.\d+\.\d+$/.test(payload.maxGatewayVersion)) {
    throw new UpdateArtifactTrustError('OpenCodex maximum Opfield version is invalid');
  }
  if (
    payload.releaseNotesUrl !== undefined &&
    (typeof payload.releaseNotesUrl !== 'string' || !payload.releaseNotesUrl.startsWith('https://'))
  ) {
    throw new UpdateArtifactTrustError('OpenCodex release notes URL is not trusted');
  }
  if (typeof payload.buildRevision !== 'string' || payload.buildRevision.length === 0) {
    throw new UpdateArtifactTrustError('OpenCodex build revision is missing');
  }

  return {
    payload,
    signedManifest,
    imageRef: payload.imageRef,
    digest: payload.digest,
    version: payload.version,
    sizeBytes: payload.sizeBytes,
    coreProtocolMajor: payload.coreProtocolMajor,
    stateSchemaVersion: payload.stateSchemaVersion,
    ...(payload.minGatewayVersion ? { minGatewayVersion: payload.minGatewayVersion } : {}),
    ...(payload.maxGatewayVersion ? { maxGatewayVersion: payload.maxGatewayVersion } : {}),
    ...(payload.releaseNotesUrl ? { releaseNotesUrl: payload.releaseNotesUrl } : {}),
  };
}

export function isDigestPinnedImageRef(imageRef: string, repository: string): boolean {
  const digest = imageRef.startsWith(`${repository}@`) ? imageRef.slice(repository.length + 1) : '';
  return DIGEST_RE.test(digest);
}
export function trustedGitLabPackagePrefix(gitlabApiUrl: string, projectPath: string): string {
  const base = normalizeGitLabApiUrl(gitlabApiUrl);
  const encodedPath = encodeURIComponent(projectPath);
  return `${base}/api/v4/projects/${encodedPath}/packages/generic/`;
}

export function normalizeGitLabApiUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function verifySignedPayload<T>(
  signedManifest: string,
  publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM
): T {
  let envelope: SignedUpdateEnvelope;
  try {
    envelope = JSON.parse(signedManifest) as SignedUpdateEnvelope;
  } catch {
    throw new UpdateArtifactTrustError('Update manifest is not valid JSON');
  }

  if (envelope.schemaVersion !== UPDATE_SCHEMA_VERSION) {
    throw new UpdateArtifactTrustError('Update manifest schema version is unsupported');
  }
  if (envelope.keyId !== UPDATE_SIGNING_KEY_ID) throw new UpdateArtifactTrustError('Update manifest key ID is unknown');
  if (typeof envelope.payload !== 'string' || envelope.payload.length === 0) {
    throw new UpdateArtifactTrustError('Update manifest payload is missing');
  }
  if (typeof envelope.signature !== 'string' || envelope.signature.length === 0) {
    throw new UpdateArtifactTrustError('Update manifest signature is missing');
  }

  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(envelope.payload, 'base64url');
    signature = Buffer.from(envelope.signature, 'base64url');
  } catch {
    throw new UpdateArtifactTrustError('Update manifest contains invalid base64url data');
  }

  if (!verify(null, payloadBytes, publicKey, signature)) {
    throw new UpdateArtifactTrustError('Update manifest signature is invalid');
  }

  try {
    return JSON.parse(payloadBytes.toString('utf8')) as T;
  } catch {
    throw new UpdateArtifactTrustError('Update manifest payload is not valid JSON');
  }
}

function isTrustedHttpsUrl(value: string, trustedPrefix: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && value.startsWith(trustedPrefix);
  } catch {
    return false;
  }
}

function loadSigningPublicKey(fileName: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // Docker copies canonical update trust anchors next to this module.
  const candidates = [
    join(moduleDir, fileName),
    join(moduleDir, '../../../../config/update-trust', fileName),
    join(process.cwd(), 'config/update-trust', fileName),
    join(process.cwd(), '../../config/update-trust', fileName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }

  throw new Error(`Could not locate signing public key ${fileName}. Tried: ${candidates.join(', ')}`);
}
