import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CreationFolderChoices } from "@/lib/creation-folders";
import type { AppDetail, AppEnvironmentDetail, AppMemberFamily } from "@/types";

/**
 * Passed to a create dialog opened from an app: the App field is locked, the environment is
 * picked (last used per app), nodes are limited to the environment's allowed nodes and the new
 * resource is placed into the environment's hidden folder (`placementFolderIds[family]`).
 */
export interface AppCreateContext {
  app: Pick<AppDetail, "id" | "slug" | "name">;
  environments: AppEnvironmentDetail[];
  /** The environment to start with (the group the user clicked); else the last used one. */
  environmentId?: string | null;
}

const LAST_ENV_KEY = (appId: string) => `apps:last-environment:${appId}`;

export function readLastAppEnvironment(appId: string): string | null {
  try {
    return window.localStorage.getItem(LAST_ENV_KEY(appId));
  } catch {
    return null;
  }
}

export function rememberAppEnvironment(appId: string, environmentId: string): void {
  try {
    window.localStorage.setItem(LAST_ENV_KEY(appId), environmentId);
  } catch {
    // Private mode or a full quota only loses the default.
  }
}

/** The initial environment: the requested one, else the last used one, else Production. */
export function initialAppEnvironment(context: AppCreateContext): AppEnvironmentDetail | null {
  const { environments } = context;
  const byId = (id: string | null | undefined) =>
    id ? environments.find((env) => env.id === id) : undefined;
  return (
    byId(context.environmentId) ??
    byId(readLastAppEnvironment(context.app.id)) ??
    environments.find((env) => env.isProduction) ??
    environments[0] ??
    null
  );
}

/**
 * Environment choice of a create dialog; changing it is remembered per app. A dialog that stays
 * mounted passes `open`: each time it opens, the choice starts again from the requested
 * environment (else the last used one, else Production).
 */
export function useAppEnvironmentChoice(
  context: AppCreateContext | null | undefined,
  open?: boolean
) {
  const [environmentId, setEnvironmentIdState] = useState<string | null>(() =>
    context ? (initialAppEnvironment(context)?.id ?? null) : null
  );
  const contextRef = useRef(context);
  contextRef.current = context;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current && contextRef.current) {
      setEnvironmentIdState(initialAppEnvironment(contextRef.current)?.id ?? null);
    }
    wasOpen.current = open;
  }, [open]);
  const environment = useMemo(
    () => context?.environments.find((env) => env.id === environmentId) ?? null,
    [context, environmentId]
  );
  const setEnvironmentId = useCallback(
    (id: string) => {
      setEnvironmentIdState(id);
      if (context) rememberAppEnvironment(context.app.id, id);
    },
    [context]
  );
  return { environment, environmentId, setEnvironmentId };
}

/** `folderId` to send so the new resource lands in the environment. */
export function appPlacementFolderId(
  environment: AppEnvironmentDetail | null,
  family: AppMemberFamily
): string | null {
  return environment?.placementFolderIds[family] ?? null;
}

/** The environment's allowed nodes among `nodes` (already filtered to the needed node type). */
export function allowedAppNodes<T extends { id: string }>(
  environment: AppEnvironmentDetail | null,
  nodes: readonly T[]
): T[] {
  if (!environment) return [...nodes];
  const allowed = new Set(environment.allowedNodeIds);
  return nodes.filter((node) => allowed.has(node.id));
}

/**
 * Folder choices of a create dialog opened from an app: only the root ("No folder") is shown;
 * the request sends the environment's placement folder instead (`appPlacementFolderId`).
 */
export const APP_FOLDER_CHOICES: CreationFolderChoices = {
  allowRoot: true,
  folders: [],
  defaultFolderId: "",
};

/** Remember the environment a resource was created in, as the app's last used one. */
export function rememberAppCreation(
  context: AppCreateContext | null | undefined,
  environment: Pick<AppEnvironmentDetail, "id"> | null
): void {
  if (context && environment) rememberAppEnvironment(context.app.id, environment.id);
}

export function environmentLabel(env: Pick<AppEnvironmentDetail, "name" | "isProduction">) {
  return env.isProduction ? `${env.name} · Production` : env.name;
}
