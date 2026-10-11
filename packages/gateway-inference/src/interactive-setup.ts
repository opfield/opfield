import { CliError } from './errors.js';
import type { InteractiveCliUi, InteractiveOption } from './interactive-ui.js';
import type { GatewayProfile } from './profiles.js';
import type { InferenceSetupClient } from './tokens.js';
import type { InferenceDiscovery } from './types.js';

const AUTHORIZATION_REQUIRED_CODES = new Set([
  'PROFILE_NOT_FOUND',
  'NOT_LOGGED_IN',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_REVOKED',
]);
const CLI_SUPPORTED_HARNESSES = ['codex', 'claude-code'];

export interface InteractiveSetupSession {
  profile: GatewayProfile;
  discovery: InferenceDiscovery;
  client: InferenceSetupClient;
}

export async function runInteractiveInferenceSetup(input: {
  profileName: string;
  gateway?: string;
  existingOrigin?: string;
  ui: InteractiveCliUi;
  showIntro?: boolean;
  session: () => Promise<InteractiveSetupSession>;
  authorize: (gateway: string) => Promise<boolean | undefined>;
  configure: (harness: string, session: InteractiveSetupSession) => Promise<{ progress: string; summary: string }>;
}): Promise<number> {
  if (input.showIntro !== false) {
    input.ui.intro('Opfield Inference · Setup');
  }
  let session: InteractiveSetupSession;

  try {
    session = await input.session();
    input.ui.info(`Connected to ${session.profile.origin}`);
  } catch (error) {
    if (!isAuthorizationRequired(error)) throw error;
    const gateway = input.gateway ?? input.existingOrigin ?? (await input.ui.gatewayOrigin());
    if (!gateway) {
      input.ui.cancel('Setup cancelled.');
      return 0;
    }
    const authorized = await input.authorize(gateway);
    if (authorized === false) return 0;
    input.ui.info('Opfield authorization complete');
    session = await input.session();
  }

  // Schema v2 gateways serve both harnesses from the single stable
  // /api/inference/v1 prefix; there is no per-harness support advertisement.
  const harness = await input.ui.select('Which harness do you want to configure?', supportedHarnesses());
  if (!harness) {
    input.ui.cancel('Setup cancelled.');
    return 0;
  }

  const spinner = input.ui.spinner(`Configuring ${harnessLabel(harness)}...`);
  try {
    const result = await input.configure(harness, session);
    spinner.stop(result.progress);
    input.ui.outro(result.summary);
    return 0;
  } catch (error) {
    spinner.error(`Could not configure ${harnessLabel(harness)}`);
    throw error;
  }
}

export function isAuthorizationRequired(error: unknown): boolean {
  return error instanceof CliError && AUTHORIZATION_REQUIRED_CODES.has(error.code);
}

function supportedHarnesses(): InteractiveOption[] {
  return CLI_SUPPORTED_HARNESSES.map((value) => ({ value, ...harnessPresentation(value) }));
}

function harnessPresentation(harness: string): Pick<InteractiveOption, 'label' | 'hint'> {
  if (harness === 'codex') {
    return {
      label: 'Codex CLI',
      hint: 'Opfield models, reasoning, tools, and automatic catalog refresh',
    };
  }
  if (harness === 'claude-code') {
    return {
      label: 'Claude Code CLI',
      hint: 'Native Anthropic gateway, model discovery, tools, and extended thinking',
    };
  }
  return { label: harnessLabel(harness), hint: 'Advertised by this Opfield instance' };
}

function harnessLabel(harness: string): string {
  return harness === 'codex' ? 'Codex CLI' : harness === 'claude-code' ? 'Claude Code CLI' : harness;
}
