import { ServerInterceptingCall, type ServerInterceptor } from '@grpc/grpc-js';
import { createChildLogger } from '@/lib/logger.js';
import { getPeerCertificateSocket } from './auth.js';

const logger = createChildLogger('GrpcReceiveLimit');

/** What a client without a verified certificate may send in one message (the relay front allows the same). */
export const ANONYMOUS_MAX_MESSAGE_BYTES = 1024 * 1024;

let warnedUnenforceable = false;

interface DecoderHolder {
  decoder?: { maxReadMessageLength?: unknown };
  /** The limit on a message after decompression (a gzip message under the limit can expand to far more). */
  maxReceiveMessageSize?: unknown;
}

/** A TLS client certificate was presented and verified against the system CA (daemons and relays always do). */
function presentsVerifiedCertificate(call: unknown): boolean {
  return getPeerCertificateSocket(call)?.authorized === true;
}

/**
 * Receive limit per call. The server-wide limit has to fit the biggest messages of enrolled daemons (command
 * results, migration chunks), but a client that presents no verified certificate (anyone on the internet: Enroll,
 * RenewCertificate and Redeem are reachable without one, and the streams reject such clients only after reading
 * their first message) may send at most 1 MiB. grpc-js has no per-method option, so the limit is set on the decoder
 * of the call, which checks it on the length prefix before it buffers the message, and on the call's limit for the
 * decompressed size. Unary methods are small for
 * everyone: their requests carry a token, a CSR or an access code.
 */
export function receiveLimitInterceptor(authenticatedMaxBytes: number): ServerInterceptor {
  return (methodDescriptor, call) => {
    const limit =
      methodDescriptor.requestStream && presentsVerifiedCertificate(call)
        ? authenticatedMaxBytes
        : ANONYMOUS_MAX_MESSAGE_BYTES;
    const holder = call as unknown as DecoderHolder;
    const decoder = holder.decoder;
    if (decoder && typeof decoder.maxReadMessageLength === 'number' && typeof holder.maxReceiveMessageSize === 'number') {
      if (decoder.maxReadMessageLength === -1 || decoder.maxReadMessageLength > limit) {
        decoder.maxReadMessageLength = limit;
      }
      if (holder.maxReceiveMessageSize === -1 || holder.maxReceiveMessageSize > limit) {
        holder.maxReceiveMessageSize = limit;
      }
    } else if (!warnedUnenforceable) {
      warnedUnenforceable = true;
      logger.error('gRPC receive limit per call cannot be applied: the grpc-js call has no message decoder or size limit');
    }
    return new ServerInterceptingCall(call);
  };
}
