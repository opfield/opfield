import type { PublicAuthMethods } from '@/modules/auth/public-auth-methods.js';

export const LOGIN_AUTH_METHODS_PLACEHOLDER = '__OPFIELD_AUTH_METHODS__';

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function injectLoginAuthMethods(html: string, methods: PublicAuthMethods | null): string {
  const serialized = methods ? escapeHtmlAttribute(JSON.stringify(methods)) : '';
  return html.replace(LOGIN_AUTH_METHODS_PLACEHOLDER, serialized);
}
