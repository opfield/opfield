const segment = (value: string) => encodeURIComponent(value);

export const APP_TABS = [
  "overview",
  "compute",
  "data",
  "network",
  "nodes",
  "activity",
  "settings",
] as const;
export type AppTab = (typeof APP_TABS)[number];

export const appsRoute = () => "/apps";

export const appRoute = (appSlug: string, tab?: AppTab | string) =>
  tab && tab !== "overview"
    ? `/apps/${segment(appSlug)}/${segment(tab)}`
    : `/apps/${segment(appSlug)}`;

/** `allowNode`: the environment page opens Allow Node on arrival (from a blocked create dialog). */
export const appEnvironmentRoute = (
  appSlug: string,
  envSlug: string,
  options: { allowNode?: boolean } = {}
) => `/apps/${segment(appSlug)}/env/${segment(envSlug)}${options.allowNode ? "?allow=node" : ""}`;
