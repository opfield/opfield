import { AppError } from '@/middleware/error-handler.js';
import { getAuditRequestContext } from '@/modules/audit/audit-request-context.js';

/** Same code as `IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN` in auth.middleware.ts. */
const IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN = 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN';

type ToolArgs = Record<string, unknown>;

/** Certificate export formats that carry the private key (see ExportCertificateQuerySchema). */
const PRIVATE_KEY_EXPORT_FORMATS: ReadonlySet<unknown> = new Set(['pkcs12', 'jks', 'private-key', 'pem-bundle']);

/**
 * AI tool calls that mint, widen or reveal a credential that outlives the
 * impersonated session. Impersonation lets an administrator act as another
 * user for that session only (see `assertNotImpersonating`), so these are
 * refused while the audit context shows impersonation. Tools run inside the
 * websocket or HTTP audit context, so the check also covers commercial tools.
 */
const CREDENTIAL_TOOL_CALLS: Readonly<Record<string, (args: ToolArgs) => boolean>> = {
  // The API token routes refuse all token management while impersonating.
  manage_api_token: () => true,
  // Widening an OAuth grant extends its refresh token.
  manage_oauth_authorization: (args) => args.operation === 'update_scopes' || args.operation === 'update',
  manage_inference_token: (args) => args.operation === 'create' || args.operation === 'update',
  // Returns a node enrollment token.
  create_node: () => true,
  manage_node: (args) => args.operation === 'regenerate_enrollment_token',
  // Returns a single-use relay re-enrollment token.
  manage_relay_pool: (args) => args.operation === 'reenroll_instance',
  manage_pages: (args) => args.operation === 'token_create',
  manage_logging: (args) => args.resource === 'token' && args.operation === 'create',
  // Imported keys outlive the session like created ones.
  manage_managed_storage: (args) =>
    args.action === 'create_access_key' || args.action === 'import_access_keys' || args.action === 'reveal_credentials',
  // Mirrors the storage reveal route, which also refuses impersonation.
  manage_storage_connection: (args) => args.action === 'reveal_credentials',
  manage_database_connection: (args) => args.operation === 'reveal_credentials',
  // Rotation returns the new direct-access password.
  manage_managed_database: (args) =>
    args.operation === 'reveal_credentials' ||
    args.operation === 'rotate_credentials' ||
    args.operation === 'reveal_binding_credentials',
  // Docker webhook rows carry the trigger token; a revealed secret list carries the values.
  manage_docker_container_config: (args) =>
    args.operation === 'get_webhook' ||
    args.operation === 'upsert_webhook' ||
    args.operation === 'regenerate_webhook_token' ||
    (args.operation === 'list_secrets' && Boolean(args.reveal)),
  // An exported container archive with includeSecrets carries the secret values.
  download_docker_archive: (args) =>
    (args.operation === 'begin' || args.operation === 'link') && args.includeSecrets === true,
  gitlab_create_deploy_token: () => true,
  // Issuance generates the certificate's private key.
  issue_certificate: () => true,
  manage_certificate: (args) => args.operation === 'export' && PRIVATE_KEY_EXPORT_FORMATS.has(args.format),
  // Exports the CA signing key.
  manage_ca: (args) => args.operation === 'export_key',
  // The configuration export carries the master key, every CA key and every secret; moving Opfield
  // redirects every node. Both mirror the routes, which refuse impersonation.
  manage_configuration_export: (args) =>
    args.operation === 'export' || args.operation === 'announce_move' || args.operation === 'withdraw_move',
};

export function isImpersonationBlockedToolCall(toolName: string, args: ToolArgs): boolean {
  return CREDENTIAL_TOOL_CALLS[toolName]?.(args) ?? false;
}

export function assertToolCallAllowedUnderImpersonation(toolName: string, args: ToolArgs): void {
  if (!getAuditRequestContext()?.impersonation) return;
  if (!isImpersonationBlockedToolCall(toolName, args)) return;
  throw new AppError(
    403,
    IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN,
    'This action creates or reveals a long-lived credential and is unavailable while impersonating'
  );
}
