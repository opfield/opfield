/** Provider error bodies: only documented scalars leave the boundary, never provider input or bootstrap data. */

export function digitalOceanErrorMessage(body: string, token: string, status: number, fallback: string): string {
  try {
    const payload: unknown = JSON.parse(body);
    const message = payload && typeof payload === 'object' && 'message' in payload ? payload.message : undefined;
    if (typeof message !== 'string' || !message.trim() || message.length > 1024) return fallback;
    // Read one documented scalar, never reflect arbitrary provider dumps or echoed bootstrap data.
    if (
      (token && message.includes(token)) ||
      /gw_node_|dop_v1_|doo_v1_|dor_v1_|PVEAPIToken=|Bearer\s|-----BEGIN|user_data|cloud[-_ ]?init|#!|["']?(?:password|token|secret|privateKey)["']?\s*[:=]/i.test(
        message
      )
    )
      return fallback;
    const clean = message.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
    return `DigitalOcean: ${clean} (HTTP ${status}).${status === 403 ? ' Check API token scopes and team permissions.' : ''}`;
  } catch {
    return fallback;
  }
}

/** Read only documented scalars. Do not reflect provider input or bootstrap data. */
export function hetznerErrorMessage(body: string, status: number, fallback: string): string {
  try {
    const error = JSON.parse(body)?.error;
    const explanations: Record<string, string> = {
      resource_unavailable:
        'Selected server type or image is unavailable in this location. Choose another configuration',
      resource_limit_exceeded: 'The project resource limit has been reached. Check the Hetzner project limits',
      insufficient_funds: 'The Hetzner account has insufficient funds',
      server_type_not_supported: 'This server type is not supported in the selected location',
      invalid_input: 'Hetzner rejected the VM configuration',
      uniqueness_error: 'A resource with this identity already exists',
      conflict: 'The resource conflicts with an existing operation',
    };
    const code = typeof error?.code === 'string' ? error.code : '';
    const explanation = explanations[code];
    if (!explanation) return fallback;
    const allowedFields = new Set([
      'name',
      'location',
      'server_type',
      'image',
      'user_data',
      'labels',
      'ssh_keys',
      'networks',
      'public_net',
      'firewalls',
      'start_after_create',
    ]);
    const fields = Array.isArray(error.details?.fields)
      ? error.details.fields
          .map((field: { name?: unknown }) => field?.name)
          .filter((name: unknown) => typeof name === 'string' && allowedFields.has(name))
      : [];
    return `Hetzner: ${explanation}${fields.length ? `; check ${[...new Set(fields)].join(', ')}` : ''} (${code}, HTTP ${status}).`;
  } catch {
    return fallback;
  }
}

const CLOUDBLAST_EXPLANATIONS: Record<string, string> = {
  UNAUTHENTICATED: 'The API token is missing or malformed',
  INVALID_TOKEN: 'The API token does not match a CloudBlast account',
  ACCOUNT_BANNED: 'The CloudBlast account is suspended',
  IP_NOT_ALLOWED: 'The Opfield outbound IP is not in the CloudBlast API whitelist',
  NOT_FOUND: 'The requested CloudBlast resource was not found',
  SERVER_STATUS_CONFLICT: 'The server is busy installing, restoring or running another task. Wait and retry',
  NO_AVAILABLE_NODE: 'No node in this location has capacity for the selected plan and template',
  RESOURCE_LIMIT_EXCEEDED: 'The account CPU or RAM limit has been reached',
  OVERDUE_INVOICE: 'The account has an overdue invoice. Pay it in CloudBlast first',
  PLAN_UNAVAILABLE: 'The selected plan is not available',
  PLAN_OUT_OF_STOCK: 'The selected plan is out of stock',
  NEW_USERS_ONLY: 'The selected plan is restricted to first-time customers',
  TEMPLATE_NOT_FOUND: 'The selected OS template is not available on the server node',
  HAS_SERVERS: 'Detach all servers before deleting the security group',
  ALREADY_ATTACHED: 'The server is already attached to this security group',
  RATE_LIMITED: 'Too many requests of this kind. Wait before retrying',
  VALIDATION_ERROR: 'CloudBlast rejected the request',
};
const CLOUDBLAST_FIELDS = new Set([
  'name',
  'hostname',
  'plan_id',
  'location_id',
  'template_slug',
  'action',
  'mode',
  'compression_type',
  'description',
  'type',
  'protocol',
  'source',
  'destination',
  'source_port',
  'destination_port',
  'priority',
  'server_uuid',
]);

/** CloudBlast: `{ error: { code, message, details } }`. Messages are never reflected. */
export function cloudBlastErrorMessage(body: string, status: number, fallback: string): string {
  try {
    const error = JSON.parse(body)?.error;
    const code = typeof error?.code === 'string' ? error.code : '';
    const explanation = Object.hasOwn(CLOUDBLAST_EXPLANATIONS, code) ? CLOUDBLAST_EXPLANATIONS[code] : undefined;
    if (!explanation) return fallback;
    const details = error.details && typeof error.details === 'object' ? Object.keys(error.details) : [];
    const fields = details.filter((field) => CLOUDBLAST_FIELDS.has(field));
    return `CloudBlast: ${explanation}${fields.length ? `; check ${fields.join(', ')}` : ''} (${code}, HTTP ${status}).`;
  } catch {
    return fallback;
  }
}
