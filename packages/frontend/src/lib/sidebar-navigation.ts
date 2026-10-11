function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Whether a sidebar item is the current page. `activePaths` lists the item's other URL prefixes,
 * such as the tabs and detail pages of the Routes and Certificates pages.
 */
export function isSidebarNavigationActive(
  pathname: string,
  href: string,
  activePaths: readonly string[] = []
): boolean {
  if (href === "/") {
    return pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  }
  return isUnder(pathname, href) || activePaths.some((prefix) => isUnder(pathname, prefix));
}
