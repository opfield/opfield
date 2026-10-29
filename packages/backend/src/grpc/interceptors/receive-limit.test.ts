import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANONYMOUS_MAX_MESSAGE_BYTES, receiveLimitInterceptor } from './receive-limit.js';

const identity = (value: Buffer) => value;
const unary = {
  path: '/test.Service/Unary',
  requestStream: false,
  responseStream: false,
  requestSerialize: identity,
  requestDeserialize: identity,
  responseSerialize: identity,
  responseDeserialize: identity,
} as const;
const bidi = { ...unary, path: '/test.Service/Stream', requestStream: true, responseStream: true } as const;

describe('gRPC receive limit per call', () => {
  let server: grpc.Server;
  let client: grpc.Client;
  let port = 0;

  beforeAll(async () => {
    // The server-wide limit stays large for enrolled daemons; the interceptor narrows it per call.
    server = new grpc.Server({
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
      interceptors: [receiveLimitInterceptor(64 * 1024 * 1024)],
    });
    server.addService(
      { Unary: unary, Stream: bidi },
      {
        Unary: (call: grpc.ServerUnaryCall<Buffer, Buffer>, callback: grpc.sendUnaryData<Buffer>) =>
          callback(null, Buffer.from(String(call.request.length))),
        Stream: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
          call.on('data', (message: Buffer) => call.write(Buffer.from(String(message.length))));
          call.on('end', () => call.end());
          call.on('error', () => undefined);
        },
      }
    );
    port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
        error ? reject(error) : resolve(bound)
      )
    );
    client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
      'grpc.max_send_message_length': 64 * 1024 * 1024,
    });
  });

  afterAll(() => {
    client.close();
    server.forceShutdown();
  });

  const callUnary = (size: number) =>
    new Promise<{ code: number } | { size: number }>((resolve) => {
      client.makeUnaryRequest(
        unary.path,
        identity,
        identity,
        Buffer.alloc(size, 1),
        (error: grpc.ServiceError | null, response?: Buffer) =>
          resolve(error ? { code: error.code } : { size: Number(response!.toString()) })
      );
    });

  it('answers a unary request below the limit', async () => {
    expect(await callUnary(ANONYMOUS_MAX_MESSAGE_BYTES - 1024)).toEqual({ size: ANONYMOUS_MAX_MESSAGE_BYTES - 1024 });
  });

  it('rejects a unary request above 1 MiB before it is buffered', async () => {
    const outcome = await callUnary(ANONYMOUS_MAX_MESSAGE_BYTES + 1);
    expect(outcome).toHaveProperty('code');
    expect((outcome as { code: number }).code).not.toBe(grpc.status.OK);
  });

  it('also bounds the decompressed size: a small gzip message cannot expand past 1 MiB', async () => {
    const gzipClient = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
      'grpc.default_compression_algorithm': grpc.compressionAlgorithms.gzip,
      'grpc.max_send_message_length': 64 * 1024 * 1024,
    });
    const send = (size: number) =>
      new Promise<{ code: number } | { size: number }>((resolve) => {
        gzipClient.makeUnaryRequest(
          unary.path,
          identity,
          identity,
          Buffer.alloc(size, 0),
          (error: grpc.ServiceError | null, response?: Buffer) =>
            resolve(error ? { code: error.code } : { size: Number(response!.toString()) })
        );
      });
    try {
      // 8 MiB of zeros is a few KiB on the wire, far below the length-prefix check.
      expect(await send(8 * 1024 * 1024)).toEqual({ code: grpc.status.RESOURCE_EXHAUSTED });
      expect(await send(1000)).toEqual({ size: 1000 });
    } finally {
      gzipClient.close();
    }
  });

  it('holds a stream without a verified client certificate to 1 MiB too', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const call = client.makeBidiStreamRequest(bidi.path, identity, identity);
      call.on('data', (message: Buffer) => resolve(`data:${message.toString()}`));
      call.on('error', (error: grpc.ServiceError) => resolve(`error:${error.code}`));
      call.write(Buffer.alloc(ANONYMOUS_MAX_MESSAGE_BYTES + 1, 1));
      call.end();
    });
    expect(outcome.startsWith('error:')).toBe(true);
  });

  it('answers a small message on a stream', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const call = client.makeBidiStreamRequest(bidi.path, identity, identity);
      call.on('data', (message: Buffer) => resolve(`data:${message.toString()}`));
      call.on('error', (error: grpc.ServiceError) => resolve(`error:${error.code}`));
      call.write(Buffer.alloc(1000, 1));
      call.end();
    });
    expect(outcome).toBe('data:1000');
  });
});

describe('receive limit of a call with a client certificate', () => {
  const BIG = 512 * 1024 * 1024;
  const callOf = (authorized: boolean | undefined) => ({
    decoder: { maxReadMessageLength: BIG },
    maxReceiveMessageSize: BIG,
    stream: { session: { socket: { authorized, getPeerCertificate: () => ({}) } } },
  });
  const limitFor = (descriptor: { requestStream: boolean }, call: ReturnType<typeof callOf>) => {
    receiveLimitInterceptor(BIG)(descriptor as never, call as never);
    // The decoder checks the wire size, the call the decompressed size: both follow the same limit.
    expect(call.maxReceiveMessageSize).toBe(call.decoder.maxReadMessageLength);
    return call.decoder.maxReadMessageLength;
  };

  it('keeps the large limit for a stream whose client certificate was verified', () => {
    expect(limitFor({ requestStream: true }, callOf(true))).toBe(BIG);
  });

  it.each([false, undefined])('narrows a stream whose client certificate is not verified (%s)', (authorized) => {
    expect(limitFor({ requestStream: true }, callOf(authorized))).toBe(ANONYMOUS_MAX_MESSAGE_BYTES);
  });

  it('narrows a unary call even with a verified certificate', () => {
    expect(limitFor({ requestStream: false }, callOf(true))).toBe(ANONYMOUS_MAX_MESSAGE_BYTES);
  });
});
