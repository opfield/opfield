import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import {
  INFERENCE_CORE_CALLBACK_HEADERS,
  INFERENCE_CORE_CALLBACK_PATHS,
  inferenceCoreAdmissionRequestSchema,
  inferenceCoreSettlementSchema,
  LEGACY_INFERENCE_CORE_CALLBACK_HEADERS,
  OPFIELD_CORE_CONTRACT_ID,
} from './inference-core.contract.js';
import { InferenceCoreBridgeService } from './inference-core-bridge.service.js';

/** Freshness bound for callback signatures; outbox replays re-sign at send time. */
const CALLBACK_TIMESTAMP_SKEW_SECONDS = 60;

/**
 * Internal core → Gateway callback listener (admission + settlement). Served
 * on a dedicated port that is never published to the host: only containers on
 * the installer-managed Compose network can reach it, and every call must
 * carry a valid HMAC signature keyed by the internal callback credential.
 */
export const inferenceCoreInternalRoutes = new Hono<AppEnv>();

inferenceCoreInternalRoutes.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json({ code: error.code, message: error.message }, error.statusCode as never);
  }
  return errorHandler(error, c);
});

/** Verify contract + timestamp + HMAC(`${timestamp}.${body}`) and return the raw body. */
async function verifyCallback(c: {
  req: {
    header(name: string): string | undefined;
    text(): Promise<string>;
  };
}): Promise<string> {
  // legacy-name: a core released before the Opfield names signs with x-wiolett-* only.
  const header = (name: keyof typeof INFERENCE_CORE_CALLBACK_HEADERS) =>
    (
      c.req.header(INFERENCE_CORE_CALLBACK_HEADERS[name]) ?? c.req.header(LEGACY_INFERENCE_CORE_CALLBACK_HEADERS[name])
    )?.trim();
  const contract = header('contract');
  if (contract !== OPFIELD_CORE_CONTRACT_ID) {
    throw new AppError(401, 'callback_contract_mismatch', 'Unsupported callback contract');
  }
  const timestamp = header('timestamp');
  const signature = header('signature');
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
    throw new AppError(401, 'callback_signature_invalid', 'Callback signature is missing or malformed');
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skew > CALLBACK_TIMESTAMP_SKEW_SECONDS) {
    throw new AppError(401, 'callback_timestamp_stale', 'Callback timestamp is outside the allowed skew');
  }
  const body = await c.req.text();
  const credential = await container.resolve(InferenceCoreBridgeService).callbackCredential();
  const expected = createHmac('sha256', credential).update(`${timestamp}.${body}`).digest('base64url');
  const actualBytes = Buffer.from(signature, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new AppError(401, 'callback_signature_invalid', 'Callback signature is invalid');
  }
  return body;
}

inferenceCoreInternalRoutes.post(INFERENCE_CORE_CALLBACK_PATHS.admission, async (c) => {
  const body = await verifyCallback(c);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError(400, 'callback_malformed', 'Callback body is not valid JSON');
  }
  const admission = inferenceCoreAdmissionRequestSchema.safeParse(parsed);
  if (!admission.success) {
    throw new AppError(400, 'callback_malformed', 'Admission request failed contract validation');
  }
  const decision = await container.resolve(InferenceCoreAccountingService).admitCoreAttempt(admission.data);
  return c.json(decision);
});

inferenceCoreInternalRoutes.post(INFERENCE_CORE_CALLBACK_PATHS.settlement, async (c) => {
  const body = await verifyCallback(c);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError(400, 'callback_malformed', 'Callback body is not valid JSON');
  }
  const settlement = inferenceCoreSettlementSchema.safeParse(parsed);
  if (!settlement.success) {
    throw new AppError(400, 'callback_malformed', 'Settlement failed contract validation');
  }
  await container.resolve(InferenceCoreAccountingService).settleCoreAttempt(settlement.data);
  return c.json({ ok: true });
});
