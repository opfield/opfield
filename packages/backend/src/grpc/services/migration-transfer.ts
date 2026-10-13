import type { ServerDuplexStream } from '@grpc/grpc-js';
import { eq } from 'drizzle-orm';
import { nodes } from '@/db/schema/index.js';
import type {
  MigrationArtifactAck,
  MigrationArtifactChunk,
  MigrationArtifactError,
  MigrationTransferControl,
  MigrationTransferMessage,
} from '@/grpc/generated/migration-types.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { extractDaemonCertificateIdentity } from '../interceptors/auth.js';
import { matchEnrolledNodeCertificate } from '../node-certificate.js';
import type { GrpcServerDeps } from '../server.js';

const logger = createChildLogger('GrpcMigrationTransfer');
const MAX_CHUNK_BYTES = 1024 * 1024;

type MigrationStream = ServerDuplexStream<MigrationTransferMessage, MigrationTransferControl>;

interface TransferConnection {
  nodeId: string;
  stream: MigrationStream;
  maxChunkBytes: number;
}

interface RelaySession {
  key: string;
  migrationId: string;
  artifactId: string;
  source: TransferConnection;
  target: TransferConnection;
  offset: bigint;
  state: 'awaiting_target' | 'reading_source' | 'awaiting_ack';
  pendingChunk: MigrationArtifactChunk | null;
  onProgress?: (offset: number) => void | Promise<void>;
  resolve: (offset: number) => void;
  reject: (error: Error) => void;
}

interface DownloadSession {
  key: string;
  migrationId: string;
  artifactId: string;
  source: TransferConnection;
  offset: bigint;
  controller: ReadableStreamDefaultController<Uint8Array>;
  paused: boolean;
}

interface UploadSession {
  key: string;
  migrationId: string;
  artifactId: string;
  target: TransferConnection;
  offset: bigint;
  iterator: AsyncIterator<Uint8Array>;
  pendingBytes: number;
  sentEof: boolean;
  resolve: (offset: number) => void;
  reject: (error: Error) => void;
}

function relayKey(migrationId: string, artifactId: string): string {
  return `${migrationId}:${artifactId}`;
}

function offsetOf(value: string): bigint {
  try {
    return BigInt(value || '0');
  } catch {
    throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Daemon returned an invalid artifact offset');
  }
}

class MigrationTransferRelay {
  private connections = new Map<string, TransferConnection>();
  private relays = new Map<string, RelaySession>();
  private downloads = new Map<string, DownloadSession>();
  private uploads = new Map<string, UploadSession>();

  private assertNodesIdle(...nodeIds: string[]): void {
    const requested = new Set(nodeIds);
    const busy =
      [...this.relays.values()].some(
        (session) => requested.has(session.source.nodeId) || requested.has(session.target.nodeId)
      ) ||
      [...this.downloads.values()].some((session) => requested.has(session.source.nodeId)) ||
      [...this.uploads.values()].some((session) => requested.has(session.target.nodeId));
    if (busy) {
      throw new AppError(409, 'MIGRATION_TRANSFER_ACTIVE', 'Another archive transfer is active on this node');
    }
  }

  register(connection: TransferConnection): void {
    const previous = this.connections.get(connection.nodeId);
    if (previous && previous.stream !== connection.stream) previous.stream.end();
    this.connections.set(connection.nodeId, connection);
  }

  disconnect(nodeId: string, stream: MigrationStream): void {
    if (this.connections.get(nodeId)?.stream === stream) this.connections.delete(nodeId);
    for (const relay of this.relays.values()) {
      if (relay.source.stream === stream || relay.target.stream === stream) {
        this.fail(relay, new AppError(503, 'MIGRATION_NODE_UNAVAILABLE', 'Migration transfer stream disconnected'));
      }
    }
    for (const session of this.downloads.values()) {
      if (session.source.stream === stream)
        this.failDownload(session, new AppError(503, 'MIGRATION_NODE_UNAVAILABLE', 'Archive stream disconnected'));
    }
    for (const session of this.uploads.values()) {
      if (session.target.stream === stream)
        this.failUpload(session, new AppError(503, 'MIGRATION_NODE_UNAVAILABLE', 'Archive stream disconnected'));
    }
  }

  isConnected(nodeId: string): boolean {
    return this.connections.has(nodeId);
  }

