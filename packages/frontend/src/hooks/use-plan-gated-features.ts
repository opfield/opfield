import { canServeLicenseFeature } from "@/stores/license-paywall";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";

/**
 * Internal PKI and SIEM have an on/off switch that defaults to on, and a plan that may not
 * include them. Their screens, tabs and navigation show only when both allow it.
 */
export function usePkiAvailable(): boolean {
  const enabled = useSystemConfigStore((state) => state.config.features.pkiEnabled);
  const licensed = useUIBootstrapStore((state) =>
    canServeLicenseFeature(state.snapshot, "internal-pki")
  );
  return enabled && licensed;
}

export function useSiemAvailable(): boolean {
  const enabled = useSystemConfigStore((state) => state.config.features.siemEnabled);
  const licensed = useUIBootstrapStore((state) =>
    canServeLicenseFeature(state.snapshot, "siem-export")
  );
  return enabled && licensed;
}

/** {@link usePkiAvailable} outside React. */
export function pkiAvailable(): boolean {
  return (
    useSystemConfigStore.getState().config.features.pkiEnabled &&
    canServeLicenseFeature(useUIBootstrapStore.getState().snapshot, "internal-pki")
  );
}
