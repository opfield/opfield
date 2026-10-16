import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Env } from '@/config/env.js';
import { AppError } from '@/middleware/error-handler.js';

const PRODUCTION_ARTIFACT_DIR = '/var/lib/gateway/ai-artifacts';
const LOCAL_ARTIFACT_DIR = path.join(os.tmpdir(), 'opfield-ai-artifacts');
export const AI_TOOL_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;
export const AI_TOOL_OUTPUT_CONVERSATION_MAX_BYTES = 250 * 1024 * 1024;
/** Total of tool and sandbox outputs kept across all conversations; the oldest go first above it. */
export const AI_GENERATED_ARTIFACTS_MAX_BYTES = 10 * 1024 * 1024 * 1024;
/** An artifact without a live conversation is removed only after this long. */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const AI_TOOL_OUTPUT_READ_DEFAULT_BYTES = 32 * 1024;
const AI_TOOL_OUTPUT_READ_MAX_BYTES = 64 * 1024;
const AI_TOOL_OUTPUT_SEARCH_MAX_MATCHES = 50;
const AI_TOOL_OUTPUT_SEARCH_SNIPPET_CHARS = 512;

export type AIArtifactKind = 'user_attachment' | 'sandbox_output' | 'tool_output';

export interface AISandboxArtifactMetadata {
  id: string;
  userId: string;
  conversationId: string | null;
  kind?: AIArtifactKind;
  sourceProcessId: string;
  sourcePath: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  sourceRunId?: string;
  sourceToolCallId?: string;
  format?: 'json' | 'text';
  estimatedTokens?: number;
  preview?: string;
}

export interface AIToolOutputArtifactDescriptor {
  outputOffloaded: true;
  artifactId: string;
  format: 'json' | 'text';
  sizeBytes: number;
  estimatedTokens: number;
  preview: string;
  downloadUrl: string;
  readTool: 'read_tool_output';
  searchTool: 'search_tool_output';
}

export interface AISandboxArtifactDownload {
  metadata: AISandboxArtifactMetadata;
  filePath: string;
}

export interface AISandboxArtifactListItem extends AISandboxArtifactMetadata {
  downloadUrl: string;
}

export interface AISandboxArtifactPage {
  items: AISandboxArtifactListItem[];
  nextPage: number | null;
}

export class AISandboxArtifactService {
  private readonly rootDir: string;
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private conversationLookup?: (conversationIds: string[]) => Promise<Set<string>>;

  constructor(env: Env) {
    this.rootDir =
      env.NODE_ENV !== 'production' && env.AI_SANDBOX_ARTIFACT_DIR === PRODUCTION_ARTIFACT_DIR
        ? LOCAL_ARTIFACT_DIR
        : env.AI_SANDBOX_ARTIFACT_DIR;
  }

  async saveFromTempFile(input: {
    userId: string;
    conversationId?: string | null;
    sourceProcessId: string;
    sourcePath: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    tempFilePath: string;
  }): Promise<AISandboxArtifactMetadata & { downloadUrl: string }> {
    const id = randomUUID();
    const metadata: AISandboxArtifactMetadata = {
      id,
      userId: input.userId,
      conversationId: input.conversationId ?? null,
      kind: 'sandbox_output',
      sourceProcessId: input.sourceProcessId,
      sourcePath: input.sourcePath,
      filename: sanitizeArtifactFilename(input.filename),
      mediaType: input.mediaType || 'application/octet-stream',
      sizeBytes: input.sizeBytes,
      createdAt: new Date().toISOString(),
    };

    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(id);
    const metaPath = this.metaPath(id);
    await fs.copyFile(input.tempFilePath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
    await fs.unlink(input.tempFilePath).catch(() => {});

    return {
      ...metadata,
      downloadUrl: `/api/ai/sandbox/artifacts/${encodeURIComponent(id)}/download`,
    };
  }

  async saveFromBuffer(input: {
    userId: string;
    conversationId?: string | null;
    sourceProcessId?: string;
    sourcePath?: string;
    filename: string;
    mediaType: string;
    buffer: Buffer;
    kind?: Exclude<AIArtifactKind, 'tool_output'>;
  }): Promise<AISandboxArtifactMetadata & { downloadUrl: string }> {
    const id = randomUUID();
    const metadata: AISandboxArtifactMetadata = {
      id,
      userId: input.userId,
      conversationId: input.conversationId ?? null,
      kind: input.kind ?? 'user_attachment',
      sourceProcessId: input.sourceProcessId ?? 'chat-upload',
      sourcePath: input.sourcePath ?? input.filename,
      filename: sanitizeArtifactFilename(input.filename),
      mediaType: input.mediaType || 'application/octet-stream',
      sizeBytes: input.buffer.byteLength,
      createdAt: new Date().toISOString(),
    };

    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(id);
    const metaPath = this.metaPath(id);
    await fs.writeFile(filePath, input.buffer, { mode: 0o600 });
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });

