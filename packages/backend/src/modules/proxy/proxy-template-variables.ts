/**
 * Template variables that templates may legitimately override. Their render
 * values are derived from the override (see NginxTemplateService), so they are
 * accepted in `templateVariables`.
 */
export const OVERRIDABLE_TEMPLATE_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  'cacheEnabled',
  'cacheMaxAge',
  'rateLimitMode',
  'rateLimitRPS',
  'rateLimitBurst',
  'connectionsPerIp',
]);

/**
 * Render-context keys managed by Opfield. A custom template variable with one
 * of these names could otherwise drop the access list or redirect the upstream,
 * certificate or log paths, so they are rejected on write and ignored on render.
 */
export const RESERVED_TEMPLATE_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  'id',
  'serverNames',
  'upstream',
  'forwardScheme',
  'forwardHost',
  'forwardPort',
  'sslEnabled',
  'sslForced',
  'http2Support',
  'websocketSupport',
  'secureLinkUpstream',
  'secureLinkUpstreamName',
  'secureLinkSocketPath',
  'secureLinkSocketPaths',
  'secureLinkUsesLoadBalancing',
  'registryAuthRealm',
  'registryAuthVariableName',
  'sslCertPath',
  'sslKeyPath',
  'sslChainPath',
  'redirectUrl',
  'redirectStatusCode',
  'cacheStale',
  'customHeaders',
  'customHostHeader',
  'customRewrites',
  'accessList',
  'accessListHasIpRules',
  'logPath',
  'pagesRouteIncludePath',
  'pagesSpaFallback',
  'pagesFallbackUrl',
  'additionalRoutes',
  'additionalSecureLinks',
  'rateLimitEnabled',
  'advancedConfig',
]);

export function isReservedTemplateVariableName(name: string): boolean {
  return RESERVED_TEMPLATE_VARIABLE_NAMES.has(name);
}

export function reservedTemplateVariableNames(variables: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(variables ?? {}).filter(isReservedTemplateVariableName);
}

/** Drop managed keys from stored variables so legacy rows still render safely. */
export function withoutReservedTemplateVariables<T>(variables: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => !isReservedTemplateVariableName(name)));
}
