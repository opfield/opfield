import { ALL_SCOPES } from './scopes-base.js';
import { FOLDER_CREATION_SCOPES } from './scopes-resource.js';

/**
 * Scope implication rules, generated from the catalog.
 *
 * Every scope belongs to a family named by its longest prefix that has a view scope
 * (`<family>:view`, or the family's named view below). Any action scope in a family implies the
 * family's view scope, keeping its qualifier: `proxy:edit:<hostId>` satisfies `proxy:view:<hostId>`
 * and `docker:containers:manage:<nodeId>` satisfies `docker:containers:view:<nodeId>/<resourceId>`.
 * View scopes never imply another family's view on their own; the few cross-family rules that do
 * hold are listed explicitly.
 *
 * Creation scopes (`*:create*`, `docker:images:pull`, `ssl:cert:issue`, `pki:cert:issue`) name a destination, never
 * existing resources, so they imply no view, whatever their qualifier (broad, `folder/`, `node/`,
 * `account/`, or a legacy bare node ID). Folder trees and node pickers accept creation scopes on
 * their own to show the destinations a creator may use. A creation scope listed in an explicit rule
 * satisfies only that rule's scope, never what that scope implies in turn.
 *
 * The frontend receives the same closure from `packages/frontend/src/types/scope-implications.ts`,
 * which a backend test regenerates and keeps in sync with this module.
 */

/** Families whose view scope is not `<family>:view`. */
const NAMED_FAMILY_VIEWS: Readonly<Record<string, string>> = {
  nodes: 'nodes:details',
  'docker:tasks': 'docker:tasks',
};

/**
 * Scopes that stay outside every family. Folder-tree scopes grant folder visibility and folder
 * mutation, never item visibility (moving items still needs the item's own edit scope).
 */
const STANDALONE_SCOPES = new Set<string>([
  'storage:folders:manage',
  'domains:folders:manage',
  'proxy:folders:manage',
  'pages:folders:manage',
  'apps:folders:manage',
  'ssl:cert:folders:manage',
  'pki:ca:folders:manage',
  'pki:cert:folders:manage',
  'pki:templates:folders:manage',
  'proxy:templates:folders:manage',
  'nodes:folders:manage',
  'admin:users:folders:manage',
  'admin:groups:folders:manage',
  'docker:folders:manage',
  'databases:folders:manage',
  'logs:environments:folders:manage',
  'logs:schemas:folders:manage',
  'notifications:alerts:folders:manage',
  'notifications:webhooks:folders:manage',
  'acl:folders:manage',
  // Picks a stateful node as a backup runner; it does not make the node itself visible.
  'nodes:backups:execute',
  // A browser maintenance code for testing a Route in maintenance; it does not reveal Route config.
  'proxy:maintenance:bypass',
  // Registry push/pull credentials for CI; they do not reveal registry configuration.
  'docker:registries:internal:pull',
  'docker:registries:internal:push',
]);

/**
 * Explicit implications that the family rule does not derive: tiers within a family and the few
 * cross-family rules. Read as "the key scope is satisfied by any of the listed scopes".
 */
