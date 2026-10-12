/**
 * Plain words for the cloud link's audit entries (resource type `cloud-link`): the resource is the Opfield account
 * the installation is linked to, never the agent id, and each entry gets a one-line description from its details.
 */
export const CLOUD_AUDIT_RESOURCE_LABEL = 'Opfield account';
/** Kept here too so the audit log reads it without loading the cloud link service. */
export const CLOUD_AUDIT_RESOURCE_TYPE = 'cloud-link';

type Details = Record<string, unknown> | null | undefined;

const REQUEST_LABELS: Record<string, string> = {
  state: 'Read state',
  services: 'Read services',
  logs: 'Read logs',
  'update-status': 'Read update status',
  'setup-link': 'Issue setup code',
  'node-token': 'Issue node token',
  update: 'Start update',
  'sso-secret': 'Replace sign-in client secret',
};

const MANAGED_SSO_STEPS: Record<string, string> = {
  public_url: 'Public URL set',
  provider: 'Opfield account sign-in provider set',
  owner: 'Owner made administrator',
  setup_complete: 'Setup completed',
  client_replaced: 'Sign-in client secret replaced',
  client_kept: 'New Opfield account client kept; the chosen sign-in stays',
  client_requested: 'Asked the Opfield account for a sign-in client',
  client_request_cancelled: 'Request for a sign-in client cancelled',
  client_received: 'Opfield account sign-in set up from the cloud account',
  client_forgotten: 'Opfield account client forgotten: the cloud link ended',
  provider_removed: 'Opfield account sign-in removed: the cloud link ended',
  provider_kept: 'Opfield account sign-in kept after the cloud link ended: no other administrator could sign in',
  secret_rotated: 'Sign-in client secret replaced',
  secret_removed: 'Client secret removed from the enrolment file',
};

const CONNECT_SOURCES: Record<string, string> = {
  settings: 'with a code',
  'connect-code': 'with a connect code',
  'enroll-file': 'from the enrolment file',
};

function text(details: Details, key: string): string | null {
  const value = details?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(details: Details, key: string): number | null {
  const value = details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function failure(details: Details): string {
  return text(details, 'errorCode') ?? text(details, 'error') ?? 'error';
}

/** "Opfield account · owner@example.com", or just "Opfield account" when the account is not known. */
export function cloudAuditResourceName(accountEmail: string | null | undefined): string {
  const email = accountEmail?.trim();
  return email ? `${CLOUD_AUDIT_RESOURCE_LABEL} · ${email}` : CLOUD_AUDIT_RESOURCE_LABEL;
}

function requestSummary(details: Details): string {
  const type = text(details, 'type') ?? 'unknown';
  const parts = [REQUEST_LABELS[type] ?? `Request ${type}`];
  const service = text(details, 'service');
  if (service) parts.push(service);
  const summary = details?.summary as { count?: unknown; windowStartedAt?: unknown; lastAt?: unknown } | undefined;
  if (summary && typeof summary === 'object' && typeof summary.count === 'number') {
    const started = Date.parse(String(summary.windowStartedAt ?? ''));
    const last = Date.parse(String(summary.lastAt ?? ''));
    const minutes =
      Number.isFinite(started) && Number.isFinite(last) ? Math.max(1, Math.ceil((last - started) / 60_000)) : null;
    parts.push(`${summary.count} ${summary.count === 1 ? 'read' : 'reads'}${minutes ? ` in ${minutes} min` : ''}`);
    return parts.join(' · ');
  }
  const tail = number(details, 'tail');
  if (tail !== null) parts.push(`last ${tail} lines`);
  const since = text(details, 'since');
  if (since) parts.push(`since ${since}`);
  const name = text(details, 'name');
  if (name) parts.push(name);
  const version = text(details, 'version');
  if (version) parts.push(version);
  if (details?.ok === false) parts.push(`failed: ${failure(details)}`);
  return parts.join(' · ');
}

/** One plain line for a cloud link audit entry; null for an action this does not know. */
export function cloudAuditSummary(action: string, details: Details): string | null {
  switch (action) {
    case 'cloud.request':
      return requestSummary(details);
    case 'cloud.connect': {
      if (details?.success === false) return `Connect failed: ${failure(details)}`;
      const email = text(details, 'accountEmail');
      const source = CONNECT_SOURCES[text(details, 'source') ?? ''] ?? null;
      return ['Connected', email ? `to ${email}` : null, source].filter(Boolean).join(' ');
    }
    case 'cloud.connect_code': {
      const outcome = text(details, 'outcome') ?? 'unknown';
      if (outcome === 'requested') return 'Connect code requested';
      if (outcome === 'cancelled') return 'Connect code cancelled';
      if (outcome === 'expired') return 'Connect code expired';
      if (outcome === 'request_failed') return `Connect code request failed: ${failure(details)}`;
      return `Connect code ${outcome.replace(/_/g, ' ')}: ${failure(details)}`;
    }
    case 'cloud.disconnect':
      if (details?.success === false) return `Disconnect refused: ${failure(details)}`;
      if (details?.wasConnected === false) return 'Disconnected (was not connected)';
      return details?.confirmedByAccount === false ? 'Disconnected · not confirmed by the account' : 'Disconnected';
    case 'cloud.disconnected_by_account':
      return 'Disconnected by the account';
    case 'cloud.remote_management':
      return details?.enabled === true ? 'Remote management allowed' : 'Remote management turned off';
    case 'cloud.enroll_file': {
      const outcome = text(details, 'outcome');
      if (outcome === 'settled') {
        return details?.removed === true ? 'Enrolment file applied and removed' : 'Enrolment file applied, not removed';
      }
      if (outcome === 'unreadable') return 'Enrolment file unreadable';
      return `Enrolment file: ${outcome ?? 'unknown'}`;
    }
    case 'cloud.managed_sso': {
      const step = text(details, 'step') ?? 'unknown';
      if (step === 'skipped')
        return `Sign-in setup skipped${text(details, 'reason') ? `: ${text(details, 'reason')}` : ''}`;
      if (step === 'failed') return 'Sign-in setup failed';
      return MANAGED_SSO_STEPS[step] ?? `Sign-in setup: ${step.replace(/_/g, ' ')}`;
    }
    default:
      return null;
  }
}
