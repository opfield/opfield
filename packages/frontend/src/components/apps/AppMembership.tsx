import { AppWindow } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appMembershipLabel } from "@/lib/app-members";
import { appRoute } from "@/lib/app-routes";
import type { AppMembershipRef } from "@/types";

/**
 * A member's app on per-node views (node detail pages keep listing members): "<app> · <env>",
 * opening the app page.
 */
export function AppMemberBadge({ app }: { app: AppMembershipRef }) {
  const label = appMembershipLabel(app);
  return (
    <Link
      to={appRoute(app.slug)}
      title={`Part of ${label}`}
      className="inline-flex min-w-0 shrink"
      onClick={(event) => event.stopPropagation()}
    >
      <Badge variant="outline" className="gap-1">
        <AppWindow className="h-3 w-3 shrink-0" />
        {label}
      </Badge>
    </Link>
  );
}

/**
 * "Part of <app> · <env>" on a member's detail page header. The membership names the environment
 * only by name, so the link opens the app page.
 */
export function AppMembershipLink({ app }: { app: AppMembershipRef }) {
  return (
    <Button variant="link" size="inline" asChild>
      <Link to={appRoute(app.slug)}>Part of {appMembershipLabel(app)}</Link>
    </Button>
  );
}