const EXPLICIT_IMPLICATIONS: Readonly<Record<string, readonly string[]>> = {
  // Object access tiers: admin ⊇ write ⊇ read.
  'storage:objects:read': ['storage:objects:write', 'storage:objects:admin'],
  'storage:objects:write': ['storage:objects:admin'],
  // Revealing the saved credentials is broader than letting a backup use them.
  'storage:credentials:use': ['storage:credentials:reveal'],
  // Query tiers: admin ⊇ write ⊇ read.
  'databases:query:read': ['databases:query:write', 'databases:query:admin'],
  'databases:query:write': ['databases:query:admin'],
  // Reading an environment's logs or managing its ingest tokens needs the environment itself.
  'logs:environments:view': ['logs:read', 'logs:tokens:view'],
  // Editing a node's nginx config needs to read it; reading it needs the node.
  'nodes:config:view': ['nodes:manage'],
  'nodes:details': ['nodes:config:view'],
  // Model management is part of provider administration.
  'inference:providers:view': ['inference:models:manage'],
  // Availability policies act on a container, deployment, or Compose workload.
  'docker:containers:view': ['docker:availability:manage'],
  // Secret values are delivered to the workload as environment variables, so a secrets holder already reads both.
  'docker:containers:environment': ['docker:containers:secrets'],
  // Snapshot mutations act on one existing VM and keep implying that VM's snapshot view.
  'hosting:snapshots:view': ['hosting:snapshots:create'],
  // Renewal was part of issue before it had its own scope; issue still renews, but never reveals certificates.
  'ssl:cert:renew': ['ssl:cert:issue'],
  // Exporting the private key covers letting nginx use it.
  'pki:cert:deploy': ['pki:cert:export'],
  // Linking a workload used to need these, so their holders keep it.
  'databases:bind': ['databases:edit'],
  'storage:bind': ['storage:iam'],
};

const CATALOG = new Set<string>(ALL_SCOPES);

function familyViewOf(prefix: string): string | null {
  const named = NAMED_FAMILY_VIEWS[prefix];
  if (named) return CATALOG.has(named) ? named : null;
  const view = `${prefix}:view`;
  return CATALOG.has(view) ? view : null;
}

function isFamilyView(scope: string): boolean {
  if (Object.values(NAMED_FAMILY_VIEWS).includes(scope)) return true;
  return scope.endsWith(':view');
}

/** The view scope an action scope implies, or null for views and standalone scopes. */
export function scopeFamilyView(scope: string): string | null {
  if (!CATALOG.has(scope) || STANDALONE_SCOPES.has(scope) || isFamilyView(scope)) return null;
  const parts = scope.split(':');
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const view = familyViewOf(parts.slice(0, length).join(':'));
    if (view && view !== scope) return view;
  }
  return null;
}

const DESTINATION_CREATION_SCOPES = new Set<string>([
  ...FOLDER_CREATION_SCOPES,
  // Issues certificates from a CA (qualified by the CA ID); it never reveals the certificates already issued.
  'pki:cert:issue',
]);

/** Whether a scope creates something: it names a destination and never implies a view. */
export function isCreationScope(scope: string): boolean {
  return DESTINATION_CREATION_SCOPES.has(scope) || scope.split(':').includes('create');
}

function buildDirectImplications(): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  const add = (required: string, implying: string) => {
    if (required === implying) return;
    if (!direct.has(required)) direct.set(required, new Set());
    direct.get(required)!.add(implying);
  };
  for (const scope of ALL_SCOPES) {
    if (isCreationScope(scope)) continue;
    const view = scopeFamilyView(scope);
    if (view) add(view, scope);
  }
  for (const [required, implying] of Object.entries(EXPLICIT_IMPLICATIONS)) {
    for (const scope of implying) add(required, scope);
  }
  return direct;
}

function buildTransitiveImplications(): Record<string, readonly string[]> {
  const direct = buildDirectImplications();
  const closure: Record<string, readonly string[]> = {};
  for (const required of [...direct.keys()].sort()) {
    const directlyImplying = direct.get(required)!;
    const result = new Set<string>();
    const queue = [...directlyImplying];
    for (let index = 0; index < queue.length; index += 1) {
      const scope = queue[index];
      if (scope === required || result.has(scope)) continue;
      if (isCreationScope(scope) && !directlyImplying.has(scope)) continue;
      result.add(scope);
      queue.push(...(direct.get(scope) ?? []));
    }
    closure[required] = [...result].sort();
  }
  return closure;
}

/**
 * Transitive closure: required base scope -> every base scope that satisfies it.
 * A qualified requirement `<required>:<id>` is satisfied by `<implying>`, `<implying>:<id>`, or,
 * for Docker child IDs, `<implying>:<nodeId>`.
 */
export const IMPLIED_SCOPES_BY_REQUIRED_SCOPE: Readonly<Record<string, readonly string[]>> = Object.freeze(
  buildTransitiveImplications()
);