  relayArtifact(args: {
    sourceNodeId: string;
    targetNodeId: string;
    migrationId: string;
    artifactId: string;
    offset: number;
    onProgress?: (offset: number) => void | Promise<void>;
  }): Promise<number> {
    const source = this.connections.get(args.sourceNodeId);
    const target = this.connections.get(args.targetNodeId);
    if (!source || !target) {
      throw new AppError(503, 'MIGRATION_NODE_UNAVAILABLE', 'Both Docker migration streams must be connected');
    }
    this.assertNodesIdle(args.sourceNodeId, args.targetNodeId);
    const key = relayKey(args.migrationId, args.artifactId);
    if (this.relays.has(key)) {
      throw new AppError(409, 'MIGRATION_TRANSFER_ACTIVE', 'Artifact transfer is already active');
    }
    const offset = BigInt(args.offset);
    return new Promise<number>((resolve, reject) => {
      const session: RelaySession = {
        key,
        migrationId: args.migrationId,
        artifactId: args.artifactId,
        source,
        target,
        offset,
        state: 'awaiting_target',
        pendingChunk: null,
        onProgress: args.onProgress,
        resolve,
        reject,
      };
      this.relays.set(key, session);
      target.stream.write({
        write: {
          migrationId: args.migrationId,
          artifactId: args.artifactId,
          offset: offset.toString(),
        },
      });
    });
  }

