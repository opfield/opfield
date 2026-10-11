import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/stores/auth";
import { type PaidLicensePlan, useLicensePaywallStore } from "@/stores/license-paywall";
import type { LicensePlan } from "@/types";

const PLAN_LABELS: Record<LicensePlan, string> = {
  community: "Community",
  personal: "Personal",
  business: "Business",
  enterprise: "Enterprise",
};

function planLabel(plan: PaidLicensePlan): string {
  return PLAN_LABELS[plan];
}

export function LicenseUpgradeDialog() {
  const navigate = useNavigate();
  const request = useLicensePaywallStore((state) => state.request);
  const close = useLicensePaywallStore((state) => state.close);
  const canManageLicense = useAuthStore((state) => state.hasScope("license:manage"));
  const [renderedRequest, setRenderedRequest] = useState(request);

  useEffect(() => {
    if (request) setRenderedRequest(request);
  }, [request]);

  const goToLicense = () => {
    close();
    navigate("/settings/general", { state: { scrollTarget: "gateway-license" } });
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-md"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            setRenderedRequest(null);
          }
        }}
      >
        {renderedRequest ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {renderedRequest.reason === "module-unavailable"
                  ? "Paid Features Unavailable"
                  : `${planLabel(renderedRequest.requiredPlan)} Plan Required`}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <p className="text-sm text-muted-foreground">
                {renderedRequest.reason === "module-unavailable"
                  ? `${renderedRequest.capability} is unavailable because this installation's paid features are not ready. Check license settings to restore access.`
                  : `${renderedRequest.capability} requires the ${planLabel(renderedRequest.requiredPlan)} plan. This Opfield installation is currently on the ${PLAN_LABELS[renderedRequest.currentPlan]} plan.`}
              </p>
              {renderedRequest.quota?.limit !== undefined ? (
                <p className="text-sm text-muted-foreground">
                  The current plan limit is {renderedRequest.quota.limit}
                  {renderedRequest.quota.resource ? ` for ${renderedRequest.quota.resource}` : ""}.
                </p>
              ) : null}
              {!canManageLicense ? (
                <p className="text-sm text-muted-foreground">
                  {renderedRequest.reason === "module-unavailable"
                    ? "Contact your administrator to restore access."
                    : "Contact your administrator to upgrade the Opfield license."}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Close
              </Button>
              {canManageLicense ? (
                <Button onClick={goToLicense}>
                  <KeyRound className="h-4 w-4" />
                  {renderedRequest.reason === "module-unavailable"
                    ? "Open license settings"
                    : "Upgrade license key"}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
