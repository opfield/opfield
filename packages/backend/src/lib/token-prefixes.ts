/** Prefixes of the bearer secrets Opfield issues. New secrets always use these. */
export const TOKEN_PREFIXES = {
  api: 'opf_',
  oauthAccess: 'opfo_',
  oauthRefresh: 'opfr_',
  oauthCode: 'opfo_code_',
  inference: 'opfi_',
  logging: 'opfl_',
  pagesDeploy: 'opfp_',
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

// legacy-name: gw_/gwo_/gwr_/gwi_/gwl_/gwp_ token prefixes — tokens issued before 2.12.1 stay valid until they are
// revoked or expire; remove once no stored token carries an old prefix (OAuth codes expire within minutes).
const LEGACY_TOKEN_PREFIXES: Record<TokenKind, string> = {
  api: 'gw_',
  oauthAccess: 'gwo_',
  oauthRefresh: 'gwr_',
  oauthCode: 'gwo_code_',
  inference: 'gwi_',
  logging: 'gwl_',
  pagesDeploy: 'gwp_',
};

/** Whether `value` is shaped like a secret of `kind` (current or legacy prefix). */
export function hasTokenPrefix(value: string | null | undefined, kind: TokenKind): boolean {
  if (!value) return false;
  return value.startsWith(TOKEN_PREFIXES[kind]) || value.startsWith(LEGACY_TOKEN_PREFIXES[kind]);
}

/** Every prefix a secret of `kind` may carry, current first. */
export function acceptedTokenPrefixes(kind: TokenKind): readonly string[] {
  return [TOKEN_PREFIXES[kind], LEGACY_TOKEN_PREFIXES[kind]];
}
