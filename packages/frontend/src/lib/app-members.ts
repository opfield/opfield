import type { AppMembershipRef } from "@/types";

/**
 * App members are hidden from the normal lists (Docker, Routes, Databases, Storage, Pages, their
 * folder trees and counts); they show on their app's page. Per-node views keep them with an app
 * badge. List endpoints filter on the server (`excludeAppMembers`); `withoutAppMembers` guards the
 * client against a server that still returns them.
 */
export interface AppMemberListFilter {
  /** Leave out resources that belong to an app. */
  excludeAppMembers?: boolean;
  /** Only the members of this app (any environment); wins over `excludeAppMembers`. */
  appId?: string;
}

/** The filter the normal lists send. */
export const NORMAL_LIST_FILTER: AppMemberListFilter = { excludeAppMembers: true };

export function setAppMemberListParams(
  params: URLSearchParams,
  filter: AppMemberListFilter | undefined
): void {
  if (filter?.appId) params.set("appId", filter.appId);
  else if (filter?.excludeAppMembers) params.set("excludeAppMembers", "true");
}

export interface MaybeAppMember {
  app?: AppMembershipRef | null;
}

export function isAppMember(item: MaybeAppMember): boolean {
  return Boolean(item.app);
}

/** The items outside apps; the same array when none is a member. */
export function withoutAppMembers<T extends MaybeAppMember>(items: T[]): T[] {
  return items.some(isAppMember) ? items.filter((item) => !isAppMember(item)) : items;
}

/** "Shop · production" */
export function appMembershipLabel(app: Pick<AppMembershipRef, "name" | "environmentName">) {
  return `${app.name} · ${app.environmentName}`;
}
