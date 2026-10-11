import type { CredentialStore } from './credentials.js';
import type { Fetch } from './http.js';
import type { InteractiveCliUi } from './interactive-ui.js';
import { loginCommand, loginWithInferenceTokenCommand } from './login-command.js';
import type { Output } from './output.js';
import type { ProfileStore } from './profiles.js';

export async function runInteractiveLogin(input: {
  gateway: string;
  profileName: string;
  profiles: ProfileStore;
  credentials: CredentialStore;
  output: Output;
  ui: InteractiveCliUi;
  fetch?: Fetch;
  openBrowser?: (url: string) => Promise<void>;
  cancelMessage?: string;
}): Promise<boolean> {
  const method = await input.ui.select('How do you want to authenticate?', [
    {
      value: 'oauth',
      label: 'Browser OAuth',
      hint: 'Open Opfield in your browser and approve this device',
    },
    {
      value: 'token',
      label: 'Existing inference token',
      hint: 'Use a gwi_ token without opening a browser',
    },
  ]);
  if (!method) {
    input.ui.cancel(input.cancelMessage ?? 'Login cancelled.');
    return false;
  }

  if (method === 'token') {
    const token = await input.ui.inferenceToken();
    if (!token) {
      input.ui.cancel(input.cancelMessage ?? 'Login cancelled.');
      return false;
    }
    input.ui.info('Validating Opfield inference token...');
    await loginWithInferenceTokenCommand(
      { gateway: input.gateway, token },
      input.profileName,
      input.profiles,
      input.credentials,
      input.output,
      input.fetch
    );
    return true;
  }

  input.ui.info('Complete authorization in your browser...');
  await loginCommand(
    { gateway: input.gateway, command: ['login'] },
    input.profileName,
    input.profiles,
    input.credentials,
    input.output,
    input.fetch,
    input.openBrowser
  );
  return true;
}
