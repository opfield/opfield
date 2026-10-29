/** Where log producers post their logs, several times a second each. */
export const LOG_INGEST_PATHS: ReadonlySet<string> = new Set(['/api/logging/ingest', '/api/logging/ingest/batch']);
