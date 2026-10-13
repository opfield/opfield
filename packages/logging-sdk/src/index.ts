import { OpfieldLogger as LegacyLogger } from './logger.js';
import type * as Legacy from './types.js';
import { OpfieldLoggerHook as LegacyLoggerHook } from './types.js';

export { OpfieldLogger } from './logger.js';
export type {
  OpfieldBatchingOptions,
  OpfieldLog,
  OpfieldLogContext,
  OpfieldLogDropReason,
  OpfieldLogEvent,
  OpfieldLogFailureInfo,
  OpfieldLogFailureReason,
  OpfieldLoggerHooks,
  OpfieldLoggerMethods,
  OpfieldLoggerOptions,
  OpfieldLogOptions,
  OpfieldLogSeverity,
  OpfieldLogValue,
  OpfieldRetryOptions,
  OpfieldSpanContext,
  OpfieldSpanLogger,
  OpfieldTraceContext,
  OpfieldTraceLogger,
} from './types.js';
export { OpfieldLoggerHook } from './types.js';

// legacy-name: Gateway* names of @sqgateway/logger 1.x, kept as deprecated aliases so code moving to @opfield/logger
// only changes the import path — remove in @opfield/logger 3.0.

/** @deprecated Use OpfieldLogger. */
export const GatewayLogger = LegacyLogger;
/** @deprecated Use OpfieldLogger. */
export type GatewayLogger = LegacyLogger;
/** @deprecated Use OpfieldLoggerHook. */
export const GatewayLoggerHook = LegacyLoggerHook;
/** @deprecated Use OpfieldLoggerHook. */
export type GatewayLoggerHook = LegacyLoggerHook;
/** @deprecated Use OpfieldBatchingOptions. */
export type GatewayBatchingOptions = Legacy.OpfieldBatchingOptions;
/** @deprecated Use OpfieldLog. */
export type GatewayLog = Legacy.OpfieldLog;
/** @deprecated Use OpfieldLogContext. */
export type GatewayLogContext = Legacy.OpfieldLogContext;
/** @deprecated Use OpfieldLogDropReason. */
export type GatewayLogDropReason = Legacy.OpfieldLogDropReason;
/** @deprecated Use OpfieldLogEvent. */
export type GatewayLogEvent = Legacy.OpfieldLogEvent;
/** @deprecated Use OpfieldLogFailureInfo. */
export type GatewayLogFailureInfo = Legacy.OpfieldLogFailureInfo;
/** @deprecated Use OpfieldLogFailureReason. */
export type GatewayLogFailureReason = Legacy.OpfieldLogFailureReason;
/** @deprecated Use OpfieldLoggerHooks. */
export type GatewayLoggerHooks = Legacy.OpfieldLoggerHooks;
/** @deprecated Use OpfieldLoggerMethods. */
export type GatewayLoggerMethods = Legacy.OpfieldLoggerMethods;
/** @deprecated Use OpfieldLoggerOptions. */
export type GatewayLoggerOptions = Legacy.OpfieldLoggerOptions;
/** @deprecated Use OpfieldLogOptions. */
export type GatewayLogOptions = Legacy.OpfieldLogOptions;
/** @deprecated Use OpfieldLogSeverity. */
export type GatewayLogSeverity = Legacy.OpfieldLogSeverity;
/** @deprecated Use OpfieldLogValue. */
export type GatewayLogValue = Legacy.OpfieldLogValue;
/** @deprecated Use OpfieldRetryOptions. */
export type GatewayRetryOptions = Legacy.OpfieldRetryOptions;
/** @deprecated Use OpfieldSpanContext. */
export type GatewaySpanContext = Legacy.OpfieldSpanContext;
/** @deprecated Use OpfieldSpanLogger. */
export type GatewaySpanLogger = Legacy.OpfieldSpanLogger;
/** @deprecated Use OpfieldTraceContext. */
export type GatewayTraceContext = Legacy.OpfieldTraceContext;
/** @deprecated Use OpfieldTraceLogger. */
export type GatewayTraceLogger = Legacy.OpfieldTraceLogger;
