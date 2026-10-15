/**
 * Node types that can be locked for new services ("Lock new services"): nginx and Docker nodes take no new routes or
 * containers, a Build Worker takes no new builds (the builds it runs finish).
 */
export function nodeSupportsServiceCreationLock(type: string | null | undefined): boolean {
  return type === "nginx" || type === "docker" || type === "builder";
}
