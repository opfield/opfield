import type * as grpc from '@grpc/grpc-js';

export const GRPC_PACKAGE_PATH_PREFIX = '/opfield.v1.';
// legacy-name: the legacy gRPC package service names that 2.12.0 daemons call — remove once every node reports none
export const LEGACY_GRPC_PACKAGE_PATH_PREFIX = '/gateway.v1.';

/**
 * The same service under its gateway.v1 name. The package name is not part of
 * the protobuf wire encoding, so only the method paths differ.
 */
export function legacyGrpcServiceDefinition(service: grpc.ServiceDefinition): grpc.ServiceDefinition {
  return Object.fromEntries(
    Object.entries(service).map(([name, method]) => {
      if (!method.path.startsWith(GRPC_PACKAGE_PATH_PREFIX)) {
        throw new Error(`gRPC method ${method.path} is outside ${GRPC_PACKAGE_PATH_PREFIX}`);
      }
      return [
        name,
        { ...method, path: `${LEGACY_GRPC_PACKAGE_PATH_PREFIX}${method.path.slice(GRPC_PACKAGE_PATH_PREFIX.length)}` },
      ];
    })
  );
}
