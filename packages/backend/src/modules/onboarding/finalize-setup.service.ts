import { eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';

export const FINALIZE_SETUP_STATE_KEY = 'onboarding:finalize_setup';

export const FINALIZE_SETUP_STEPS = ['nodes', 'ai_workspace', 'cloudflare', 'gitlab', 'mfa', 'invite_users'] as const;

export type FinalizeSetupStep = (typeof FINALIZE_SETUP_STEPS)[number];
export type FinalizeSetupStepStatus = 'pending' | 'configured' | 'skipped';

export interface FinalizeSetupState {
  version: 3;
  ownerUserId: string;
  /** A user can dismiss the post-onboarding MFA reminder without changing the checklist outcome. */
  mfaReminderHiddenAt?: string | null;
  steps: Record<FinalizeSetupStep, FinalizeSetupStepStatus>;
}

export interface FinalizeSetupPublicState {
  steps: Record<FinalizeSetupStep, FinalizeSetupStepStatus>;
}

export class FinalizeSetupUnavailableError extends Error {
  constructor() {
    super('Finalize setup is not available for this account');
  }
}

export class FinalizeSetupStepConflictError extends Error {
  constructor() {
    super('A configured setup item cannot be skipped');
  }
}

function pendingSteps(): Record<FinalizeSetupStep, FinalizeSetupStepStatus> {
  return Object.fromEntries(FINALIZE_SETUP_STEPS.map((step) => [step, 'pending'])) as Record<
    FinalizeSetupStep,
    FinalizeSetupStepStatus
  >;
}

export function isFinalizeSetupComplete(state: Pick<FinalizeSetupState, 'steps'>): boolean {
  return FINALIZE_SETUP_STEPS.every((step) => state.steps[step] !== 'pending');
}

function toPublicState(state: FinalizeSetupState): FinalizeSetupPublicState {
  return {
    steps: state.steps,
  };
}

function normalizeState(value: unknown): FinalizeSetupState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as {
    version?: unknown;
    ownerUserId?: unknown;
    mfaReminderHiddenAt?: unknown;
    steps?: Record<string, unknown>;
  };
  if (
    (state.version !== 1 && state.version !== 2 && state.version !== 3) ||
    typeof state.ownerUserId !== 'string' ||
    !state.ownerUserId
  )
    return null;
  const steps = pendingSteps();
  for (const step of FINALIZE_SETUP_STEPS) {
    const status = step === 'ai_workspace' && state.version !== 3 ? state.steps?.ai_assistant : state.steps?.[step];
    if (status === 'configured' || status === 'skipped' || status === 'pending') steps[step] = status;
  }
  return {
    version: 3,
    ownerUserId: state.ownerUserId,
    mfaReminderHiddenAt: typeof state.mfaReminderHiddenAt === 'string' ? state.mfaReminderHiddenAt : null,
    steps,
  };
}

export class FinalizeSetupService {
  constructor(private readonly db: DrizzleClient) {}

  async initializeOwner(userId: string, executor: DrizzleExecutor = this.db): Promise<void> {
    const state: FinalizeSetupState = {
      version: 3,
      ownerUserId: userId,
      mfaReminderHiddenAt: null,
      steps: pendingSteps(),
    };
    await executor
      .insert(settings)
      .values({ key: FINALIZE_SETUP_STATE_KEY, value: state, updatedAt: new Date() })
      .onConflictDoNothing();
  }

  async clearOwner(userId: string): Promise<void> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId) return;
    await this.db.delete(settings).where(eq(settings.key, FINALIZE_SETUP_STATE_KEY));
  }

  async getForUser(userId: string): Promise<FinalizeSetupPublicState | null> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId) return null;
    return toPublicState(state);
  }

  async isOwner(userId: string): Promise<boolean> {
    const state = await this.getStoredState();
    return state?.ownerUserId === userId;
  }

  async applySetupAIWorkspaceOutcome(userId: string, outcome: 'configured' | 'skipped'): Promise<void> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId) return;
    const status = outcome === 'configured' ? 'configured' : 'pending';
    if (state.steps.ai_workspace === status) return;
    await this.save({ ...state, steps: { ...state.steps, ai_workspace: status } });
  }

  async applySetupAIWorkspaceOutcomeForOwner(outcome: 'configured' | 'skipped'): Promise<void> {
    const state = await this.getStoredState();
    if (!state) return;
    await this.applySetupAIWorkspaceOutcome(state.ownerUserId, outcome);
  }

  async markStep(
    userId: string,
    step: FinalizeSetupStep,
    status: Exclude<FinalizeSetupStepStatus, 'pending'>
  ): Promise<FinalizeSetupPublicState> {
    const state = await this.requireOwnerState(userId);
    if (state.steps[step] === 'configured' && status === 'skipped') {
      throw new FinalizeSetupStepConflictError();
    }
    if (state.steps[step] === status) return toPublicState(state);
    const next: FinalizeSetupState = {
      ...state,
      steps: { ...state.steps, [step]: status },
    };
    await this.save(next);
    return toPublicState(next);
  }

  /**
   * The soft MFA reminder is intentionally separate from the checklist itself:
   * dismissing the checklist should not silently turn a skipped MFA step into a
   * completed one.
   */
  async shouldShowMfaReminder(userId: string): Promise<boolean> {
    const state = await this.getStoredState();
    return Boolean(
      state &&
        state.ownerUserId === userId &&
        isFinalizeSetupComplete(state) &&
        state.steps.mfa === 'skipped' &&
        !state.mfaReminderHiddenAt
    );
  }

  async hideMfaReminder(userId: string): Promise<void> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId) throw new FinalizeSetupUnavailableError();
    if (!isFinalizeSetupComplete(state) || state.steps.mfa !== 'skipped' || state.mfaReminderHiddenAt) return;
    await this.save({ ...state, mfaReminderHiddenAt: new Date().toISOString() });
  }

  private async requireOwnerState(userId: string): Promise<FinalizeSetupState> {
    const state = await this.getStoredState();
    if (!state || state.ownerUserId !== userId || isFinalizeSetupComplete(state)) {
      throw new FinalizeSetupUnavailableError();
    }
    return state;
  }

  private async getStoredState(): Promise<FinalizeSetupState | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, FINALIZE_SETUP_STATE_KEY)).limit(1);
    return normalizeState(row?.value);
  }

  private async save(state: FinalizeSetupState): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: FINALIZE_SETUP_STATE_KEY, value: state, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: state, updatedAt: new Date() },
      });
  }
}
