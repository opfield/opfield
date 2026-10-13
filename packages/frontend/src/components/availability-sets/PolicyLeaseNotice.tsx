import { useState } from "react";
import { toast } from "sonner";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { RECOMMENDED_POLICY_LEASE_HOURS } from "./availability-labels";

/**
 * Failover runs without Opfield only as long as relay policies last (the relay policy lease).
 * Below 7 days the notice offers "Set to 7 days" to admins; it never changes it by itself.
 */
export function PolicyLeaseNotice({ hours }: { hours: number | null }) {
  const canEditSettings = useAuthStore((state) => state.hasScope("settings:opfield:edit"));
  const [override, setOverride] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const current = override ?? hours;
  if (current === null || current >= RECOMMENDED_POLICY_LEASE_HOURS) return null;

  const setToSevenDays = async () => {
    setSaving(true);
    try {
      await api.updateAuthProvisioningSettings({
        generalSettings: { relayPolicyLeaseHours: RECOMMENDED_POLICY_LEASE_HOURS },
      });
      setOverride(RECOMMENDED_POLICY_LEASE_HOURS);
      toast.success("Relay policies now last 7 days");
    } catch (error) {
      toastApiError(error, "Failed to change the relay policy lease");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Notice
      tone="warning"
      title={`Failover works without Opfield for ${current} h`}
      actions={
        canEditSettings ? (
          <NoticeAction tone="warning" pending={saving} onClick={() => void setToSevenDays()}>
            Set to 7 days
          </NoticeAction>
        ) : null
      }
    >
      That is how long relay policies last. Set them to 7 days for a longer bound.
    </Notice>
  );
}
