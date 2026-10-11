import { and, eq, isNull } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { users } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { UpdateUserAuthMethodInput } from '@/modules/admin/admin.schemas.js';
import {
  type AdminUserActionServices,
  type AdminUserActor,
  auditServiceOf,
  requireManageableUser,
} from '@/modules/admin/admin-user-guards.js';
import type { AccountInvitationSignIn } from '@/modules/auth/auth-email.templates.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';

/**
 * Emails sent to a user an administrator created or changed: the sign-in
 * onboarding (password setup link, email-code notice) and the one-time account
 * invitation. The invitation is offered only while the user has never signed in
 * and was not invited yet.
 */
const logger = createChildLogger('AdminUserInvitation');

type AuthMethod = UpdateUserAuthMethodInput['authMethod'];

export async function assertSmtpVerified(message: string): Promise<void> {
  if (!(await container.resolve(AuthMailService).getPublicConfig()).verifiedAt) {
    throw new AppError(409, 'SMTP_NOT_VERIFIED', message);
  }
}

export async function sendSignInOnboarding(email: string, authMethod: AuthMethod | undefined): Promise<void> {
  if (authMethod === 'password') {
    await container.resolve(LocalAuthService).requestPasswordLink(email, 'password_setup');
  } else if (authMethod === 'email_otp') {
    await container.resolve(LocalAuthService).sendEmailOtpOnboarding(email);
  }
}

function invitationSignIn(authMethod: User['authMethod']): AccountInvitationSignIn {
  if (authMethod === 'password') return 'password';
  if (authMethod === 'email_otp' || authMethod === 'demo_email_otp') return 'email_otp';
  return 'oidc';
}

function database(): DrizzleClient {
  return container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
}

async function readInvitationState(userId: string) {
  const row = await database().query.users.findFirst({
    where: eq(users.id, userId),
    columns: { lastLoginAt: true, invitationSentAt: true },
  });
  return row ?? null;
}

function assertInvitable(state: { lastLoginAt: Date | null; invitationSentAt: Date | null } | null): void {
  if (!state) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (state.lastLoginAt) {
    throw new AppError(409, 'USER_ALREADY_SIGNED_IN', 'The user has already signed in, so no invitation is needed');
  }
  if (state.invitationSentAt) {
    throw new AppError(409, 'INVITATION_ALREADY_SENT', 'An invitation email was already sent to this user');
  }
}

/**
 * Claims the user's one invitation and queues the email. The claim is a
 * conditional update, so concurrent requests send it once; a failed send
 * releases the claim so the invitation stays available. Null when the user
 * signed in or was invited meanwhile.
 */
async function deliverAccountInvitation(user: Pick<User, 'id' | 'email' | 'authMethod'>): Promise<Date | null> {
  await assertSmtpVerified('SMTP must be verified before sending an invitation email');
  const publicUrl = await container.resolve(GeneralSettingsService).getPublicUrl();
  if (!publicUrl) {
    throw new AppError(409, 'PUBLIC_URL_NOT_CONFIGURED', 'Set the Opfield public URL before sending invitation emails');
  }
  const db = database();
  const sentAt = new Date();
  const [claimed] = await db
    .update(users)
    .set({ invitationSentAt: sentAt })
    .where(
      and(eq(users.id, user.id), isNull(users.invitationSentAt), isNull(users.lastLoginAt), isNull(users.deletedAt))
    )
    .returning({ id: users.id });
  if (!claimed) return null;
  try {
    await container.resolve(AuthMailService).sendSecurityEmail(user.email, {
      kind: 'account_invitation',
      actionUrl: new URL('/login', publicUrl).toString(),
      email: user.email,
      signIn: invitationSignIn(user.authMethod),
    });
  } catch (error) {
    await db
      .update(users)
      .set({ invitationSentAt: null })
      .where(and(eq(users.id, user.id), eq(users.invitationSentAt, sentAt)));
    throw error;
  }
  return sentAt;
}

async function auditInvitation(
  actor: AdminUserActor,
  user: User,
  services: AdminUserActionServices,
  automatic: boolean
): Promise<void> {
  await auditServiceOf(services).log({
    userId: actor.user.id,
    action: 'user.invitation_sent',
    resourceType: 'user',
    resourceId: user.id,
    details: {
      targetUserId: user.id,
      targetUserEmail: user.email,
      targetUserName: user.name,
      authMethod: user.authMethod,
      automatic,
    },
    userAgent: actor.userAgent,
  });
}

export async function sendAdminUserInvitation(
  actor: AdminUserActor,
  userId: string,
  services: AdminUserActionServices = {}
): Promise<User> {
  const targetUser = await requireManageableUser(actor, userId, services);
  if (targetUser.isDeleted) throw new AppError(409, 'USER_DELETED', 'Deleted users cannot be invited');
  if (targetUser.oidcSubject?.startsWith('system:')) {
    throw new AppError(403, 'SYSTEM_USER', 'Cannot invite the system user');
  }
  assertInvitable(await readInvitationState(userId));
  const sentAt = await deliverAccountInvitation(targetUser);
  if (!sentAt) {
    assertInvitable(await readInvitationState(userId));
    throw new AppError(409, 'INVITATION_ALREADY_SENT', 'An invitation email was already sent to this user');
  }
  await auditInvitation(actor, targetUser, services, false);
  return { ...targetUser, lastLoginAt: null, invitationSentAt: sentAt.toISOString() };
}

/**
 * Sends the invitation to a just-created user when the Gateway setting asks
 * for it. A failure never fails the creation: it is logged and the invitation
 * stays available to send later. Returns when it was sent, or null.
 */
export async function inviteCreatedUser(
  actor: AdminUserActor,
  user: User,
  services: AdminUserActionServices = {}
): Promise<Date | null> {
  let sentAt: Date | null;
  try {
    if (!(await container.resolve(GeneralSettingsService).getConfig()).sendInvitationOnUserCreate) return null;
    sentAt = await deliverAccountInvitation(user);
  } catch (error) {
    logger.warn('Account invitation email was not sent for a created user', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (sentAt) await auditInvitation(actor, user, services, true);
  return sentAt;
}
