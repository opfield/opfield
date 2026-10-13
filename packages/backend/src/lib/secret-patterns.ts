/**
 * Shapes of secret material that Gateway recognizes in free text: the idempotency store refuses to keep results that
 * carry them, and diagnostics logs and AI tool results mask them. Non-global, so `test` is stateless; build a global
 * copy (`new RegExp(pattern.source, 'g')`) to replace.
 */

/** An Opfield-issued token: `opf_`, `opfo_`, `opfl_`, `opfr_`, `opfpu_` … followed by its random part. */
// legacy-name: gw* token prefixes — secrets issued before 2.12.1 must still be masked; remove once none remain
export const OPFIELD_TOKEN_PATTERN = /\b(?:opf|gw)[a-z]{0,3}_[A-Za-z0-9_-]{16,}/;

/** The header of a PEM private key block. */
export const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
