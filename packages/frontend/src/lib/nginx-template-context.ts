// Generated from the nginx template renderer (packages/backend/src/modules/proxy). Do not edit by hand.
// Regenerate: cd packages/backend && UPDATE_NGINX_TEMPLATE_CONTEXT=1 pnpm vitest run src/modules/proxy/nginx-template-context.test.ts

/** Variables Opfield puts in the render context of every nginx template. */
export const NGINX_TEMPLATE_CONTEXT_VARIABLES: readonly string[] = [
  "accessList",
  "accessListHasIpRules",
  "additionalRoutes",
  "additionalSecureLinks",
  "advancedConfig",
  "cacheEnabled",
  "cacheMaxAge",
  "cacheStale",
  "connectionsPerIp",
  "customHeaders",
  "customHostHeader",
  "customRewrites",
  "forwardHost",
  "forwardPort",
  "forwardScheme",
  "http2Support",
  "id",
  "logPath",
  "pagesFallbackUrl",
  "pagesRouteIncludePath",
  "pagesSpaFallback",
  "rateLimitBurst",
  "rateLimitEnabled",
  "rateLimitMode",
  "rateLimitRPS",
  "redirectStatusCode",
  "redirectUrl",
  "registryAuthRealm",
  "registryAuthVariableName",
  "secureLinkSocketPath",
  "secureLinkSocketPaths",
  "secureLinkUpstream",
  "secureLinkUpstreamName",
  "secureLinkUsesLoadBalancing",
  "serverNames",
  "sslCertPath",
  "sslChainPath",
  "sslEnabled",
  "sslForced",
  "sslKeyPath",
  "upstream",
  "websocketSupport",
];

/** Handlebars helpers nginx templates can call. */
export const NGINX_TEMPLATE_HELPERS: readonly string[] = [
  "accessListDirectives",
  "applyAccessListToAdvancedLocations",
  "each",
  "eq",
  "if",
  "indent",
  "log",
  "lookup",
  "renderAdditionalRoutes",
  "sanitize",
  "sanitizeRewrite",
  "unless",
  "with",
];

/** Helpers that open a block: `{{#name}}…{{/name}}`. */
export const NGINX_TEMPLATE_BLOCK_HELPERS: readonly string[] = ["each", "if", "unless", "with"];
