import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterEach, describe, expect, it } from 'vitest';
import { legacyGrpcServiceDefinition } from './legacy-service-names.js';

const PROTO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../proto/opfield/v1/nginx-daemon.proto');

function loadOpfieldV1() {
  const definition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  });
  return (grpc.loadPackageDefinition(definition) as any).opfield.v1;
}

describe('gRPC service names', () => {
  let server: grpc.Server | null = null;
  const clients: grpc.Client[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    server?.forceShutdown();
    server = null;
  });

  it('maps every opfield.v1 method to its gateway.v1 path', () => {
    const opfieldV1 = loadOpfieldV1();
    for (const serviceName of [
      'NodeEnrollment',
      'NodeControl',
      'LogStream',
      'MigrationTransfer',
      'MaintenanceAccess',
    ]) {
      const service = opfieldV1[serviceName].service as grpc.ServiceDefinition;
      const legacy = legacyGrpcServiceDefinition(service);
      expect(Object.keys(legacy)).toEqual(Object.keys(service));
      for (const [method, definition] of Object.entries(service)) {
        expect(definition.path).toBe(`/opfield.v1.${serviceName}/${method}`);
        expect(legacy[method]!.path).toBe(`/gateway.v1.${serviceName}/${method}`);
        expect(legacy[method]!.requestDeserialize).toBe(definition.requestDeserialize);
        expect(legacy[method]!.responseSerialize).toBe(definition.responseSerialize);
      }
    }
  });

  it('answers a 2.12.0 daemon calling gateway.v1 and a 2.12.1 daemon calling opfield.v1', async () => {
    const opfieldV1 = loadOpfieldV1();
    const service = opfieldV1.NodeEnrollment.service as grpc.ServiceDefinition;
    const seen: string[] = [];
    const implementation = {
      Enroll: (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
        seen.push(call.getPath());
        callback(null, { nodeId: `node-for-${call.request.token}` });
      },
      RenewCertificate: (_call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) =>
        callback({ code: grpc.status.UNIMPLEMENTED }),
    };
    const current = new grpc.Server();
    server = current;
    current.addService(service, implementation);
    current.addService(legacyGrpcServiceDefinition(service), implementation);
    const port = await new Promise<number>((resolvePort, reject) =>
      current.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) =>
        err ? reject(err) : resolvePort(bound)
      )
    );

    const enroll = async (servicePath: string, token: string) => {
      const Client = grpc.makeGenericClientConstructor(
        { Enroll: { ...service.Enroll!, path: `${servicePath}/Enroll` } },
        'NodeEnrollment'
      );
      const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
      clients.push(client);
      return new Promise<any>((resolveCall, reject) =>
        (client as any).Enroll({ token }, (err: Error | null, response: any) =>
          err ? reject(err) : resolveCall(response)
        )
      );
    };

    await expect(enroll('/gateway.v1.NodeEnrollment', 'old')).resolves.toMatchObject({ nodeId: 'node-for-old' });
    await expect(enroll('/opfield.v1.NodeEnrollment', 'new')).resolves.toMatchObject({ nodeId: 'node-for-new' });
    expect(seen).toEqual(['/gateway.v1.NodeEnrollment/Enroll', '/opfield.v1.NodeEnrollment/Enroll']);
  });
});