    return {
      ...metadata,
      downloadUrl: `/api/ai/sandbox/artifacts/${encodeURIComponent(id)}/download`,
    };
  }

  async saveToolOutput(input: {
    userId: string;
    conversationId: string;
    sourceRunId: string;
    sourceToolCallId: string;
    format: 'json' | 'text';
    estimatedTokens: number;
    preview: string;
    buffer: Buffer;
  }): Promise<AIToolOutputArtifactDescriptor> {
    if (input.buffer.byteLength > AI_TOOL_OUTPUT_MAX_BYTES) {
      throw new AppError(
        413,
        'TOOL_OUTPUT_TOO_LARGE',
        `Tool output is ${input.buffer.byteLength} bytes; the automatic artifact limit is ${AI_TOOL_OUTPUT_MAX_BYTES} bytes. Narrow, filter, or paginate the tool request before retrying.`
      );
    }

    return this.withConversationLock(`${input.userId}:${input.conversationId}`, async () => {
      const artifacts = await this.readAllMetadata();
      const usedBytes = artifacts
        .filter(
          (metadata) =>
            metadata.userId === input.userId &&
            metadata.conversationId === input.conversationId &&
            metadata.kind === 'tool_output'
        )
        .reduce((total, metadata) => total + Math.max(0, metadata.sizeBytes), 0);
      if (usedBytes + input.buffer.byteLength > AI_TOOL_OUTPUT_CONVERSATION_MAX_BYTES) {
        throw new AppError(
          409,
          'TOOL_OUTPUT_ARTIFACT_QUOTA_EXCEEDED',
          `This conversation already uses ${usedBytes} bytes of its ${AI_TOOL_OUTPUT_CONVERSATION_MAX_BYTES} byte tool-output artifact quota. Narrow, filter, or paginate the tool request before retrying.`
        );
      }

      const id = randomUUID();
      const filename = `tool-output-${input.sourceToolCallId}.${input.format === 'json' ? 'json' : 'txt'}`;
      const metadata: AISandboxArtifactMetadata = {
        id,
        userId: input.userId,
        conversationId: input.conversationId,
        kind: 'tool_output',
        sourceProcessId: input.sourceRunId,
        sourcePath: filename,
        filename: sanitizeArtifactFilename(filename),
        mediaType: input.format === 'json' ? 'application/json' : 'text/plain; charset=utf-8',
        sizeBytes: input.buffer.byteLength,
        createdAt: new Date().toISOString(),
        sourceRunId: input.sourceRunId,
        sourceToolCallId: input.sourceToolCallId,
        format: input.format,
        estimatedTokens: Math.max(0, Math.trunc(input.estimatedTokens)),
        preview: input.preview,
      };

      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const tempPath = path.join(this.rootDir, `${id}.tmp`);
      const filePath = this.filePath(id);
      try {
        await fs.writeFile(tempPath, input.buffer, { mode: 0o600, flag: 'wx' });
        const storedBytes = (await fs.stat(tempPath)).size;
        if (storedBytes > AI_TOOL_OUTPUT_MAX_BYTES) {
          throw new AppError(
            413,
            'TOOL_OUTPUT_TOO_LARGE',
            `Stored tool output exceeded the ${AI_TOOL_OUTPUT_MAX_BYTES} byte automatic artifact limit`
          );
        }
        await fs.rename(tempPath, filePath);
        await this.writeMetadata(metadata);
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        await fs.unlink(filePath).catch(() => {});
        await fs.unlink(this.metaPath(id)).catch(() => {});
        throw error;
      }

      return {
        outputOffloaded: true,
        artifactId: id,
        format: input.format,
        sizeBytes: metadata.sizeBytes,
        estimatedTokens: metadata.estimatedTokens ?? 0,
        preview: input.preview,
        downloadUrl: `/api/ai/sandbox/artifacts/${encodeURIComponent(id)}/download`,
        readTool: 'read_tool_output',
        searchTool: 'search_tool_output',
      };
    });
  }

  async readToolOutput(input: {
    userId: string;
    conversationId: string;
    artifactId: string;
    offset?: number;
    limitBytes?: number;
  }): Promise<{ content: string; offset: number; nextOffset: number; eof: boolean; sizeBytes: number }> {
    const { metadata, filePath } = await this.getToolOutput(input.userId, input.conversationId, input.artifactId);
    const offset = clampInteger(input.offset, 0, metadata.sizeBytes, 0);
    const limitBytes = clampInteger(
      input.limitBytes,
      1,
      AI_TOOL_OUTPUT_READ_MAX_BYTES,
      AI_TOOL_OUTPUT_READ_DEFAULT_BYTES
    );
    const length = Math.min(limitBytes, Math.max(0, metadata.sizeBytes - offset));
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const nextOffset = offset + bytesRead;
      return {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        offset,
        nextOffset,
        eof: nextOffset >= metadata.sizeBytes,
        sizeBytes: metadata.sizeBytes,
      };
    } finally {
      await handle.close();
    }
  }

  async searchToolOutput(input: {
    userId: string;
    conversationId: string;
    artifactId: string;
    query: string;
    maxMatches?: number;
  }): Promise<{ matches: Array<{ offset: number; snippet: string }>; truncated: boolean; sizeBytes: number }> {
    const query = input.query.trim();
    if (!query || query.length > 512) {
      throw new AppError(400, 'INVALID_TOOL_OUTPUT_SEARCH', 'Search query must contain 1 to 512 characters');
    }
    const { metadata, filePath } = await this.getToolOutput(input.userId, input.conversationId, input.artifactId);
    const maxMatches = clampInteger(input.maxMatches, 1, AI_TOOL_OUTPUT_SEARCH_MAX_MATCHES, 20);
    const content = await fs.readFile(filePath, 'utf8');
    const haystack = content.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const matches: Array<{ offset: number; snippet: string }> = [];
    let cursor = 0;
    while (matches.length < maxMatches + 1) {
      const index = haystack.indexOf(needle, cursor);
      if (index < 0) break;
      const start = Math.max(0, index - Math.floor(AI_TOOL_OUTPUT_SEARCH_SNIPPET_CHARS / 2));
      const end = Math.min(content.length, start + AI_TOOL_OUTPUT_SEARCH_SNIPPET_CHARS);
      matches.push({ offset: index, snippet: content.slice(start, end) });
      cursor = index + Math.max(1, needle.length);
    }
    return {
      matches: matches.slice(0, maxMatches),
      truncated: matches.length > maxMatches,
      sizeBytes: metadata.sizeBytes,
    };
  }

  async syncConversationArtifacts(userId: string, artifactIds: string[], conversationId: string): Promise<void> {
    const activeIds = new Set(artifactIds.filter(isArtifactId));
    const artifacts = await this.readAllMetadata();

    await Promise.all(
      artifacts.map(async (metadata) => {
        if (metadata.userId !== userId) return;
        // Tool outputs are durable conversation-owned runtime artifacts. Attachment
        // synchronization must never detach them just because they are not present
        // in the user-visible attachment list.
        if (metadata.kind === 'tool_output') return;
        if (activeIds.has(metadata.id)) {
          if (metadata.conversationId && metadata.conversationId !== conversationId) return;
          if (metadata.conversationId === conversationId) return;
          await this.writeMetadata({ ...metadata, conversationId });
          return;
        }
        if (metadata.conversationId !== conversationId) return;
        await this.writeMetadata({ ...metadata, conversationId: null });
      })
    );
  }

  async getDownload(userId: string, artifactId: string): Promise<AISandboxArtifactDownload> {
    const metadata = await this.readMetadata(artifactId);
    if (metadata.userId !== userId) {
      throw new AppError(403, 'SANDBOX_ARTIFACT_FORBIDDEN', 'You cannot access this sandbox artifact');
    }
    const filePath = this.filePath(metadata.id);
    await fs.access(filePath);
    return { metadata, filePath };
  }

  async listForUser(userId: string): Promise<AISandboxArtifactListItem[]> {
    const artifacts = await this.readAllMetadata();
    return artifacts
      .filter((metadata) => metadata.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((metadata) => this.toListItem(metadata));
  }

  async listPageForUser(userId: string, page: number, limit: number): Promise<AISandboxArtifactPage> {
    const artifacts = await this.listForUser(userId);
    const offset = (page - 1) * limit;
    const items = artifacts.slice(offset, offset + limit);
    return {
      items,
      nextPage: offset + items.length < artifacts.length ? page + 1 : null,
    };
  }

  async delete(userId: string, artifactId: string): Promise<boolean> {
    const metadata = await this.readMetadata(artifactId);
    if (metadata.userId !== userId) {
      throw new AppError(403, 'SANDBOX_ARTIFACT_FORBIDDEN', 'You cannot access this sandbox artifact');
    }
    await this.deleteFiles(metadata.id);
    return true;
  }

  async deleteForConversation(
    userId: string,
    conversationId: string
  ): Promise<{ itemsDeleted: number; spaceFreedBytes: number }> {
    const artifacts = await this.readAllMetadata();
    let itemsDeleted = 0;
    let spaceFreedBytes = 0;

    for (const metadata of artifacts) {
      if (metadata.userId !== userId || metadata.conversationId !== conversationId) continue;
      spaceFreedBytes += await this.fileSize(metadata.id);
      await this.deleteFiles(metadata.id);
      itemsDeleted += 1;
    }

    return { itemsDeleted, spaceFreedBytes };
  }

  /**
   * Tells which of the given conversation ids still exist. Without it only artifacts that name no conversation are
   * orphans; with it, so are the artifacts of a deleted conversation or user (their rows cascade, the files stayed).
   */
  setConversationLookup(lookup: (conversationIds: string[]) => Promise<Set<string>>): void {
    this.conversationLookup = lookup;
  }

  private async orphanTest(
    artifacts: AISandboxArtifactMetadata[]
  ): Promise<(metadata: AISandboxArtifactMetadata) => boolean> {
    const named = [...new Set(artifacts.map((metadata) => metadata.conversationId).filter((id): id is string => !!id))];
    let existing: Set<string> | null = null;
    if (this.conversationLookup && named.length > 0) {
      try {
        existing = await this.conversationLookup(named);
      } catch {
        // Unknown: treat every named conversation as alive.
        existing = null;
      }
    }
    return (metadata) => !metadata.conversationId || (existing !== null && !existing.has(metadata.conversationId));
  }

  async getOrphanedStats(): Promise<{
    count: number;
    totalSizeBytes: number;
    allCount: number;
    allSizeBytes: number;
    capBytes: number;
  }> {
    const artifacts = await this.readAllMetadata();
    const isOrphan = await this.orphanTest(artifacts);
    let count = 0;
    let totalSizeBytes = 0;
    let allSizeBytes = 0;

    for (const metadata of artifacts) {
      const size = await this.fileSize(metadata.id);
      allSizeBytes += size;
      if (!isOrphan(metadata)) continue;
      count += 1;
      totalSizeBytes += size;
    }

    return {
      count,
      totalSizeBytes,
      allCount: artifacts.length,
      allSizeBytes,
      capBytes: AI_GENERATED_ARTIFACTS_MAX_BYTES,
    };
  }

  async cleanOrphanedArtifacts(): Promise<{ itemsCleaned: number; spaceFreedBytes: number }> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.rootDir).catch(() => []);
    const artifacts = await this.readAllMetadata();
    const isOrphan = await this.orphanTest(artifacts);
    const known = new Set(artifacts.map((metadata) => metadata.id));
    const now = Date.now();
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;
    const remove = async (id: string) => {
      spaceFreedBytes += await this.fileSize(id);
      await this.deleteFiles(id);
      itemsCleaned += 1;
    };

    for (const metadata of artifacts) {
      // A file is attached to its conversation after the upload: give that a while.
      if (isOrphan(metadata) && now - Date.parse(metadata.createdAt) >= ORPHAN_MIN_AGE_MS) await remove(metadata.id);
    }
    // Metadata files that do not parse name nothing: orphans too, once they are not being written any more.
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      if (!isArtifactId(id) || known.has(id)) continue;
      const written = await fs
        .stat(this.metaPath(id))
        .then((stats) => stats.mtimeMs)
        .catch(() => null);
      if (written === null || now - written < ORPHAN_MIN_AGE_MS) continue;
      await remove(id);
    }

    const capped = await this.enforceGeneratedArtifactCap(artifacts.filter((metadata) => !isOrphan(metadata)));
    const interrupted = await this.cleanInterruptedFiles();
    return {
      itemsCleaned: itemsCleaned + capped.itemsCleaned + interrupted.itemsCleaned,
      spaceFreedBytes: spaceFreedBytes + capped.spaceFreedBytes + interrupted.spaceFreedBytes,
    };
  }

  /**
   * Keeps the files tools and sandboxes generated (tool outputs, sandbox outputs) within
   * AI_GENERATED_ARTIFACTS_MAX_BYTES in total by removing the oldest first. Files users attached are never removed here.
   */
  private async enforceGeneratedArtifactCap(
    artifacts: AISandboxArtifactMetadata[]
  ): Promise<{ itemsCleaned: number; spaceFreedBytes: number }> {
    const generated = artifacts
      .filter((metadata) => metadata.kind === 'tool_output' || metadata.kind === 'sandbox_output')
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const sizes = new Map<string, number>();
    let total = 0;
    for (const metadata of generated) {
      const size = await this.fileSize(metadata.id);
      sizes.set(metadata.id, size);
      total += size;
    }
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;
    for (const metadata of generated) {
      if (total <= AI_GENERATED_ARTIFACTS_MAX_BYTES) break;
      const size = sizes.get(metadata.id) ?? 0;
      await this.deleteFiles(metadata.id);
      total -= size;
      itemsCleaned += 1;
      spaceFreedBytes += size;
    }
    return { itemsCleaned, spaceFreedBytes };
  }

  /** Remove incomplete atomic writes and data files left before metadata commit. */
  async cleanInterruptedFiles(): Promise<{ itemsCleaned: number; spaceFreedBytes: number }> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const remainingEntries: string[] = await fs.readdir(this.rootDir).catch(() => []);
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;
    for (const entry of remainingEntries) {
      if (entry.endsWith('.tmp')) {
        const filePath = path.join(this.rootDir, entry);
        const stats = await fs.stat(filePath).catch(() => null);
        await fs.unlink(filePath).catch(() => {});
        if (stats) {
          itemsCleaned += 1;
          spaceFreedBytes += stats.size;
        }
        continue;
      }
      if (!entry.endsWith('.bin')) continue;
      const id = entry.slice(0, -4);
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      if (remainingEntries.includes(`${id}.json`)) continue;
      const filePath = this.filePath(id);
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats) continue;
      await fs.unlink(filePath).catch(() => {});
      itemsCleaned += 1;
      spaceFreedBytes += stats.size;
    }

    return { itemsCleaned, spaceFreedBytes };
  }

  private async readMetadata(artifactId: string): Promise<AISandboxArtifactMetadata> {
    const id = assertArtifactId(artifactId);
    try {
      const metadata = JSON.parse(await fs.readFile(this.metaPath(id), 'utf-8')) as AISandboxArtifactMetadata;
      if (metadata.id !== id) throw new Error('artifact metadata id mismatch');
      return metadata;
    } catch {
      throw new AppError(404, 'SANDBOX_ARTIFACT_NOT_FOUND', 'Sandbox artifact not found');
    }
  }

  private async getToolOutput(
    userId: string,
    conversationId: string,
    artifactId: string
  ): Promise<AISandboxArtifactDownload> {
    const download = await this.getDownload(userId, artifactId);
    if (download.metadata.kind !== 'tool_output' || download.metadata.conversationId !== conversationId) {
      throw new AppError(403, 'TOOL_OUTPUT_ARTIFACT_FORBIDDEN', 'Tool output does not belong to this conversation');
    }
    return download;
  }

  private async readAllMetadata(): Promise<AISandboxArtifactMetadata[]> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.rootDir).catch(() => []);
    const artifacts: AISandboxArtifactMetadata[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const metadata = JSON.parse(
          await fs.readFile(path.join(this.rootDir, entry), 'utf-8')
        ) as AISandboxArtifactMetadata;
        if (isArtifactId(metadata.id) && metadata.userId && metadata.filename && metadata.createdAt) {
          artifacts.push(metadata);
        }
      } catch {
        // Ignore corrupt metadata; housekeeping can remove orphaned files later.
      }
    }

    return artifacts;
  }

  private toListItem(metadata: AISandboxArtifactMetadata): AISandboxArtifactListItem {
    return {
      ...metadata,
      downloadUrl: `/api/ai/sandbox/artifacts/${encodeURIComponent(metadata.id)}/download`,
    };
  }

  private async fileSize(id: string): Promise<number> {
    return fs
      .stat(this.filePath(id))
      .then((stat) => stat.size)
      .catch(() => 0);
  }

  private async deleteFiles(id: string): Promise<void> {
    await fs.unlink(this.filePath(id)).catch(() => {});
    await fs.unlink(this.metaPath(id)).catch(() => {});
  }

  private async writeMetadata(metadata: AISandboxArtifactMetadata): Promise<void> {
    await fs.writeFile(this.metaPath(metadata.id), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  }

  private async withConversationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.conversationLocks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.conversationLocks.get(key) === queued) this.conversationLocks.delete(key);
    }
  }

  private filePath(id: string): string {
    return path.join(this.rootDir, `${assertArtifactId(id)}.bin`);
  }

  private metaPath(id: string): string {
    return path.join(this.rootDir, `${assertArtifactId(id)}.json`);
  }
}

function assertArtifactId(id: string): string {
  if (!isArtifactId(id)) {
    throw new AppError(400, 'INVALID_SANDBOX_ARTIFACT_ID', 'Invalid sandbox artifact id');
  }
  return id;
}

function isArtifactId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
}

function sanitizeArtifactFilename(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'artifact.bin';
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}
