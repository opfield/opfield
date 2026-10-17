import { LEGACY_STORAGE_KEY_PREFIX } from "../../../backend/src/lib/legacy-compat";
export const OPFIELD_UPDATE_RELOAD_STORAGE_KEY = "opfield-update-reload";
export const OPFIELD_UPDATE_RELOAD_HANDLED_KEY = "opfield-update-reload-handled";

const OPFIELD_UPDATE_RELOAD_CHANNEL = "opfield-update-reload";
// legacy-name: update reload keys and channel the 2.12.0 bundle in open tabs uses — remove once 2.12.0 is no longer an update source
const LEGACY_UPDATE_RELOAD_STORAGE_KEY = `${LEGACY_STORAGE_KEY_PREFIX}-update-reload`;
const LEGACY_UPDATE_RELOAD_HANDLED_KEY = `${LEGACY_STORAGE_KEY_PREFIX}-update-reload-handled`;
const LEGACY_UPDATE_RELOAD_CHANNEL = `${LEGACY_STORAGE_KEY_PREFIX}-update-reload`;
const OPFIELD_UPDATE_RELOAD_MAX_AGE_MS = 120_000;
let opfieldReloadNavigationStarted = false;

export interface OpfieldUpdateReloadMessage {
  id: string;
  at: number;
  version: string | null;
  reason: string;
}

export function normalizeOpfieldUpdateVersion(version: string | null | undefined): string {
  return (version ?? "").trim().replace(/^v/i, "");
}

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

/** True when `currentVersion` is a later release than `targetVersion` (a stable release is later than its RCs). */
export function isOpfieldVersionNewer(
  currentVersion: string | null | undefined,
  targetVersion: string
): boolean {
  const current = RELEASE_VERSION.exec(normalizeOpfieldUpdateVersion(currentVersion));
  const target = RELEASE_VERSION.exec(normalizeOpfieldUpdateVersion(targetVersion));
  if (!current || !target) return false;
  for (let part = 1; part <= 3; part++) {
    const diff = Number(current[part]) - Number(target[part]);
    if (diff !== 0) return diff > 0;
  }
  const currentRc = current[4] === undefined ? Number.POSITIVE_INFINITY : Number(current[4]);
  const targetRc = target[4] === undefined ? Number.POSITIVE_INFINITY : Number(target[4]);
  return currentRc > targetRc;
}

export function isOpfieldUpdateTargetVersion(
  currentVersion: string | null | undefined,
  targetVersion: string
): boolean {
  return (
    normalizeOpfieldUpdateVersion(currentVersion) === normalizeOpfieldUpdateVersion(targetVersion)
  );
}

export function buildOpfieldReloadUrl(currentHref: string, nonce: number | string): string {
  const url = new URL(currentHref);
  url.searchParams.set("_v", String(nonce));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function stripOpfieldReloadParam(currentHref: string): string | null {
  const url = new URL(currentHref);
  if (!url.searchParams.has("_v")) return null;
  url.searchParams.delete("_v");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function getOpfieldReloadToken(currentHref: string): string | null {
  return new URL(currentHref).searchParams.get("_v");
}

function getHandledOpfieldReloadIds(): Array<string | null> {
  try {
    return [
      window.sessionStorage.getItem(OPFIELD_UPDATE_RELOAD_HANDLED_KEY),
      window.sessionStorage.getItem(LEGACY_UPDATE_RELOAD_HANDLED_KEY),
    ];
  } catch {
    return [null];
  }
}

function markOpfieldReloadHandled(id: string) {
  try {
    window.sessionStorage.setItem(OPFIELD_UPDATE_RELOAD_HANDLED_KEY, id);
  } catch {
    // Session storage can be unavailable; the URL token still busts cached assets.
  }
}

export function rememberOpfieldReloadToken(currentHref: string) {
  const token = getOpfieldReloadToken(currentHref);
  if (token) markOpfieldReloadHandled(token);
}

export function isOpfieldReloadMessageActionable(
  message: OpfieldUpdateReloadMessage,
  handledId: string | null,
  now: number = Date.now()
): boolean {
  const age = now - message.at;
  return message.id !== handledId && age >= 0 && age <= OPFIELD_UPDATE_RELOAD_MAX_AGE_MS;
}

export function reloadOpfieldClient(nonce: number | string = Date.now()) {
  // Multiple tabs can observe the same version change and broadcast distinct
  // reload messages before the first navigation commits. Accept exactly one
  // navigation per document lifecycle so those messages cannot create a
  // reload storm.
  if (opfieldReloadNavigationStarted) return false;
  opfieldReloadNavigationStarted = true;
  markOpfieldReloadHandled(String(nonce));
  window.location.href = buildOpfieldReloadUrl(window.location.href, nonce);
  return true;
}

export function resetOpfieldReloadNavigationGuardForTest() {
  opfieldReloadNavigationStarted = false;
}

export function publishOpfieldReload(
  version: string | null,
  reason: string
): OpfieldUpdateReloadMessage {
  const message: OpfieldUpdateReloadMessage = {
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    at: Date.now(),
    version,
    reason,
  };

  try {
    window.localStorage.setItem(OPFIELD_UPDATE_RELOAD_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Storage can be unavailable in private contexts; BroadcastChannel still covers normal tabs.
  }

  try {
    const channel = new BroadcastChannel(OPFIELD_UPDATE_RELOAD_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    // Older browsers still get the localStorage event path.
  }

  return message;
}

export function subscribeOpfieldReload(handler: (message: OpfieldUpdateReloadMessage) => void) {
  const seen = new Set<string>();

  const emit = (message: OpfieldUpdateReloadMessage) => {
    if (
      !message.id ||
      seen.has(message.id) ||
      !getHandledOpfieldReloadIds().every((handledId) =>
        isOpfieldReloadMessageActionable(message, handledId)
      )
    ) {
      return;
    }
    seen.add(message.id);
    handler(message);
  };

  const parse = (raw: unknown): OpfieldUpdateReloadMessage | null => {
    try {
      const value = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!value || typeof value !== "object") return null;
      const message = value as Partial<OpfieldUpdateReloadMessage>;
      if (typeof message.id !== "string" || typeof message.at !== "number") return null;
      return {
        id: message.id,
        at: message.at,
        version: typeof message.version === "string" ? message.version : null,
        reason: typeof message.reason === "string" ? message.reason : "opfield-update",
      };
    } catch {
      return null;
    }
  };

  const onStorage = (event: StorageEvent) => {
    if (
      (event.key !== OPFIELD_UPDATE_RELOAD_STORAGE_KEY &&
        event.key !== LEGACY_UPDATE_RELOAD_STORAGE_KEY) ||
      event.newValue == null
    ) {
      return;
    }
    const message = parse(event.newValue);
    if (message) emit(message);
  };

  window.addEventListener("storage", onStorage);

  const channels: BroadcastChannel[] = [];
  for (const name of [OPFIELD_UPDATE_RELOAD_CHANNEL, LEGACY_UPDATE_RELOAD_CHANNEL]) {
    try {
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event) => {
        const message = parse(event.data);
        if (message) emit(message);
      };
      channels.push(channel);
    } catch {
      // Older browsers still get the localStorage event path.
    }
  }

  return () => {
    window.removeEventListener("storage", onStorage);
    for (const channel of channels) {
      channel.onmessage = null;
      channel.close();
    }
  };
}
