/**
 * When the console certificate (Let's Encrypt, HTTP-01) is renewed and how failed attempts are retried. Pure
 * functions: ConsoleTlsService applies them to its clock and timers.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A certificate is renewed with 30 days left, or with a third of its lifetime left when it lives under 90 days. */
export const RENEW_BEFORE_MS = 30 * DAY_MS;
/** The longest a single timer waits before the state is checked again (timers cannot wait ~25 days or more). */
export const MAX_CHECK_INTERVAL_MS = 6 * HOUR_MS;
/** Retries of a failed order: 2 min, doubling, at most 3 h apart (Let's Encrypt limits failed validations). */
export const ORDER_RETRY_BASE_MS = 2 * MINUTE_MS;
export const ORDER_RETRY_MAX_MS = 3 * HOUR_MS;
/** While the domain does not reach this installation yet (DNS pending), the reachability probe repeats this often. */
export const PROBE_RETRY_BASE_MS = 15 * 1000;
export const PROBE_RETRY_MAX_MS = 2 * MINUTE_MS;
/**
 * A probe that fails does not stop orders for good: a host that cannot reach its own public address (no hairpin
 * NAT) still orders this often, and Let's Encrypt decides.
 */
export const UNPROBED_ORDER_INTERVAL_MS = 30 * MINUTE_MS;
/** Failing renewals are raised as an alert from this many days left; failing first issuance after this long. */
export const ALERT_REMAINING_MS = 14 * DAY_MS;
export const CRITICAL_REMAINING_MS = 7 * DAY_MS;
export const ALERT_FIRST_ISSUANCE_AFTER_MS = 6 * HOUR_MS;
export const ALERT_REPEAT_MS = 20 * HOUR_MS;

export interface CertificateValidity {
  notBefore: Date;
  notAfter: Date;
}

/** When renewal starts: 30 days before the end, or a third of the lifetime before it for shorter certificates. */
export function renewalDueAt({ notBefore, notAfter }: CertificateValidity): Date {
  const lifetime = Math.max(0, notAfter.getTime() - notBefore.getTime());
  return new Date(notAfter.getTime() - Math.min(RENEW_BEFORE_MS, lifetime / 3));
}

export function isRenewalDue(certificate: CertificateValidity, now: Date): boolean {
  return now.getTime() >= renewalDueAt(certificate).getTime();
}

/** How long until the next check of a certificate that is not due: at its renewal time, at most MAX_CHECK_INTERVAL. */
export function nextCheckDelayMs(certificate: CertificateValidity, now: Date): number {
  const untilDue = renewalDueAt(certificate).getTime() - now.getTime();
  return Math.max(0, Math.min(untilDue, MAX_CHECK_INTERVAL_MS));
}

/** Wait before the next order after `failures` consecutive failed ones (1 = the first failure). */
export function orderRetryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(ORDER_RETRY_MAX_MS, ORDER_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 20));
}

/** Wait before the next reachability probe after `failures` consecutive failed ones. */
export function probeRetryDelayMs(failures: number): number {
  if (failures <= 0) return PROBE_RETRY_BASE_MS;
  return Math.min(PROBE_RETRY_MAX_MS, PROBE_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 20));
}

/**
 * Whether to place an order now. Never before the backoff of the last failure ends; then when the domain reached
 * this installation's challenge listener, or when the last order is long enough ago (the probe may fail where
 * Let's Encrypt would succeed).
 */
export function shouldOrder(input: {
  now: Date;
  probeReachable: boolean;
  lastOrderAt: Date | null;
  nextOrderAllowedAt: Date | null;
}): boolean {
  const now = input.now.getTime();
  if (input.nextOrderAllowedAt && now < input.nextOrderAllowedAt.getTime()) return false;
  if (input.probeReachable) return true;
  return !input.lastOrderAt || now - input.lastOrderAt.getTime() >= UNPROBED_ORDER_INTERVAL_MS;
}

export type ConsoleTlsAlertLevel = 'warning' | 'critical' | null;

/**
 * Whether failing issuance deserves an alert: the served certificate ends within 14 days (critical within 7), or no
 * certificate was obtained for 6 hours since the first failure.
 */
export function failureAlertLevel(input: {
  now: Date;
  certificate: CertificateValidity | null;
  failingSince: Date | null;
}): ConsoleTlsAlertLevel {
  const now = input.now.getTime();
  if (input.certificate) {
    const remaining = input.certificate.notAfter.getTime() - now;
    if (remaining <= CRITICAL_REMAINING_MS) return 'critical';
    if (remaining <= ALERT_REMAINING_MS) return 'warning';
    return null;
  }
  if (input.failingSince && now - input.failingSince.getTime() >= ALERT_FIRST_ISSUANCE_AFTER_MS) return 'warning';
  return null;
}

/** A plain DNS name a public CA issues for: no wildcard, IP address, port or trailing dot. */
export function isValidConsoleDomain(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) return false;
  if (/^[0-9.]+$/.test(value)) return false;
  return value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/** The ACME directory: an explicit URL, "staging" for the Let's Encrypt staging CA, or undefined for production. */
export function resolveDirectoryOverride(value: string | undefined): { staging: boolean; directoryUrl?: string } {
  const trimmed = value?.trim();
  if (!trimmed) return { staging: false };
  if (trimmed.toLowerCase() === 'staging') return { staging: true };
  if (trimmed.toLowerCase() === 'production') return { staging: false };
  const url = new URL(trimmed);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('GATEWAY_ACME_DIRECTORY_URL must be an http(s) URL, "staging" or "production"');
  }
  return { staging: false, directoryUrl: url.toString() };
}
