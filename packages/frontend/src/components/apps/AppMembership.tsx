import { AppWindow } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appMembershipLabel } from "@/lib/app-members";
import { appEnvironmentRoute, appRoute } from "@/lib/app-routes";
import type { AppMembershipRef } from "@/types";

/** The member's environment page when the membership names its slug, else the app page. */
function membershipRoute(app: AppMembershipRef) {
  return app.environmentSlug
    ? appEnvironmentRoute(app.slug, app.environmentSlug)
    : appRoute(app.slug);
}

/**
 * A member's app on per-node views (node detail pages keep listing members): "<app> · <env>",
 * opening the app page.
 */
export function AppMemberBadge({ app }: { app: AppMembershipRef }) {
  const label = appMembershipLabel(app);
  return (
    <Link
      to={membershipRoute(app)}
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
 * "Part of <app> · <env>" on a member's detail page header, opening the environment's page.
 */
export function AppMembershipLink({ app }: { app: AppMembershipRef }) {
  return (
    <Button variant="link" size="inline" asChild>
      <Link to={membershipRoute(app)}>Part of {appMembershipLabel(app)}</Link>
    </Button>
  );
}
