import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClientUuid } from "@/lib/client-id";
import { useAuthStore } from "@/stores/auth";
import type { AIComposerAttachment, AIComposerLocalImageAttachment } from "@/types/ai";

const DRAFT_PREFIX = "opfield-ai-composer-draft";
const NEW_CONVERSATION_KEY = "new";

function storageKey(userId: string | undefined, conversationId: string | null) {
  return `${DRAFT_PREFIX}:${userId ?? "anonymous"}:${conversationId ?? NEW_CONVERSATION_KEY}`;
}

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value.length > 0) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable in private or embedded contexts.
  }
}

export function useAIComposerDraft(
  conversationId: string | null
): [string, (value: string) => void] {
  const userId = useAuthStore((state) => state.user?.id);
  const key = useMemo(() => storageKey(userId, conversationId), [conversationId, userId]);
  const [value, setValue] = useState(() => readDraft(key));
  const keyRef = useRef(key);
  const valueRef = useRef(value);
  const conversationIdRef = useRef(conversationId);

  const setDraftValue = useCallback((nextValue: string) => {
    valueRef.current = nextValue;
    setValue(nextValue);
    writeDraft(keyRef.current, nextValue);
  }, []);

  useEffect(() => {
    if (keyRef.current === key) return;

    const previousKey = keyRef.current;
    writeDraft(previousKey, valueRef.current);
    keyRef.current = key;
    const savedValue = readDraft(key);
    const shouldCarryNewChatDraft =
      conversationIdRef.current === null && conversationId !== null && !savedValue;
    const nextValue = shouldCarryNewChatDraft ? valueRef.current : savedValue;
    if (shouldCarryNewChatDraft) {
      writeDraft(key, nextValue);
      writeDraft(previousKey, "");
    }
    conversationIdRef.current = conversationId;
    valueRef.current = nextValue;
    setValue(nextValue);
  }, [conversationId, key]);

  return [value, setDraftValue];
}

const ATTACHMENT_DRAFT_PREFIX = "opfield-ai-composer-attachments";

function attachmentStorageKey(userId: string | undefined, conversationId: string | null) {
  return `${ATTACHMENT_DRAFT_PREFIX}:${userId ?? "anonymous"}:${conversationId ?? NEW_CONVERSATION_KEY}`;
}

function readAttachmentDraft(key: string): AIComposerAttachment[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is AIComposerAttachment => isAttachmentDraftItem(item))
      : [];
  } catch {
    return [];
  }
}

function writeAttachmentDraft(key: string, value: AIComposerAttachment[]): void {
  try {
    if (value.length > 0) {
      window.localStorage.setItem(key, JSON.stringify(value));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable in private or embedded contexts.
  }
}

function isAttachmentDraftItem(value: unknown): value is AIComposerAttachment {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "image" &&
    typeof record.filename === "string" &&
    typeof record.mediaType === "string" &&
    typeof record.sizeBytes === "number" &&
    ((typeof record.artifactId === "string" && typeof record.downloadUrl === "string") ||
      (typeof record.localId === "string" &&
        typeof record.dataUrl === "string" &&
        typeof record.previewUrl === "string"))
  );
}

export function useAIComposerAttachmentsDraft(
  conversationId: string | null
): [AIComposerAttachment[], (value: AIComposerAttachment[]) => void] {
  const userId = useAuthStore((state) => state.user?.id);
  const key = useMemo(() => attachmentStorageKey(userId, conversationId), [conversationId, userId]);
  const [value, setValue] = useState(() => readAttachmentDraft(key));
  const keyRef = useRef(key);
  const valueRef = useRef(value);
  const conversationIdRef = useRef(conversationId);

  const setDraftValue = useCallback((nextValue: AIComposerAttachment[]) => {
    valueRef.current = nextValue;
    setValue(nextValue);
    writeAttachmentDraft(keyRef.current, nextValue);
  }, []);

  useEffect(() => {
    if (keyRef.current === key) return;

    const previousKey = keyRef.current;
    writeAttachmentDraft(previousKey, valueRef.current);
    keyRef.current = key;
    const savedValue = readAttachmentDraft(key);
    const shouldCarryNewChatDraft =
      conversationIdRef.current === null && conversationId !== null && savedValue.length === 0;
    const nextValue = shouldCarryNewChatDraft ? valueRef.current : savedValue;
    if (shouldCarryNewChatDraft) {
      writeAttachmentDraft(key, nextValue);
      writeAttachmentDraft(previousKey, []);
    }
    conversationIdRef.current = conversationId;
    valueRef.current = nextValue;
    setValue(nextValue);
  }, [conversationId, key]);

  return [value, setDraftValue];
}

export function getComposerAttachmentId(attachment: AIComposerAttachment): string {
  return "artifactId" in attachment ? attachment.artifactId : attachment.localId;
}

export function getComposerAttachmentPreviewUrl(attachment: AIComposerAttachment): string {
  return "downloadUrl" in attachment ? attachment.downloadUrl : attachment.previewUrl;
}

export async function filesToComposerAttachments(
  files: File[]
): Promise<AIComposerLocalImageAttachment[]> {
  return Promise.all(
    files.map(async (file) => {
      const dataUrl = await fileToDataUrl(file);
      return {
        localId: `${Date.now()}-${createClientUuid()}`,
        filename: file.name,
        mediaType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        dataUrl,
        previewUrl: dataUrl,
        kind: "image" as const,
      };
    })
  );
}

export async function composerAttachmentToFile(
  attachment: AIComposerLocalImageAttachment
): Promise<File> {
  const separatorIndex = attachment.dataUrl.indexOf(",");
  if (!attachment.dataUrl.startsWith("data:") || separatorIndex < 0) {
    throw new Error("Invalid image attachment");
  }

  const metadata = attachment.dataUrl.slice(5, separatorIndex);
  const payload = attachment.dataUrl.slice(separatorIndex + 1);
  const bytes = metadata.split(";").includes("base64")
    ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));

  return new File([bytes], attachment.filename, { type: attachment.mediaType });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read image"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}
