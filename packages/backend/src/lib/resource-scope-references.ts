import { extractBaseScope, isGitScopeBase, isResourceScoped } from './scopes.js';

/** Tables whose rows a resource-qualified scope can name. `folder` stands for every resource folder table. */
export type ScopeResourceKind =
  | 'app'
  | 'appEnvironment'
  | 'node'
  | 'folder'
  | 'proxyHost'
  | 'proxyTemplate'
  | 'domain'
  | 'sslCertificate'
  | 'certificateAuthority'
  | 'pkiCertificate'
  | 'accessList'
  | 'pageProject'
  | 'databaseConnection'
  | 'objectStorageConnection'
  | 'loggingEnvironment'
  | 'loggingSchema'
  | 'user'
  | 'group'
  | 'hostingResource'
  | 'integrationConnector'
  | 'dockerAccessResource'
  | 'dockerDeployment'
  | 'dockerComposeProject';

/** A resource a scope names: it exists while a row with `id` exists in any of `kinds`. */
export interface ScopeResourceReference {
  kinds: readonly ScopeResourceKind[];
  id: string;
}

// Stored IDs are lowercase UUIDs; any other qualifier (names, image IDs, provider IDs) is never judged.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOCKER_CHILD_KINDS = ['dockerAccessResource', 'dockerDeployment', 'dockerComposeProject'] as const;
const CREATION_BASES_WITHOUT_TARGET = new Set([
  'pages:create',
  'nodes:create',
  'databases:create',
  'storage:create',
  'logs:environments:create',
  'logs:schemas:create',
]);

/** What a bare `<base>:<id>` qualifier names, or null when the base does not say. */
function bareTargetKinds(base: string): readonly ScopeResourceKind[] | null {
  if (CREATION_BASES_WITHOUT_TARGET.has(base)) return null;
  if (base.startsWith('docker:registries:')) return null;
  // Node-wide Docker grants name the node; the other kinds keep a legacy child-only qualifier safe.
  if (base.startsWith('docker:')) return ['node', ...DOCKER_CHILD_KINDS];
  if (base.startsWith('nodes:')) return ['node'];
  // Legacy creation grants name the target node directly.
  if (base === 'proxy:create' || base === 'domains:create') return ['node'];
  if (base.startsWith('proxy:templates:')) return ['proxyTemplate'];
  if (base.startsWith('proxy:')) return ['proxyHost'];
  if (base.startsWith('domains:')) return ['domain'];
  if (base.startsWith('pages:')) return ['pageProject'];
  if (base.startsWith('apps:')) return ['app'];
  if (base.startsWith('ssl:cert:')) return ['sslCertificate'];
  if (base.startsWith('acl:')) return ['accessList'];
  if (base.startsWith('pki:ca:')) return ['certificateAuthority'];
  // Certificate grants are qualified by the issuing CA; a certificate ID is accepted too.
  if (base.startsWith('pki:cert:')) return ['certificateAuthority', 'pkiCertificate'];
  if (base.startsWith('databases:')) return ['databaseConnection'];
  if (base.startsWith('storage:')) return ['objectStorageConnection'];
  if (base.startsWith('logs:schemas:')) return ['loggingSchema'];
  if (base.startsWith('logs:')) return ['loggingEnvironment'];
  if (base === 'admin:users' || base === 'admin:users:impersonate') return ['user'];
  if (base === 'admin:groups') return ['group'];
  // Hosting qualifiers are VM resources or hosting accounts depending on the action.
  if (base.startsWith('hosting:') || base.startsWith('integrations:hosting:'))
    return ['hostingResource', 'integrationConnector', 'folder'];
  return null;
}

/**
 * The resources a stored resource-qualified scope names. Unqualified scopes, unknown bases and qualifiers that are not
 * stored IDs name nothing, so a scope is only ever judged by rows it provably refers to.
 */
export function scopeResourceReferences(scope: string): ScopeResourceReference[] {
  if (!isResourceScoped(scope)) return [];
  const base = extractBaseScope(scope);
  const qualifier = scope.slice(base.length + 1);
  const single = (kinds: readonly ScopeResourceKind[], id: string) => (UUID.test(id) ? [{ kinds, id }] : []);
  if (qualifier.startsWith('folder/')) return single(['folder'], qualifier.slice('folder/'.length));
  if (qualifier.startsWith('node/')) return single(['node'], qualifier.slice('node/'.length));
  if (qualifier.startsWith('account/')) return single(['integrationConnector'], qualifier.slice('account/'.length));
  // App grants: `<appId>` (whole app) or `env/<envId>`.
  if (base.startsWith('apps:') && qualifier.startsWith('env/'))
    return single(['appEnvironment'], qualifier.slice('env/'.length));
  if (isGitScopeBase(base)) return single(['integrationConnector'], qualifier.split('/')[0]);
  const kinds = bareTargetKinds(base);
  if (!kinds) return [];
  if (!base.startsWith('docker:')) return single(kinds, qualifier);
  // Docker children are `<nodeId>/<id>`; image and volume children are names, so only their node is judged.
  const [nodeId, childId, ...rest] = qualifier.split('/');
  if (childId === undefined) return single(kinds, nodeId);
  const node = single(['node'], nodeId);
  if (rest.length > 0 || base.startsWith('docker:images:') || base.startsWith('docker:volumes:')) return node;
  return [...node, ...single(DOCKER_CHILD_KINDS, childId)];
}
