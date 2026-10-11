import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requireLicenseFeature } from "@/stores/license-paywall";
import { AVAILABILITY_CAPABILITY, AVAILABILITY_FEATURE } from "./availability-labels";

export type AvailabilityServers = "single" | "several";

/**
 * The create forms' "Availability" choice: one server, or two or more servers with a copy
 * (Business). Picking several servers adds the Availability step.
 */
export function AvailabilityServersSelect({
  value,
  onChange,
  disabled,
}: {
  value: AvailabilityServers;
  onChange: (value: AvailabilityServers) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm font-medium" htmlFor="availability-servers">
        Availability
        <LicensePlanBadge feature={AVAILABILITY_FEATURE} />
      </label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (
            next === "several" &&
            !requireLicenseFeature(AVAILABILITY_FEATURE, AVAILABILITY_CAPABILITY)
          ) {
            return;
          }
          onChange(next as AvailabilityServers);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="availability-servers">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="single" description="No copy; the server's disk holds the only data.">
            Single server
          </SelectItem>
          <SelectItem value="several" description="A copy on another server takes over on failure.">
            Two or more servers
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
