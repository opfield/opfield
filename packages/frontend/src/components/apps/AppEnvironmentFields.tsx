import { useNavigate } from "react-router-dom";
import { Notice, NoticeAction } from "@/components/common/Notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { appEnvironmentRoute } from "@/lib/app-routes";
import type { AppEnvironmentDetail } from "@/types";
import { type AppCreateContext, environmentLabel } from "./app-create-context";

/**
 * The App (locked) and Environment fields a create dialog shows when it is opened from an app.
 * Canvas: `.design/canvas/apps` frames deploy-one / deploy-several / create-pages.
 */
export function AppEnvironmentFields({
  context,
  environmentId,
  onEnvironmentChange,
  hint,
  disabled,
}: {
  context: AppCreateContext;
  environmentId: string | null;
  onEnvironmentChange: (environmentId: string) => void;
  /** Defaults to "Opened from <app>. The environment decides which nodes are offered." */
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="app-create-app">
            App
          </label>
          <Select value="app" disabled>
            <SelectTrigger id="app-create-app" aria-label="App">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="app">{context.app.name}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="app-create-environment">
            Environment
          </label>
          <Select
            value={environmentId ?? undefined}
            onValueChange={onEnvironmentChange}
            disabled={disabled}
          >
            <SelectTrigger id="app-create-environment" aria-label="Environment">
              <SelectValue placeholder="Select an environment" />
            </SelectTrigger>
            <SelectContent>
              {context.environments.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  {environmentLabel(env)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {hint ??
          `Opened from ${context.app.name}. The environment decides which nodes are offered.`}
      </p>
    </div>
  );
}

/** Node field hint under a node picker limited by the environment's allowlist. */
export function allowedNodesHint(
  environment: Pick<AppEnvironmentDetail, "name">,
  count: number,
  nodeKind: string
): string {
  return count === 1
    ? `The only ${nodeKind} node allowed in ${environment.name}.`
    : `Only the ${count} ${nodeKind} nodes allowed in ${environment.name} are offered.`;
}

/**
 * No node of the needed type is allowed in the environment: creation is blocked.
 * "Allow a node" opens the environment page with Allow Node open.
 */
export function NoAllowedNodeNotice({
  context,
  environment,
  nodeKind,
  resourceKind,
  onNavigate,
}: {
  context: AppCreateContext;
  environment: Pick<AppEnvironmentDetail, "name" | "slug">;
  /** "Docker", "storage", "nginx" … */
  nodeKind: string;
  /** "Containers", "Databases" … (plural, capitalised). */
  resourceKind: string;
  /** Called before navigating (close the dialog). */
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Notice
      tone="warning"
      title={`No ${nodeKind} node is allowed in ${environment.name}`}
      actions={
        <NoticeAction
          tone="warning"
          onClick={() => {
            onNavigate?.();
            navigate(appEnvironmentRoute(context.app.slug, environment.slug, { allowNode: true }));
          }}
        >
          Allow a node
        </NoticeAction>
      }
    >
      {resourceKind} of {environment.name} run only on its allowed nodes. Allow one first.
    </Notice>
  );
}
