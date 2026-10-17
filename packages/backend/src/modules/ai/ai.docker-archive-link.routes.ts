import { Hono } from 'hono';
import type { AppEnv } from '@/types.js';
import { importDockerArchiveUploadLink, openDockerArchiveDownloadLink } from './ai.docker-archive-link.js';

/**
 * One-time Docker archive links, mounted at DOCKER_ARCHIVE_LINK_PATH. The link
 * token is the credential: it was issued to an authenticated MCP caller and is
 * consumed by the first request, whatever its outcome.
 */
export const dockerArchiveLinkRoutes = new Hono<AppEnv>();

// `curl -T` sends PUT; POST also carries the raw .ofca bytes (`curl --data-binary`).
dockerArchiveLinkRoutes.on(['PUT', 'POST'], '/:token', async (c) => {
  const data = await importDockerArchiveUploadLink(c.req.param('token'), c.req.raw.body);
  return c.json({ data }, 201);
});

dockerArchiveLinkRoutes.get('/:token', async (c) => {
  // Hono answers HEAD with the GET handler; a probe must not use up the link.
  if (c.req.method === 'HEAD') return c.body(null, 405, { Allow: 'GET' });
  return openDockerArchiveDownloadLink(c.req.param('token'));
});
