const OFCA_MAGIC = new Uint8Array([0x47, 0x57, 0x43, 0x41, 0x0d, 0x0a, 0x1a, 0x0a]);
const MANIFEST_FRAME = 1;
const FRAME_HEADER_BYTES = 9;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MANIFEST_KEYS = new Set([
  "format",
  "version",
  "createdAt",
  "captureMode",
  "volumes",
  "container",
  "image",
]);
const CONTAINER_KEYS = new Set([
  "schemaVersion",
  "name",
  "platform",
  "imageReference",
  "entrypoint",
  "command",
  "workingDir",
  "user",
  "hostname",
  "labels",
  "environment",
  "secrets",
  "ports",
  "mounts",
  "networks",
  "restartPolicy",
  "maxRetries",
  "stopTimeout",
  "resources",
  "warnings",
]);
const NETWORK_KEYS = new Set([
  "name",
  "driver",
  "subnet",
  "gateway",
  "createable",
  "createNew",
  "requiresMapping",
]);
const MOUNT_KEYS = new Set([
  "type",
  "source",
  "target",
  "readOnly",
  "driver",
  "labels",
  "createNew",
  "requiresMapping",
]);
const PORT_KEYS = new Set(["containerPort", "hostPort", "protocol"]);

export interface OfcaNetworkMetadata {
  name: string;
  driver?: string;
  subnet?: string;
  gateway?: string;
  createable: boolean;
  createNew?: boolean;
  requiresMapping?: boolean;
}

export interface OfcaMountMetadata {
  type: "bind" | "volume";
  source: string;
  target: string;
  readOnly: boolean;
  driver?: string;
  labels?: Record<string, string>;
  createNew?: boolean;
  requiresMapping?: boolean;
}

export interface OfcaPortMetadata {
  containerPort: number;
  hostPort: number;
  protocol: "tcp" | "udp";
}

export interface OfcaImportMetadata {
  name: string;
  networks: OfcaNetworkMetadata[];
  mounts: OfcaMountMetadata[];
  ports: OfcaPortMetadata[];
  secretKeys: string[];
  warnings: string[];
}

export type OfcaPortMappingInput = number | "";

export function normalizeOfcaPortMappings(
  mappings: Record<string, OfcaPortMappingInput>
): Record<string, number> | null {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(mappings)) {
    if (value === "" || !Number.isInteger(value) || value < 0 || value > 65535) return null;
    normalized[key] = value;
  }
  return normalized;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasOnlyKeys(value: unknown, allowed: Set<string>): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read container archive"));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

export function ofcaPortKey(port: OfcaPortMetadata): string {
  return `${port.containerPort}/${port.protocol}:${port.hostPort}`;
}

export async function readOfcaImportMetadata(file: File): Promise<OfcaImportMetadata> {
  const prefixLength = OFCA_MAGIC.length + FRAME_HEADER_BYTES;
  if (file.size < prefixLength) throw new Error("Container archive is truncated");

  const prefix = new Uint8Array(await readBlobBytes(file.slice(0, prefixLength)));
  if (!bytesEqual(prefix.subarray(0, OFCA_MAGIC.length), OFCA_MAGIC)) {
    throw new Error("File is not an Opfield container archive");
  }
  if (prefix[OFCA_MAGIC.length] !== MANIFEST_FRAME) {
    throw new Error("Container archive manifest is missing");
  }

  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const manifestLength = Number(view.getBigUint64(OFCA_MAGIC.length + 1));
  if (
    !Number.isSafeInteger(manifestLength) ||
    manifestLength <= 0 ||
    manifestLength > MAX_MANIFEST_BYTES
  ) {
    throw new Error("Container archive manifest is invalid");
  }
  if (file.size < prefixLength + manifestLength) throw new Error("Container archive is truncated");

  let manifest: unknown;
  try {
    const bytes = await readBlobBytes(file.slice(prefixLength, prefixLength + manifestLength));
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Container archive manifest is invalid");
  }
  const parsed = manifest as {
    format?: string;
    version?: number;
    container?: {
      schemaVersion?: number;
      name?: string;
      networks?: OfcaNetworkMetadata[];
      mounts?: OfcaMountMetadata[];
      ports?: OfcaPortMetadata[];
      secrets?: Record<string, string>;
      warnings?: string[];
    };
  };
  if (
    !hasOnlyKeys(parsed, MANIFEST_KEYS) ||
    !hasOnlyKeys(parsed.container, CONTAINER_KEYS) ||
    parsed.format !== "ofca" ||
    parsed.version !== 1 ||
    parsed.container?.schemaVersion !== 1 ||
    !parsed.container.name
  ) {
    throw new Error("Unsupported Opfield container archive");
  }
  const networks = Array.isArray(parsed.container.networks) ? parsed.container.networks : [];
  const mounts = Array.isArray(parsed.container.mounts) ? parsed.container.mounts : [];
  const ports = Array.isArray(parsed.container.ports) ? parsed.container.ports : [];
  if (
    networks.some((entry) => !entry?.name) ||
    networks.some((entry) => !hasOnlyKeys(entry, NETWORK_KEYS)) ||
    mounts.some(
      (entry) =>
        !entry?.source || !entry?.target || (entry.type !== "bind" && entry.type !== "volume")
    ) ||
    mounts.some((entry) => !hasOnlyKeys(entry, MOUNT_KEYS)) ||
    ports.some(
      (entry) =>
        !Number.isInteger(entry?.containerPort) ||
        !Number.isInteger(entry?.hostPort) ||
        (entry.protocol !== "tcp" && entry.protocol !== "udp")
    ) ||
    ports.some((entry) => !hasOnlyKeys(entry, PORT_KEYS))
  ) {
    throw new Error("Container archive manifest is invalid");
  }
  if (mounts.some((entry) => entry.type === "bind")) {
    throw new Error("Container archives with host bind mounts cannot be imported");
  }
  return {
    name: parsed.container.name,
    networks,
    mounts,
    ports,
    secretKeys: Object.keys(parsed.container.secrets ?? {}).sort(),
    warnings: Array.isArray(parsed.container.warnings) ? parsed.container.warnings.map(String) : [],
  };
}
