import type { AppPlaceMemberInput } from "@/types";

/**
 * Move to App (canvas frame move-to-app): "No app" + the apps the user may manage, then the
 * environment (last used / Production). Refused members are reported. Opened from a row menu of
 * a normal list (non-members) and from the app tabs (members).
 * STUB: implemented by task T24.
 */
export interface MoveToAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One row or several. */
  members: AppPlaceMemberInput[];
  /** Name shown in the description ("Select an app for <label> …"). */
  resourceLabel: string;
  /** The member's current app (preselected; "No app" takes it out). */
  currentAppId?: string | null;
  onMoved?: () => void;
}

export function MoveToAppDialog(_props: MoveToAppDialogProps) {
  return null;
}
