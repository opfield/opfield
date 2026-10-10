import type { AppCreateContext } from "@/components/apps/app-create-context";

/** What "New" / a section's create action / AddRow asks to create inside an app. */
export type AppCreateType =
  | "container"
  | "compose"
  | "database"
  | "storage"
  | "route"
  | "pages"
  | "container-link";

export interface AppCreateRequest {
  type: AppCreateType;
  /** The environment group the action was started from; else last used / Production. */
  environmentId?: string | null;
}

/**
 * Hosts the product create dialogs with `appContext` (locked App, environment select, allowed
 * nodes only, placement folder). Compose navigates to the editor with `?app=&env=`.
 * STUB: implemented by tasks T19/T20.
 */
export function AppCreateDialogs(_props: {
  context: AppCreateContext;
  request: AppCreateRequest | null;
  onClose: () => void;
  onCreated?: () => void;
}) {
  return null;
}
