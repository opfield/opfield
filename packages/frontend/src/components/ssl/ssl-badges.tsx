import { Badge } from "@/components/ui/badge";
import type { SSLCertStatus, SSLCertType } from "@/types";

/** The certificate type as the certificate lists show it. */
export function SSLTypeBadge({ type }: { type: SSLCertType }) {
  switch (type) {
    case "acme":
      return <Badge variant="success">ACME</Badge>;
    case "upload":
      return <Badge variant="secondary">UPLOAD</Badge>;
    case "internal":
      return <Badge variant="default">INTERNAL</Badge>;
    default:
      return <Badge variant="secondary">{type}</Badge>;
  }
}

/** The certificate status as the certificate lists show it. */
export function SSLStatusBadge({ status }: { status: SSLCertStatus }) {
  switch (status) {
    case "active":
      return <Badge variant="success">Active</Badge>;
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    case "pending":
      return <Badge variant="warning">Pending</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}
