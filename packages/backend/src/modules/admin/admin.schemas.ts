import { z } from 'zod';
import { isValidCidr } from '@/lib/ip-cidr.js';
import {
  FILE_OPEN_MAX_BYTES,
  FILE_OPEN_MIN_BYTES,
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_MIN_BYTES,
  isValidOpfieldHostPortTarget,
  isValidOpfieldIpPortTarget,
  normalizePublicUrl,
  RELAY_ASSIGNMENT_SPREAD_MAX_COUNT,
  RELAY_ASSIGNMENT_SPREAD_MIN_COUNT,
  RELAY_DATA_LANES_MAX,
  RELAY_DATA_LANES_MIN,
  RELAY_DATABASE_RESERVE_MAX_PERCENT,
  RELAY_DATABASE_RESERVE_MIN_PERCENT,
  RELAY_GRANT_TTL_MAX_HOURS,
  RELAY_GRANT_TTL_MIN_HOURS,
  RELAY_HARD_PRESSURE_MAX_PERCENT,
  RELAY_HARD_PRESSURE_MIN_PERCENT,
  RELAY_POLICY_LEASE_MAX_HOURS,
  RELAY_POLICY_LEASE_MIN_HOURS,
  RELAY_PROXY_TARGET_PRESSURE_MAX_PERCENT,
  RELAY_PROXY_TARGET_PRESSURE_MIN_PERCENT,
  RELAY_READ_CHUNK_BYTES_MAX,
  RELAY_READ_CHUNK_BYTES_MIN,
  SHUTDOWN_FINALIZATION_MAX_SECONDS,
  SHUTDOWN_FINALIZATION_MIN_SECONDS,
  SHUTDOWN_LOG_DRAIN_MAX_SECONDS,
  SHUTDOWN_TOTAL_MAX_SECONDS,
  SHUTDOWN_USER_DRAIN_MAX_SECONDS,
} from '@/modules/settings/general-settings.service.js';
import { CLIENT_IP_SOURCE_VALUES } from '@/modules/settings/network-settings.service.js';

export const CreateUserSchema = z
  .object({
    folderId: z.string().uuid().nullable().optional(),
    email: z.string().email().max(255),
    name: z.string().trim().min(1, 'Name is required').max(255),
    groupId: z.string().uuid().optional(),
    groupIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    authMethod: z.enum(['oidc', 'password', 'email_otp']).default('oidc'),
  })
  .refine((value) => Boolean(value.groupIds?.length || value.groupId), {
    message: 'Select at least one group',
    path: ['groupIds'],
  })
  .transform((value) => ({
    ...value,
    groupId: value.groupIds?.[0] ?? value.groupId!,
    groupIds: [...new Set(value.groupIds ?? [value.groupId!])],
  }));

export const UpdateUserGroupSchema = z
  .object({
    groupId: z.string().uuid().optional(),
    groupIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  })
  .refine((value) => Boolean(value.groupIds?.length || value.groupId), {
    message: 'Select at least one group',
    path: ['groupIds'],
  })
  .transform((value) => ({
    groupId: value.groupIds?.[0] ?? value.groupId!,
    groupIds: [...new Set(value.groupIds ?? [value.groupId!])],
  }));

export const UpdateUserAdditionalPermissionsSchema = z.object({
  additionalScopes: z.array(z.string().trim().min(1).max(512)).max(20000),
});

export const UpdateBlockSchema = z.object({
  blocked: z.boolean(),
});

export const RestoreUserSchema = z.object({
  groupId: z.string().uuid().optional(),
  groupIds: z.array(z.string().uuid()).min(1).max(100).optional(),
});

export const UpdateUserAuthMethodSchema = z.object({
  authMethod: z.enum(['oidc', 'password', 'email_otp']),
});

export const UpdateUserNameSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
});

const AuthMethodsSchema = z.object({
  oidc: z.boolean().optional(),
  password: z.boolean().optional(),
  emailOtp: z.boolean().optional(),
  passkeyLogin: z.boolean().optional(),
});

const PasswordPolicySchema = z.object({
  minLength: z.number().int().min(8).max(72).optional(),
  maxLength: z.number().int().min(8).max(72).optional(),
  requireUppercase: z.boolean().optional(),
  requireLowercase: z.boolean().optional(),
  requireDigit: z.boolean().optional(),
  requireSymbol: z.boolean().optional(),
});

const SmtpConfigSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  tlsMode: z.enum(['starttls', 'tls']),
  username: z.string().trim().max(255),
  password: z.string().min(1).max(1024).optional(),
  senderName: z.string().trim().max(255),
  senderEmail: z.string().email().max(255),
  testRecipient: z.string().email().max(255).optional(),
  testEmailKind: z.enum(['smtp_configuration', 'password_setup', 'password_reset', 'email_otp']).optional(),
});

const ShutdownSettingsSchema = z
  .object({
    userRequestDrainSeconds: z.number().int().min(0).max(SHUTDOWN_USER_DRAIN_MAX_SECONDS),
    structuredLogDrainSeconds: z.number().int().min(0).max(SHUTDOWN_LOG_DRAIN_MAX_SECONDS),
    finalizationTimeoutSeconds: z
      .number()
      .int()
      .min(SHUTDOWN_FINALIZATION_MIN_SECONDS)
      .max(SHUTDOWN_FINALIZATION_MAX_SECONDS),
  })
  .refine(
    (value) =>
      value.userRequestDrainSeconds + value.structuredLogDrainSeconds + value.finalizationTimeoutSeconds <=
      SHUTDOWN_TOTAL_MAX_SECONDS,
    { message: `Total graceful shutdown deadline must not exceed ${SHUTDOWN_TOTAL_MAX_SECONDS} seconds` }
  );

