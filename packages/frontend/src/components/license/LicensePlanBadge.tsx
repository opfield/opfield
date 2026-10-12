import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  LICENSE_FEATURE_PLANS,
  LICENSE_PLAN_RANK,
  type LicenseFeature,
  type PaidLicensePlan,
} from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { entitlementsIncludeFeature } from "@/types/license-features";

const LABELS: Record<PaidLicensePlan, string> = {
  personal: "Personal",
  business: "Business",
  enterprise: "Enterprise",
};

const VARIANTS: Record<PaidLicensePlan, "secondary" | "info" | "default"> = {
  personal: "default",
  business: "info",
  enterprise: "default",
};

const DESCRIPTIONS: Record<PaidLicensePlan, string> = {
  personal: "This feature requires the Personal plan or higher.",
  business: "This feature requires the Business plan or higher.",
  enterprise: "This feature requires the Enterprise plan.",
};

export function LicensePlanBadge({ feature, label }: { feature: LicenseFeature; label?: string }) {
  const license = useUIBootstrapStore((state) => state.snapshot?.license);
  const plan = LICENSE_FEATURE_PLANS[feature];

  if (
    !license ||
    entitlementsIncludeFeature(license.entitlements.features, feature) ||
    LICENSE_PLAN_RANK[license.plan] >= LICENSE_PLAN_RANK[plan]
  ) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help" tabIndex={0}>
            <Badge size="inline" variant={VARIANTS[plan]}>
              {label ?? LABELS[plan]}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{DESCRIPTIONS[plan]}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
