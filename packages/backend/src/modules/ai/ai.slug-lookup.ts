import { AppError } from '@/middleware/error-handler.js';

/**
 * A by-slug tool resolves the slug before it can check the caller's grant on the resource. A caller who may not
 * view the resource gets the same answer as for a slug that does not exist, so a limited principal cannot probe
 * which slugs exist.
 */
export async function resolveSlugVisibleTo<T extends { id: string }>(
  label: string,
  lookup: () => Promise<T>,
  canView: (id: string) => boolean
): Promise<T> {
  let found: T;
  try {
    found = await lookup();
  } catch (error) {
    if ((error as { statusCode?: unknown } | null)?.statusCode === 404) throw slugNotFound(label);
    throw error;
  }
  if (!canView(found.id)) throw slugNotFound(label);
  return found;
}

function slugNotFound(label: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${label} not found`);
}
