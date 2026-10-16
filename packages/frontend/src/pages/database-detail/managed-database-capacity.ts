import type { ManagedDatabaseCreateInput, Node } from "@/types";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export interface ManagedDatabaseCapacity {
  storageSizeGb?: number;
  cpuCores?: number;
  memoryMb?: number;
  swapMb?: number;
}

export function minimumManagedDatabaseMemoryMb(type: ManagedDatabaseCreateInput["type"]) {
  return type === "clickhouse" ? 512 : 128;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function wholeUnits(bytes: unknown, unit: number): number | undefined {
  const value = finiteNumber(bytes);
  return value === undefined || value < 0 ? undefined : Math.floor(value / unit);
}

function tenthsOfUnits(bytes: unknown, unit: number): number | undefined {
  const value = finiteNumber(bytes);
  return value === undefined || value < 0 ? undefined : Math.floor((value * 10) / unit) / 10;
}

function hasAtMostOneDecimalPlace(value: number): boolean {
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}

export function managedDatabaseCapacity(node: Node | undefined): ManagedDatabaseCapacity {
  const health = node?.lastHealthReport;
  const diskFreeBytes = finiteNumber(health?.diskFreeBytes);
  const mountFreeBytes = health?.diskMounts
    ?.map((mount) => finiteNumber(mount.freeBytes) ?? 0)
    .reduce((largest, freeBytes) => Math.max(largest, freeBytes), 0);
  const swapTotalBytes = finiteNumber(health?.swapTotalBytes);
  const swapUsedBytes = finiteNumber(health?.swapUsedBytes);
  const cpuCores = finiteNumber(node?.capabilities.cpuCores);

  return {
    storageSizeGb: tenthsOfUnits(diskFreeBytes ?? mountFreeBytes, GIBIBYTE),
    ...(cpuCores !== undefined && cpuCores > 0 ? { cpuCores } : {}),
    memoryMb: wholeUnits(health?.systemMemoryAvailableBytes, MEBIBYTE),
    swapMb:
      swapTotalBytes === undefined || swapUsedBytes === undefined
        ? undefined
        : wholeUnits(Math.max(0, swapTotalBytes - swapUsedBytes), MEBIBYTE),
  };
}

function withinLimit(value: number, maximum: number | undefined) {
  return maximum === undefined || value <= maximum;
}

export function canDeployManagedDatabase(
  draft: ManagedDatabaseCreateInput,
  versions: string[],
  capacity: ManagedDatabaseCapacity
) {
  return (
    draft.name.trim().length > 0 &&
    draft.nodeId.length > 0 &&
    versions.includes(draft.version) &&
    Number.isFinite(draft.storageSizeGb) &&
    hasAtMostOneDecimalPlace(draft.storageSizeGb) &&
    draft.storageSizeGb >= 0.1 &&
    withinLimit(draft.storageSizeGb, capacity.storageSizeGb) &&
    Number.isFinite(draft.cpuCores) &&
    draft.cpuCores >= 0.1 &&
    withinLimit(draft.cpuCores, capacity.cpuCores) &&
    Number.isInteger(draft.memoryMb) &&
    draft.memoryMb >= minimumManagedDatabaseMemoryMb(draft.type) &&
    withinLimit(draft.memoryMb, capacity.memoryMb) &&
    Number.isInteger(draft.swapMb) &&
    draft.swapMb >= 0 &&
    withinLimit(draft.swapMb, capacity.swapMb) &&
    (draft.publishedPort === undefined ||
      (Number.isInteger(draft.publishedPort) &&
        draft.publishedPort >= 1 &&
        draft.publishedPort <= 65_535)) &&
    (draft.publishedNativePort === undefined ||
      (draft.publishTcp &&
        draft.type === "clickhouse" &&
        draft.publishNativeTcp !== false &&
        Number.isInteger(draft.publishedNativePort) &&
        draft.publishedNativePort >= 1 &&
        draft.publishedNativePort <= 65_535))
  );
}

/** The maxmemory share of a key-value store's memory when its settings keep the default. */
const DEFAULT_KEY_VALUE_MAXMEMORY_PERCENT = 75;

/**
 * A key-value store's disk holds its append-only file, the rewrite of it and a snapshot: about three times its
 * maxmemory. Returns the warning for a smaller disk, or undefined.
 */
export function keyValueStorageWarning(
  storageSizeGb: number,
  memoryMb: number,
  maxmemoryPercent = DEFAULT_KEY_VALUE_MAXMEMORY_PERCENT
): string | undefined {
  if (!Number.isFinite(storageSizeGb) || !Number.isFinite(memoryMb) || memoryMb <= 0)
    return undefined;
  const maxmemoryMb = (memoryMb * maxmemoryPercent) / 100;
  const neededGb = Math.ceil((3 * maxmemoryMb * 10) / 1024) / 10;
  if (storageSizeGb >= neededGb) return undefined;
  return `The store may hold ${Math.round(maxmemoryMb)} MB in memory. Its append-only file, a rewrite of it and a snapshot need about ${neededGb} GB of storage; a smaller disk can fill up.`;
}
