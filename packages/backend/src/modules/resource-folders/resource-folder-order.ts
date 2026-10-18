import { asc, type SQL, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';

type FolderTable = {
  id: any;
  parentId: any;
  sortOrder: any;
  name: any;
};

/**
 * Folder ids in the order the folder list shows them: top-level folders by sortOrder (then name), each followed by
 * its subfolders in the same order, depth first.
 */
export async function folderTreeOrder(db: DrizzleExecutor, folderTable: FolderTable): Promise<string[]> {
  const rows = (await (db as any)
    .select({ id: folderTable.id, parentId: folderTable.parentId })
    .from(folderTable)
    .orderBy(asc(folderTable.sortOrder), asc(folderTable.name))) as Array<{ id: string; parentId: string | null }>;
  const known = new Set(rows.map((row) => row.id));
  const children = new Map<string | null, string[]>();
  for (const row of rows) {
    const parent = row.parentId && known.has(row.parentId) ? row.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), row.id]);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null) => {
    for (const id of children.get(parent) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
      visit(id);
    }
  };
  visit(null);
  return ordered;
}

/**
 * ORDER BY terms that list resources like the folder list does: by their folder's place in the tree, ungrouped
 * resources after every folder, then by sortOrder and name inside a folder.
 */
export function folderListOrder(
  folderIds: readonly string[],
  resource: { folderId: any; sortOrder: any; name: any }
): SQL[] {
  // One array parameter in Postgres array syntax ({a,b}); folder ids are UUIDs.
  const folderPosition =
    folderIds.length > 0
      ? sql`array_position(${`{${folderIds.join(',')}}`}::uuid[], ${resource.folderId}) asc nulls last`
      : sql`1`;
  return [folderPosition, asc(resource.sortOrder), asc(resource.name)];
}
