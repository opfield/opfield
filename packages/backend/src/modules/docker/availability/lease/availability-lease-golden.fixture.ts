import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

/** Fixed ids, keys and time of the golden lease host scenario (availability-lease-golden.database.test.ts). */
export const goldenId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const KEY_ID = goldenId(1);
export const NEXT_KEY_ID = goldenId(2);
export const LOCAL_RELAY = goldenId(10);
export const REMOTE_RELAY = goldenId(11);
export const NODES = [goldenId(20), goldenId(21), goldenId(22)] as const;
export const NGINX = goldenId(23);
export const POLICY = goldenId(30);
export const MEMBER_LINK = goldenId(40);
export const PROJECTION = goldenId(41);
export const T0 = Date.UTC(2031, 0, 1);

/** A fixed Ed25519 key from a seed: signatures are deterministic, so signed blocks are too. */
export function seededEd25519(fill: number) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, fill)]),
    format: 'der',
    type: 'pkcs8',
  });
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKey: Buffer.from(x, 'base64url') };
}

/** A fixed identity key per member (SPKI-shaped bytes; the host never parses them). */
export function identityOf(id: string): Buffer {
  const half = (suffix: string) => createHash('sha256').update(`${id}/${suffix}`).digest();
  return Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
    Buffer.from([4]),
    half('x'),
    half('y'),
  ]);
}

/** JSON with buffers as base64, maps as objects and sets as sorted arrays. */
export function normalizeGolden(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (entry && typeof entry === 'object' && entry.type === 'Buffer' && Array.isArray(entry.data)) {
        return Buffer.from(entry.data).toString('base64');
      }
      if (entry instanceof Map) return Object.fromEntries(entry);
      if (entry instanceof Set) return [...entry].sort();
      if (entry instanceof Uint8Array) return Buffer.from(entry).toString('base64');
      return entry;
    })
  );
}

type Query = (text: string, values?: unknown[]) => Promise<unknown>;

/**
 * The scenario's install: a policy signing key, a local and a remote relay, three Docker candidates and an ingress
 * nginx node, a failover policy with one serving and two standby placements, its member Secure Link (carried by the
 * local relay) and a managed-database binding projection of the serving placement.
 */
export async function seedGoldenDatabase(q: Query, policyKeyPublic: Buffer): Promise<void> {
  const id = goldenId;
  await q(
    `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
       encrypted_dek, status, activated_at, created_at) values ($1, $2, $3, 'held', 'held', 'active', $4, $4)`,
    [
      KEY_ID,
      policyKeyPublic.toString('base64'),
      `sha256:${createHash('sha256').update(policyKeyPublic).digest('hex')}`,
      new Date(T0 - 86_400_000),
    ]
  );
  await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
  const features = JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', 'availability_lease_v2'] });
  await q(
    `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
     values ($1, 'system', 'local', $2, 'local', 'ready', $3)`,
    [LOCAL_RELAY, id(12), features]
  );
  await q(
    `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities,
       advertised_addresses, service_port, certificate_identity, certificate_fingerprint)
     values ($1, 'system', 'remote', $2, 'remote', 'ready', $3, $4, 9443, 'relay.test', 'sha256:relay')`,
    [REMOTE_RELAY, id(13), features, ['192.0.2.9']]
  );
  for (const [index, nodeId] of [...NODES, NGINX].entries()) {
    await q(
      `insert into nodes (id, type, hostname, slug, status, host_identity_id, capabilities, last_seen_at)
       values ($1, $2, $3, $3, 'online', $4, $5, $6)`,
      [
        nodeId,
        nodeId === NGINX ? 'nginx' : 'docker',
        `golden-node-${index}`,
        id(60 + index),
        JSON.stringify({ capabilities: ['availability_lease_v2'] }),
        new Date(T0),
      ]
    );
  }
  await q(
    `insert into docker_availability_policies (id, resource_kind, source_node_id, container_name, mode,
       desired_replica_count, status) values ($1, 'container', $2, 'app', 'failover', 1, 'healthy')`,
    [POLICY, NODES[0]]
  );
  for (const [index, nodeId] of NODES.entries()) {
    await q(
      `insert into docker_availability_placements (id, policy_id, node_id, generation, desired_state, actual_state,
         serving, spec_fingerprint, created_at) values ($1, $2, $3, 1, $4, $5, $6, 'spec', $7)`,
      [
        id(50 + index),
        POLICY,
        nodeId,
        index === 0 ? 'serving' : 'standby',
        index === 0 ? 'serving' : 'ready',
        index === 0,
        new Date(T0 - (3 - index) * 3_600_000),
      ]
    );
  }
  const user = id(70);
  await q('insert into permission_groups (id, name) values ($1, $2)', [id(71), 'lease-golden']);
  await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
    user,
    id(71),
    'golden@lease.test',
    'Lease golden',
  ]);
  await q(`insert into proxy_hosts (id, slug, created_by_id) values ($1, 'lease-golden', $2)`, [id(72), user]);
  await q(
    `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
       availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
       docker_host_port, target_container, status)
     values ($1, $2, 'member', 'availability_member', $3, $4, 'docker_container', $5, $6, 80, 8080, 'app', 'active')`,
    [MEMBER_LINK, id(72), id(50), `proxy-host:${id(72)}`, NGINX, NODES[0]]
  );
  await q(
    `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
       encrypted_owner_credentials, storage_size_bytes, published_port, created_by_id)
     values ($1, $2, 'db', 'db', 'postgres', '17', 'img', '{}', 'x', 1, null, $3)`,
    [id(73), NODES[2], user]
  );
  await q(
    `insert into managed_database_bindings (id, managed_database_id, target_node_id, target_type, target_resource_id,
       network_name, connector_name, connector_alias, environment, encrypted_credentials, created_by_id)
     values ($1, $2, $3, 'container', 'app', 'n', 'c', 'a', '{}', 'x', $4)`,
    [id(74), id(73), NODES[0], user]
  );
  await q(
    `insert into managed_database_binding_placements (id, binding_id, availability_placement_id, node_id,
       network_name, connector_name, connector_alias) values ($1, $2, $3, $4, 'n', 'c', 'a')`,
    [PROJECTION, id(74), id(50), NODES[0]]
  );
  // The member's Secure Link endpoint is carried by the local relay: a carrying relay must be lease-capable.
  await q(
    `insert into relay_endpoints (id, owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
     values ($1, 'proxy_host_secure_link', $2, 'node', $3, 'sha256:member')`,
    [id(80), MEMBER_LINK, NODES[0]]
  );
  await q(
    `insert into relay_endpoint_assignment_generations (id, endpoint_id, generation, state)
     values ($1, $2, 1, 'active')`,
    [id(81), id(80)]
  );
  await q(
    `insert into relay_endpoint_assignments (assignment_generation_id, relay_instance_id, role)
     values ($1, $2, 'primary')`,
    [id(81), LOCAL_RELAY]
  );
}