  readArtifact(args: { nodeId: string; migrationId: string; artifactId: string }): ReadableStream<Uint8Array> {
    const source = this.connections.get(args.nodeId);
    if (!source) throw new AppError(503, 'MIGRATION_NODE_UNAVAILABLE', 'Docker archive stream is not connected');
    this.assertNodesIdle(args.nodeId);
    const key = relayKey(args.migrationId, args.artifactId);
    if (this.relays.has(key) || this.downloads.has(key) || this.uploads.has(key)) {
      throw new AppError(409, 'MIGRATION_TRANSFER_ACTIVE', 'Archive transfer is already active');
    }
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.downloads.set(key, {
          key,
          migrationId: args.migrationId,
          artifactId: args.artifactId,
          source,
          offset: 0n,
          controller,
          paused: false,
        });
        source.stream.write({ read: { migrationId: args.migrationId, artifactId: args.artifactId, offset: '0' } });
      },
      cancel: () => {
        const session = this.downloads.get(key);
        if (session) this.failDownload(session, new Error('Archive download was cancelled'), false);
      },
      pull: () => {
        const session = this.downloads.get(key);
        if (session?.paused) {
          session.paused = false;
          session.source.stream.resume();
        }
      },
    });
  }

  writeArtifact(args: {
    nodeId: string;
    migrationId: string;
    artifactId: string;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<number> {
    const target = this.connections.get(args.nodeId);
    if (!target) throw new AppError(503, 'MIGRATION_NODE_UNAVAILABLE', 'Docker archive stream is not connected');
    this.assertNodesIdle(args.nodeId);
    const key = relayKey(args.migrationId, args.artifactId);
    if (this.relays.has(key) || this.downloads.has(key) || this.uploads.has(key)) {
      throw new AppError(409, 'MIGRATION_TRANSFER_ACTIVE', 'Archive transfer is already active');
    }
    return new Promise<number>((resolve, reject) => {
      this.uploads.set(key, {
        key,
        migrationId: args.migrationId,
        artifactId: args.artifactId,
        target,
        offset: 0n,
        iterator: args.chunks[Symbol.asyncIterator](),
        pendingBytes: 0,
        sentEof: false,
        resolve,
        reject,
      });
      target.stream.write({ write: { migrationId: args.migrationId, artifactId: args.artifactId, offset: '0' } });
    });
  }

  handle(nodeId: string, message: MigrationTransferMessage): void {
    if (message.chunk) this.handleChunk(nodeId, message.chunk);
    else if (message.ack) this.handleAck(nodeId, message.ack);
    else if (message.error) this.handleError(nodeId, message.error);
  }

  private handleChunk(nodeId: string, chunk: MigrationArtifactChunk): void {
    const download = this.downloads.get(relayKey(chunk.migrationId, chunk.artifactId));
    if (download && download.source.nodeId === nodeId) {
      try {
        if (
          offsetOf(chunk.offset) !== download.offset ||
          chunk.data.length > MAX_CHUNK_BYTES ||
          (chunk.eof && chunk.data.length > 0)
        ) {
          throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Archive chunk is invalid or out of sequence');
        }
        if (chunk.data.length > 0) {
          download.controller.enqueue(new Uint8Array(chunk.data));
          download.offset += BigInt(chunk.data.length);
          download.paused = true;
          download.source.stream.pause();
          download.source.stream.write({
            ack: {
              migrationId: download.migrationId,
              artifactId: download.artifactId,
              acknowledgedOffset: download.offset.toString(),
              complete: false,
            },
          });
        }
        if (chunk.eof) {
          this.downloads.delete(download.key);
          download.source.stream.resume();
          download.controller.close();
        }
      } catch (error) {
        this.failDownload(download, error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    const session = this.relays.get(relayKey(chunk.migrationId, chunk.artifactId));
    if (!session || session.source.nodeId !== nodeId) return;
    try {
      if (session.state !== 'reading_source' || offsetOf(chunk.offset) !== session.offset) {
        throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Source artifact offset is out of sequence');
      }
      if (chunk.data.length > Math.min(MAX_CHUNK_BYTES, session.target.maxChunkBytes)) {
        throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Source artifact chunk exceeds negotiated size');
      }
      if (chunk.eof && chunk.data.length > 0) {
        throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'EOF artifact chunk contains data');
      }
      session.state = 'awaiting_ack';
      session.pendingChunk = chunk;
      session.source.stream.pause();
      session.target.stream.write({ chunk });
    } catch (error) {
      this.fail(session, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleAck(nodeId: string, ack: MigrationArtifactAck): void {
    const upload = this.uploads.get(relayKey(ack.migrationId, ack.artifactId));
    if (upload && upload.target.nodeId === nodeId) {
      try {
        const expected = upload.offset + BigInt(upload.pendingBytes);
        if (offsetOf(ack.acknowledgedOffset) !== expected || ack.complete !== upload.sentEof) {
          throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Archive acknowledgement is invalid');
        }
        upload.offset = expected;
        upload.pendingBytes = 0;
        if (upload.sentEof) {
          this.uploads.delete(upload.key);
          upload.resolve(Number(upload.offset));
        } else {
          void this.advanceUpload(upload);
        }
      } catch (error) {
        this.failUpload(upload, error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    const session = this.relays.get(relayKey(ack.migrationId, ack.artifactId));
    if (!session || session.target.nodeId !== nodeId) return;
    try {
      if (session.state === 'awaiting_target') {
        if (offsetOf(ack.acknowledgedOffset) !== session.offset) {
          throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Target resume offset does not match');
        }
        session.state = 'reading_source';
        session.source.stream.write({
          read: {
            migrationId: session.migrationId,
            artifactId: session.artifactId,
            offset: session.offset.toString(),
          },
        });
        return;
      }
      if (session.state !== 'awaiting_ack' || !session.pendingChunk) {
        throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Unexpected target artifact acknowledgement');
      }
      const expected = session.offset + BigInt(session.pendingChunk.data.length);
      if (offsetOf(ack.acknowledgedOffset) !== expected) {
        throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Target acknowledged an invalid artifact offset');
      }
      const complete = session.pendingChunk.eof;
      if (complete !== ack.complete) {
        throw new AppError(502, 'MIGRATION_TRANSFER_PROTOCOL', 'Target completion acknowledgement is inconsistent');
      }
      session.offset = expected;
      session.source.stream.write({ ack });
      session.pendingChunk = null;
      void session.onProgress?.(Number(session.offset));
      if (complete) {
        this.relays.delete(session.key);
        session.source.stream.resume();
        session.resolve(Number(session.offset));
      } else {
        session.state = 'reading_source';
        session.source.stream.resume();
      }
    } catch (error) {
      this.fail(session, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleError(nodeId: string, message: MigrationArtifactError): void {
    const download = this.downloads.get(relayKey(message.migrationId, message.artifactId));
    if (download && download.source.nodeId === nodeId) {
      this.failDownload(
        download,
        new AppError(502, 'MIGRATION_TRANSFER_FAILED', message.message || 'Archive transfer failed')
      );
      return;
    }
    const upload = this.uploads.get(relayKey(message.migrationId, message.artifactId));
    if (upload && upload.target.nodeId === nodeId) {
      this.failUpload(
        upload,
        new AppError(502, 'MIGRATION_TRANSFER_FAILED', message.message || 'Archive transfer failed')
      );
      return;
    }
    const session = this.relays.get(relayKey(message.migrationId, message.artifactId));
    if (!session || (session.source.nodeId !== nodeId && session.target.nodeId !== nodeId)) return;
    this.fail(session, new AppError(502, 'MIGRATION_TRANSFER_FAILED', message.message || 'Artifact transfer failed'));
  }

  private fail(session: RelaySession, error: Error): void {
    if (!this.relays.delete(session.key)) return;
    const message = {
      error: {
        migrationId: session.migrationId,
        artifactId: session.artifactId,
        message: error.message,
      },
    };
    session.source.stream.write(message);
    session.target.stream.write(message);
    session.source.stream.resume();
    session.reject(error);
  }

  private async advanceUpload(session: UploadSession): Promise<void> {
    try {
      const next = await session.iterator.next();
      if (!this.uploads.has(session.key)) return;
      if (next.done) {
        session.sentEof = true;
        session.target.stream.write({
          chunk: {
            migrationId: session.migrationId,
            artifactId: session.artifactId,
            offset: session.offset.toString(),
            data: Buffer.alloc(0),
            eof: true,
          },
        });
        return;
      }
      const data = Buffer.from(next.value);
      if (data.length === 0) return void this.advanceUpload(session);
      if (data.length > Math.min(MAX_CHUNK_BYTES, session.target.maxChunkBytes)) {
        throw new AppError(413, 'ARCHIVE_CHUNK_TOO_LARGE', 'Archive image chunk exceeds 1 MiB');
      }
      session.pendingBytes = data.length;
      session.target.stream.write({
        chunk: {
          migrationId: session.migrationId,
          artifactId: session.artifactId,
          offset: session.offset.toString(),
          data,
          eof: false,
        },
      });
    } catch (error) {
      this.failUpload(session, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failDownload(session: DownloadSession, error: Error, signalDaemon = true): void {
    if (!this.downloads.delete(session.key)) return;
    if (signalDaemon)
      session.source.stream.write({
        error: { migrationId: session.migrationId, artifactId: session.artifactId, message: error.message },
      });
    session.source.stream.resume();
    session.controller.error(error);
  }

  private failUpload(session: UploadSession, error: Error): void {
    if (!this.uploads.delete(session.key)) return;
    session.target.stream.write({
      error: { migrationId: session.migrationId, artifactId: session.artifactId, message: error.message },
    });
    void session.iterator.return?.();
    session.reject(error);
  }
}

export const migrationTransferRelay = new MigrationTransferRelay();

const DOCKER_NODE_NOT_CONNECTED = 'Docker node is not connected';

export function createMigrationTransferHandlers(deps: GrpcServerDeps) {
  return {
    Transfer(stream: MigrationStream) {
      let nodeId: string | null = null;
      let authenticatedNodeId: string | null = null;
      let authenticated = false;
      let closed = false;
      stream.pause();

      const close = () => {
        if (closed) return;
        closed = true;
        if (nodeId) migrationTransferRelay.disconnect(nodeId, stream);
      };
      stream.on('end', () => {
        close();
        stream.end();
      });
      stream.on('error', close);
      stream.on('data', (message: MigrationTransferMessage) => {
        if (!authenticated || closed) return;
        if (!nodeId) {
          const hello = message.hello;
          if (!hello || hello.capability !== 'docker_migration_v1') {
            stream.end();
            return;
          }
          if (hello.nodeId !== authenticatedNodeId) {
            stream.end();
            return;
          }
          nodeId = hello.nodeId;
          migrationTransferRelay.register({
            nodeId,
            stream,
            maxChunkBytes: Math.min(MAX_CHUNK_BYTES, Math.max(1, hello.maxChunkBytes)),
          });
          logger.debug('Docker migration transfer stream opened', { nodeId });
          return;
        }
        migrationTransferRelay.handle(nodeId, message);
      });

      void (async () => {
        const identity = extractDaemonCertificateIdentity(stream as never);
        if (!identity) throw new Error('missing authorized daemon certificate');
        const connected = deps.registry.getNode(identity.nodeId);
        if (!connected || connected.type !== 'docker') throw new Error(DOCKER_NODE_NOT_CONNECTED);
        const [node] = await deps.db
          .select({
            certificateSerial: nodes.certificateSerial,
            certificateFingerprint: nodes.certificateFingerprint,
            pendingCertificateSerial: nodes.pendingCertificateSerial,
            pendingCertificateFingerprint: nodes.pendingCertificateFingerprint,
            status: nodes.status,
            type: nodes.type,
          })
          .from(nodes)
          .where(eq(nodes.id, identity.nodeId))
          .limit(1);
        if (
          !node ||
          node.status === 'pending' ||
          node.type !== 'docker' ||
          !node.certificateSerial ||
          !matchEnrolledNodeCertificate(node, identity)
        ) {
          throw new Error('daemon certificate does not match the enrolled Docker node');
        }
        authenticatedNodeId = identity.nodeId;
        authenticated = true;
        stream.resume();
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        // Opened right after Register, the stream can arrive before the registration finished (every Opfield or
        // daemon restart); the daemon opens it again. Only a real rejection is worth a warning.
        if (message === DOCKER_NODE_NOT_CONNECTED) {
          logger.debug('Docker migration transfer stream rejected', { nodeId, error: message });
        } else {
          logger.warn('Docker migration transfer stream rejected', { nodeId, error: message });
        }
        close();
        stream.end();
      });
    },
  };
}
