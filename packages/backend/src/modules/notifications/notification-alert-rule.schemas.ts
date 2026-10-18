import { z } from 'zod';
import { ALERT_CATEGORY_IDS } from './notification-catalog.js';

const alertCategorySchema = z.enum(ALERT_CATEGORY_IDS);

/**
 * Certificate expiry is checked once a day (and on certificate changes). A fire or resolve window
 * shorter than the check interval can never be covered by samples, so such rules act on every check.
 */
export function isOnceADayAlertRule(rule: {
  type?: string | null;
  category?: string | null;
  metric?: string | null;
}): boolean {
  return rule.type === 'threshold' && rule.category === 'certificate' && rule.metric === 'days_until_expiry';
}

export const ONCE_A_DAY_ALERT_WINDOWS = {
  durationSeconds: 0,
  fireThresholdPercent: 100,
  resolveAfterSeconds: 0,
  resolveThresholdPercent: 100,
} as const;

export const AlertRuleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  type: z.enum(['threshold', 'event']).optional(),
  category: alertCategorySchema.optional(),
  enabled: z.coerce.boolean().optional(),
  search: z.string().optional(),
  /** Only the rules in this folder (not its subfolders). */
  folderId: z.string().uuid().optional(),
});

export type AlertRuleListQuery = z.infer<typeof AlertRuleListQuerySchema>;

/** A date-time filter whose error names the expected format instead of a bare "Invalid date". */
function alertListDate(field: string) {
  return z.coerce.date({
    errorMap: () => ({
      message: `${field}: expected an ISO 8601 date-time such as 2026-10-17T00:00:00Z (or a date such as 2026-10-17)`,
    }),
  });
}

/**
 * Alerts that fired: what fires now (status firing, the default) and the history (resolved; kept 30 days). An event
 * rule records each occurrence resolved at once. since and until bound firedAt.
 */
export const AlertListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['firing', 'resolved', 'all']).default('firing'),
  ruleId: z.string().uuid().optional(),
  category: alertCategorySchema.optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  resourceType: z.string().max(50).optional(),
  resourceId: z.string().max(255).optional(),
  since: alertListDate('since').optional(),
  until: alertListDate('until').optional(),
  search: z.string().max(255).optional(),
});

export type AlertListQuery = z.infer<typeof AlertListQuerySchema>;

export const CreateAlertRuleSchema = z
  .object({
    name: z.string().min(1).max(255),
    // Active unless told otherwise, as the UI and the AI tools create rules.
    enabled: z.boolean().default(true),
    type: z.enum(['threshold', 'event']),
    category: alertCategorySchema,
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),

    // Threshold
    metric: z.string().max(100).optional(),
    metricTarget: z.string().max(255).nullable().optional(),
    operator: z.enum(['>', '>=', '<', '<=']).optional(),
    thresholdValue: z.number().optional(),
    durationSeconds: z.number().int().min(0).default(0),
    fireThresholdPercent: z.number().int().min(0).max(100).default(100),
    resolveAfterSeconds: z.number().int().min(0).default(60),
    resolveThresholdPercent: z.number().int().min(0).max(100).default(100),

    // Event
    eventPattern: z.string().max(255).optional(),

    // Scope
    resourceIds: z.array(z.string()).default([]),

    // Message template
    messageTemplate: z.string().max(4096).optional(),
    // Sent when the alert resolves; empty uses Opfield's resolve text for the rule
    resolveMessageTemplate: z.string().max(4096).nullable().optional(),

    // Webhooks to deliver to
    webhookIds: z.array(z.string().uuid()).default([]),

    // Cooldown
    cooldownSeconds: z.number().int().min(0).default(900),

    /** Destination folder (null or omitted: ungrouped); needs notifications:alerts:manage there. */
    folderId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'threshold') {
        return !!data.metric && !!data.operator && data.thresholdValue !== undefined;
      }
      return true;
    },
    { message: 'Threshold rules require metric, operator, and thresholdValue' }
  )
  .refine(
    (data) => {
      if (data.type === 'event') {
        return !!data.eventPattern;
      }
      return true;
    },
    { message: 'Event rules require eventPattern' }
  )
  .refine(
    (data) =>
      data.category !== 'hosting_account' ||
      data.type !== 'threshold' ||
      (/^[A-Z]{3}$/.test(data.metricTarget ?? '') && ['balance', 'monthly_expenses'].includes(data.metric ?? '')),
    {
      message:
        'Hosting account thresholds require a valid metric and an explicit three-letter currency in metricTarget',
    }
  );

export type CreateAlertRuleInput = z.infer<typeof CreateAlertRuleSchema>;

export const UpdateAlertRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  metric: z.string().max(100).optional(),
  metricTarget: z.string().max(255).nullable().optional(),
  operator: z.enum(['>', '>=', '<', '<=']).optional(),
  thresholdValue: z.number().optional(),
  durationSeconds: z.number().int().min(0).optional(),
  fireThresholdPercent: z.number().int().min(0).max(100).optional(),
  resolveAfterSeconds: z.number().int().min(0).optional(),
  resolveThresholdPercent: z.number().int().min(0).max(100).optional(),
  eventPattern: z.string().max(255).optional(),
  resourceIds: z.array(z.string()).optional(),
  messageTemplate: z.string().max(4096).optional(),
  resolveMessageTemplate: z.string().max(4096).nullable().optional(),
  webhookIds: z.array(z.string().uuid()).optional(),
  cooldownSeconds: z.number().int().min(0).optional(),
});

export type UpdateAlertRuleInput = z.infer<typeof UpdateAlertRuleSchema>;
