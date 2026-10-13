import { AppError } from '@/middleware/error-handler.js';

/** The daemon's result when the node's `nginx -t` rejects a config it was asked to apply. */
const CONFIG_TEST_FAILURE_RE = /^nginx config test failed: /;
/** `nginx -t` refusing the certificate or key of a TLS bundle: Opfield's material, not the route's config. */
const TLS_MATERIAL_FAILURE_RE = /cannot load certificate|SSL_CTX_use_|PEM_read_bio/;

/**
 * A route config the node's nginx rejected, as the caller's error: 422 NGINX_CONFIG_FAILED for an HTTP and an HTTPS
 * route alike. The node has already restored the config it served before. Null for any other failure. `message` is
 * the text shown to the caller (the HTTPS path redacts node paths from it).
 */
export function nginxConfigRejection(daemonError: string, message = daemonError): AppError | null {
  if (!CONFIG_TEST_FAILURE_RE.test(daemonError) || TLS_MATERIAL_FAILURE_RE.test(daemonError)) return null;
  return new AppError(422, 'NGINX_CONFIG_FAILED', `Failed to apply Nginx config: ${message}`);
}
