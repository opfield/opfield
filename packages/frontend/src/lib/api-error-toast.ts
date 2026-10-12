import { toast } from "sonner";
import { ApiRequestError } from "@/services/api-base";
import { handleLicenseError } from "@/stores/license-paywall";

const LICENSE_DENIAL_CODES = new Set([
  "LICENSE_ENTITLEMENT_REQUIRED",
  "LICENSE_QUOTA_EXCEEDED",
  "COMMERCIAL_MODULE_UNAVAILABLE",
]);

/** A plan, quota, or commercial-module denial from the API. */
export function isLicenseDenial(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    error.code !== undefined &&
    LICENSE_DENIAL_CODES.has(error.code)
  );
}

function isLoadRequest(error: ApiRequestError): boolean {
  return error.method === "GET" || error.method === "HEAD";
}

/**
 * Reports a failed request. A plan denial on a load (GET/HEAD) stays silent: the
 * section shows its locked state instead. A plan denial on an action the user took
 * opens the upgrade dialog; every other failure becomes an error toast.
 */
export function toastApiError(error: unknown, fallback: string, capability = fallback): void {
  if (isLicenseDenial(error)) {
    if (isLoadRequest(error)) return;
    handleLicenseError(error, capability);
    return;
  }
  toast.error(error instanceof Error && error.message ? error.message : fallback);
}
