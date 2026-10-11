import * as prompts from '@clack/prompts';
import { normalizeGatewayOrigin } from './profiles.js';

export interface InteractiveOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface InteractiveSpinner {
  stop(message: string): void;
  error(message: string): void;
}

export interface InteractiveCliUi {
  intro(title: string): void;
  info(message: string): void;
  error(message: string): void;
  gatewayOrigin(): Promise<string | null>;
  inferenceToken(): Promise<string | null>;
  select(message: string, options: InteractiveOption[]): Promise<string | null>;
  confirm(message: string): Promise<boolean | null>;
  spinner(message: string): InteractiveSpinner;
  cancel(message: string): void;
  outro(message: string): void;
}

export function createInteractiveCliUi(): InteractiveCliUi {
  return {
    intro(title) {
      prompts.intro(title);
    },
    info(message) {
      prompts.log.info(message);
    },
    error(message) {
      prompts.log.error(message);
    },
    async gatewayOrigin() {
      const value = await prompts.text({
        message: 'Opfield URL',
        placeholder: 'https://gateway.example.com',
        validate(input) {
          const value = input?.trim() ?? '';
          if (!value) return 'Enter the URL of your Opfield instance.';
          try {
            normalizeGatewayOrigin(value);
          } catch (error) {
            return error instanceof Error ? error.message : 'Enter a valid Opfield URL.';
          }
        },
      });
      if (prompts.isCancel(value)) return null;
      return normalizeGatewayOrigin(value.trim());
    },
    async inferenceToken() {
      const value = await prompts.password({
        message: 'Opfield inference token',
        mask: '*',
        clearOnError: true,
        validate(input) {
          const token = input?.trim() ?? '';
          if (!token) return 'Enter an existing Opfield inference token.';
          if (!token.startsWith('gwi_')) return 'Opfield inference tokens must start with gwi_.';
        },
      });
      if (prompts.isCancel(value)) return null;
      return value.trim();
    },
    async select(message, options) {
      const value = await prompts.select({ message, options });
      return prompts.isCancel(value) ? null : value;
    },
    async confirm(message) {
      const value = await prompts.confirm({ message });
      return prompts.isCancel(value) ? null : value;
    },
    spinner(message) {
      const spinner = prompts.spinner();
      spinner.start(message);
      return {
        stop: (result) => spinner.stop(result),
        error: (result) => spinner.error(result),
      };
    },
    cancel(message) {
      prompts.cancel(message);
    },
    outro(message) {
      prompts.outro(message);
    },
  };
}