export const UpdateAuthProvisioningSettingsSchema = z.object({
  oidcAutoCreateUsers: z.boolean().optional(),
  oidcDefaultGroupId: z.string().uuid().optional(),
  oidcRequireVerifiedEmail: z.boolean().optional(),
  oauthExtendedCallbackCompatibility: z.boolean().optional(),
  mfaExistingSessionGracePeriodDays: z.number().int().min(0).max(7).optional(),
  methods: AuthMethodsSchema.optional(),
  passwordPolicy: PasswordPolicySchema.optional(),
  smtp: SmtpConfigSchema.optional(),
  /** Managed installations with Opfield Cloud email: "smtp" is Use my own SMTP, "cloud" goes back to the cloud email. */
  smtpTransport: z.enum(['smtp', 'cloud']).optional(),
  /** Sends a test through the transport in use (the cloud email, or the saved own SMTP) without saving SMTP. */
  mailTest: z
    .object({
      recipient: z.string().email().max(255),
      kind: z.enum(['smtp_configuration', 'password_setup', 'password_reset', 'email_otp']).optional(),
    })
    .optional(),
  oidc: z
    .object({
      issuer: z.string().trim().url().max(2048),
      clientId: z.string().trim().min(1).max(512),
      clientSecret: z.string().min(1).max(4096).optional(),
      redirectUri: z.string().trim().url().max(2048),
      scopes: z.string().trim().min(1).max(1024).optional(),
      displayName: z.string().trim().max(64).nullable().optional(),
    })
    .optional(),
  /**
   * remove: removes the OIDC provider and turns OIDC sign-in off. opfield_account: Use Opfield account for sign-in;
   * brings back the "Opfield account" provider with the client Opfield Cloud gave this installation and turns OIDC
   * sign-in on, or, without such a client, asks the cloud account for one (the provider is set up when it arrives).
   * cancel_opfield_account: withdraws that pending request. Not with oidc.
   */
  oidcProviderAction: z.enum(['remove', 'opfield_account', 'cancel_opfield_account']).optional(),
  mcpServerEnabled: z.boolean().optional(),
  mcpExtendedCompatibility: z.boolean().optional(),
  webTlsEnabled: z.boolean().optional(),
  logging: z
    .object({
      mode: z.enum(['disabled', 'local', 'external']),
      url: z.string().trim().url().max(2048).optional(),
      username: z.string().trim().min(1).max(255).optional(),
      password: z.string().min(1).max(4096).optional(),
      database: z.string().trim().min(1).max(255).optional(),
      table: z.string().trim().min(1).max(255).optional(),
      requestTimeoutMs: z.number().int().positive().max(120_000).optional(),
    })
    .optional(),
  generalSettings: z
    .object({
      publicUrl: z
        .string()
        .trim()
        .max(2048)
        .refine((value) => {
          try {
            return normalizePublicUrl(value) !== null;
          } catch {
            return false;
          }
        }, 'Must be an http(s) origin without a path')
        .optional(),
      updateChannel: z.enum(['stable', 'preview']).optional(),
      hideExternalBranding: z.boolean().optional(),
      autoAssignCreatedResourcePermissions: z.boolean().optional(),
      sendInvitationOnUserCreate: z.boolean().optional(),
      fileUploadMaxBytes: z.number().int().min(FILE_UPLOAD_MIN_BYTES).max(FILE_UPLOAD_MAX_BYTES).optional(),
      fileOpenMaxBytes: z.number().int().min(FILE_OPEN_MIN_BYTES).max(FILE_OPEN_MAX_BYTES).optional(),
      grpcPublicTarget: z
        .string()
        .trim()
        .max(255)
        .refine(isValidOpfieldHostPortTarget, 'Must be a hostname or IP address, optionally with a port')
        .nullable()
        .optional(),
      grpcLocalIp: z
        .string()
        .trim()
        .max(255)
        .refine(isValidOpfieldIpPortTarget, 'Must be an IPv4 or IPv6 address, optionally with a port')
        .nullable()
        .optional(),
      relayAutoRecovery: z.boolean().optional(),
      relay: z
        .object({
          dataLanes: z.number().int().min(RELAY_DATA_LANES_MIN).max(RELAY_DATA_LANES_MAX).optional(),
          readChunkBytes: z.number().int().min(RELAY_READ_CHUNK_BYTES_MIN).max(RELAY_READ_CHUNK_BYTES_MAX).optional(),
          assignmentSpread: z
            .discriminatedUnion('mode', [
              z.object({
                mode: z.literal('fixed'),
                count: z.number().int().min(RELAY_ASSIGNMENT_SPREAD_MIN_COUNT).max(RELAY_ASSIGNMENT_SPREAD_MAX_COUNT),
              }),
              z.object({ mode: z.literal('all') }),
            ])
            .optional(),
          adaptiveAdmissionEnabled: z.boolean().optional(),
          proxyTargetPressurePercent: z
            .number()
            .int()
            .min(RELAY_PROXY_TARGET_PRESSURE_MIN_PERCENT)
            .max(RELAY_PROXY_TARGET_PRESSURE_MAX_PERCENT)
            .optional(),
          databaseReservePercent: z
            .number()
            .int()
            .min(RELAY_DATABASE_RESERVE_MIN_PERCENT)
            .max(RELAY_DATABASE_RESERVE_MAX_PERCENT)
            .optional(),
          hardPressurePercent: z
            .number()
            .int()
            .min(RELAY_HARD_PRESSURE_MIN_PERCENT)
            .max(RELAY_HARD_PRESSURE_MAX_PERCENT)
            .optional(),
        })
        .optional(),
      shutdown: ShutdownSettingsSchema.optional(),
      relayGrantTtlHours: z.number().int().min(RELAY_GRANT_TTL_MIN_HOURS).max(RELAY_GRANT_TTL_MAX_HOURS).optional(),
      relayPolicyLeaseHours: z
        .number()
        .int()
        .min(RELAY_POLICY_LEASE_MIN_HOURS)
        .max(RELAY_POLICY_LEASE_MAX_HOURS)
        .optional(),
      features: z
        .object({
          pkiEnabled: z.boolean().optional(),
          domainsEnabled: z.boolean().optional(),
          siemEnabled: z.boolean().optional(),
          inferenceEnabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  networkSecurity: z
    .object({
      clientIpSource: z.enum(CLIENT_IP_SOURCE_VALUES).optional(),
      trustedProxyCidrs: z
        .array(z.string().trim().min(1).max(64).refine(isValidCidr, 'Invalid CIDR range'))
        .max(64)
        .optional(),
      trustCloudflareHeaders: z.boolean().optional(),
    })
    .optional(),
  outboundWebhookPolicy: z
    .object({
      allowPrivateNetworks: z.boolean().optional(),
      allowedPrivateCidrs: z
        .array(z.string().trim().min(1).max(64).refine(isValidCidr, 'Invalid CIDR range'))
        .max(64)
        .optional(),
    })
    .optional(),
});

export type UpdateUserGroupInput = z.infer<typeof UpdateUserGroupSchema>;
export type UpdateUserAdditionalPermissionsInput = z.infer<typeof UpdateUserAdditionalPermissionsSchema>;
export type UpdateBlockInput = z.infer<typeof UpdateBlockSchema>;
export type RestoreUserInput = z.infer<typeof RestoreUserSchema>;
export type UpdateUserAuthMethodInput = z.infer<typeof UpdateUserAuthMethodSchema>;
export type UpdateUserNameInput = z.infer<typeof UpdateUserNameSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateAuthProvisioningSettingsInput = z.infer<typeof UpdateAuthProvisioningSettingsSchema>;
