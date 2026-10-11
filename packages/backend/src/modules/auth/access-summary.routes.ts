import { OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type AccessCredential,
  accessSummaryDatabase,
  accessSummaryPrincipal,
  buildAccessSummary,
} from '@/lib/access-summary-resolver.js';
import { appRoute, dataResponseSchema, openApiValidationHook } from '@/lib/openapi.js';
import type { AppEnv } from '@/types.js';
import { authMiddleware } from './auth.middleware.js';

const TargetSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  actions: z.array(z.string()),
});

const AccessAreaSchema = z.object({
  area: z.string().openapi({ example: 'docker_containers' }),
  title: z.string().openapi({ example: 'Docker containers and deployments' }),
  access: z.enum(['broad', 'limited']),
  broadActions: z.array(z.string()),
  folders: z.array(TargetSchema.extend({ path: z.string().nullable(), includesSubfolders: z.literal(true) })),
  nodes: z.array(TargetSchema),
  resources: z.array(
    TargetSchema.extend({ nodeId: z.string().optional(), nodeName: z.string().nullable().optional() })
  ),
  accounts: z.array(TargetSchema),
  create: z
    .object({
      scope: z.string(),
      atRoot: z.boolean(),
      folders: z.array(z.object({ id: z.string(), name: z.string().nullable(), path: z.string().nullable() })),
      nodes: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
      accounts: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
      howTo: z.string(),
    })
    .optional(),
  folderListing: z
    .object({ tool: z.literal('list_resource_folders'), arguments: z.record(z.string(), z.string()) })
    .optional(),
  omitted: z.record(z.string(), z.number()).optional(),
});

export const AccessSummarySchema = z
  .object({
    principal: z
      .object({
        credential: z.enum(['session', 'api-token', 'oauth-token', 'mcp', 'assistant']),
        boundedByOwner: z.boolean(),
        userId: z.string().optional().openapi({ description: 'Browser sessions only.' }),
        name: z.string().nullable().optional().openapi({ description: 'Browser sessions only.' }),
        email: z.string().optional().openapi({ description: 'Browser sessions only.' }),
        group: z.string().optional().openapi({ description: 'Browser sessions only.' }),
      })
      .optional(),
    limited: z.boolean(),
    summary: z.string(),
    areas: z.array(AccessAreaSchema),
    rules: z.array(z.string()),
  })
  .openapi('AccessSummary', {
    example: {
      limited: true,
      summary:
        "Your Opfield access is limited to specific folders, nodes or resources. ...\n- Docker containers and deployments: folder 'MyProject' (create, manage, view); create only in the folders or nodes listed.",
      areas: [
        {
          area: 'docker_containers',
          title: 'Docker containers and deployments',
          access: 'limited',
          broadActions: [],
          folders: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              name: 'MyProject',
              path: 'MyProject',
              actions: ['create', 'manage', 'view'],
              includesSubfolders: true,
            },
          ],
          nodes: [],
          resources: [],
          accounts: [],
          create: {
            scope: 'docker:containers:create',
            atRoot: false,
            folders: [{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'MyProject', path: 'MyProject' }],
            nodes: [],
            accounts: [],
            howTo: 'Creation at the root is refused: pass nodeId and folderId to create_docker_container ...',
          },
          folderListing: {
            tool: 'list_resource_folders',
            arguments: { resourceType: 'docker', dockerResourceType: 'container' },
          },
        },
      ],
      rules: ['Folder-, node- and resource-limited access is normal. ...'],
    },
  });

export const myAccessRoute = appRoute({
  method: 'get',
  path: '/me/access',
  tags: ['Authentication'],
  summary: 'Summarize what the caller can access',
  description:
    "Groups the calling principal's effective access by product area: whether it is broad, which folders (with path), nodes, accounts and specific resources are granted with which actions, and where the caller may create. API tokens and OAuth grants are reported as bounded by their owner's current access; the owner's identity (id, name, email, group) is returned only to browser sessions. Folder-, node- and resource-limited access is normal: work inside the listed grants and pass folderId (and nodeId) when creating.",
  responses: {
    200: {
      description: 'Access summary',
      content: { 'application/json': { schema: dataResponseSchema(AccessSummarySchema) } },
    },
  },
});

export const accessSummaryRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

accessSummaryRoutes.use('/me/access', authMiddleware);

function credentialFor(authType: AppEnv['Variables']['authType']): AccessCredential {
  if (authType === 'api-token' || authType === 'oauth-token') return authType;
  return 'session';
}

accessSummaryRoutes.openapi(myAccessRoute, async (c) => {
  const user = c.get('user')!;
  const summary = await buildAccessSummary(
    accessSummaryDatabase(),
    c.get('effectiveScopes') ?? [],
    accessSummaryPrincipal(user, credentialFor(c.get('authType')))
  );
  return c.json({ data: summary }, 200);
});
