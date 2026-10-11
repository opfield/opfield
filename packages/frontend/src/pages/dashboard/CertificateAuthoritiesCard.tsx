import { Link } from "react-router-dom";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import type { CA } from "@/types";

interface CertificateAuthoritiesCardProps {
  cas: CA[] | null;
  hasScope: (scope: string) => boolean;
}

export function CertificateAuthoritiesCard({ cas, hasScope }: CertificateAuthoritiesCardProps) {
  // pki:ca:view is CA-scopable: show the CAs the caller may open.
  const visibleCas = (cas || [])
    .filter((ca) => ca.status === "active" && hasScope(`pki:ca:view:${ca.id}`))
    .slice(0, 6);
  if (visibleCas.length === 0) return null;

  return (
    <PanelShell
      title="Certificate Authorities"
      actions={
        <Link
          to="/certificates/authorities"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          View all
        </Link>
      }
    >
      <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
        {visibleCas.map((ca) => (
          <Link
            key={ca.id}
            to={`/cas/${ca.id}`}
            className="flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors"
          >
            <span className="text-sm font-medium truncate flex-1">{ca.commonName}</span>
            <Badge variant="secondary" size="inline">
              {ca.type === "root" ? "Root" : "Intermediate"}
            </Badge>
            <Badge variant="outline" size="inline">
              {ca.keyAlgorithm}
            </Badge>
            <Badge variant="secondary" size="inline">
              {ca.certCount || 0} certs
            </Badge>
          </Link>
        ))}
      </div>
    </PanelShell>
  );
}
