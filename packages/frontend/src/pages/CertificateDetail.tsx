import { Copy, Download, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { IssuingCABadge } from "@/components/certificates/IssuingCABadge";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { DetailRow } from "@/components/common/DetailRow";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { daysUntil, formatDate, formatSerialNumber, hoursUntil } from "@/lib/utils";
import { api } from "@/services/api";
import type { CertificateExportFormat } from "@/services/api-pki";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import type { Certificate } from "@/types";

export function CertificateDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const { cas, fetchCAs } = useCAStore();
  const [cert, setCert] = useState<Certificate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // The CA list names the issuing CA, as on the certificate list.
  const canListCAs = hasScopedAccess("pki:ca:view") || hasScopedAccess("pki:cert:issue");

  useEffect(() => {
    if (canListCAs) void fetchCAs();
  }, [canListCAs, fetchCAs]);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      setIsLoading(true);
      try {
        const data = await api.getCertificate(id);
        setCert(data);
      } catch (_err) {
        toast.error("Failed to load certificate");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [id]);

  useRealtime(id ? "cert.changed" : null, (payload) => {
    const ev = payload as { id?: string };
    if (!id || ev?.id !== id) return;
    api
      .getCertificate(id)
      .then(setCert)
      .catch(() => {
        toast.error("Failed to load certificate");
      });
  });

  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("unspecified");
  const [isRevoking, setIsRevoking] = useState(false);
  const [pkcs12DialogOpen, setPkcs12DialogOpen] = useState(false);
  const [pkcs12Passphrase, setPkcs12Passphrase] = useState("");
  const [downloadingFormat, setDownloadingFormat] = useState<CertificateExportFormat | null>(null);

  const handleRevoke = async () => {
    if (!cert) return;
    setIsRevoking(true);
    try {
      await api.revokeCertificate(cert.id, revokeReason);
      const updated = await api.getCertificate(cert.id);
      setCert(updated);
      toast.success("Certificate revoked");
      setRevokeDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke");
    } finally {
      setIsRevoking(false);
    }
  };

  const handleDownload = async (format: CertificateExportFormat, passphrase?: string) => {
    if (!cert) return;
    if (format === "pkcs12" && !passphrase?.trim()) {
      setPkcs12Passphrase("");
      setPkcs12DialogOpen(true);
      return;
    }
    setDownloadingFormat(format);
    try {
      const blob = await api.exportCertificate(cert.id, format, passphrase);
      const filenameByFormat: Record<CertificateExportFormat, string> = {
        pem: `${cert.commonName}.pem`,
        der: `${cert.commonName}.der`,
        pkcs12: `${cert.commonName}.p12`,
        jks: `${cert.commonName}.jks`,
        chain: `${cert.commonName}-chain.pem`,
        fullchain: `${cert.commonName}-fullchain.pem`,
        "private-key": `${cert.commonName}-private-key.pem`,
        "pem-bundle": `${cert.commonName}-pem.zip`,
      };
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameByFormat[format];
      a.click();
      URL.revokeObjectURL(url);
      if (format === "pkcs12") {
        setPkcs12DialogOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download certificate");
    } finally {
      setDownloadingFormat(null);
    }
  };

  const handlePkcs12Download = () => {
    if (downloadingFormat === "pkcs12") return;
    if (!pkcs12Passphrase.trim()) {
      toast.error("Passphrase required for PKCS#12 export");
      return;
    }
    void handleDownload("pkcs12", pkcs12Passphrase);
  };

  if (isLoading) return <CertificateDetailSkeleton />;

  if (!cert) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Certificate not found</p>
      </div>
    );
  }

  const expiryDays = daysUntil(cert.notAfter);
  const canExportCertificate =
    hasScope(`pki:cert:export:${cert.id}`) || hasScope("pki:cert:export");
  const canRevokeCertificate =
    hasScope(`pki:cert:revoke:${cert.id}`) || hasScope("pki:cert:revoke");
  const copySerial = () => {
    void navigator.clipboard.writeText(cert.serialNumber);
    toast.success("Serial number copied");
  };
  const copyPem = () => {
    void navigator.clipboard.writeText(cert.certificatePem || "");
    toast.success("PEM copied to clipboard");
  };

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-6">
        <PageHeader
          leading={<PageBackButton onClick={() => navigate("/certificates/pki")} />}
          title={cert.commonName}
          badges={
            <>
              <StatusBadge status={cert.status} size="inline" />
              {cert.isSystem && (
                <Badge variant="outline" size="inline">
                  System
                </Badge>
              )}
            </>
          }
          description={
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0">{cert.type} certificate &middot; Issuer:</span>
              <IssuingCABadge
                certificate={cert}
                ca={cas.find((ca) => ca.id === cert.caId)}
                size="inline"
              />
            </span>
          }
          actions={
            <ResponsiveHeaderActions
              actions={[
                ...(canExportCertificate
                  ? [
                      {
                        id: "certificate:download-pem-bundle",
                        label: "Download PEM bundle (ZIP)",
                        icon: <Download className="h-4 w-4" />,
                        onClick: () => void handleDownload("pem-bundle"),
                      },
                      {
                        id: "certificate:download-pem",
                        label: "Download certificate as PEM",
                        icon: <Download className="h-4 w-4" />,
                        onClick: () => void handleDownload("pem"),
                      },
                      {
                        id: "certificate:download-der",
                        label: "Download certificate as DER",
                        icon: <Download className="h-4 w-4" />,
                        onClick: () => void handleDownload("der"),
                      },
                      {
                        id: "certificate:download-chain",
                        label: "Download intermediate CA chain",
                        icon: <Download className="h-4 w-4" />,
                        onClick: () => void handleDownload("chain"),
                      },
                      {
                        id: "certificate:download-fullchain",
                        label: "Download full chain as PEM",
                        icon: <Download className="h-4 w-4" />,
                        onClick: () => void handleDownload("fullchain"),
                      },
                      {
                        id: "certificate:download-private-key",
                        label: "Download private key as PEM",
                        icon: <Download className="h-4 w-4" />,
                        onClick: () => void handleDownload("private-key"),
                      },
                      {
                        id: "certificate:download-pkcs12",
                        label: "Download certificate as PKCS#12",
                        icon: <Download className="h-4 w-4" />,
                        onClick: () => setPkcs12DialogOpen(true),
                      },
                    ]
                  : []),
                {
                  id: "certificate:copy-serial",
                  label: "Copy certificate serial",
                  icon: <Copy className="h-4 w-4" />,
                  onClick: copySerial,
                },
                ...(canExportCertificate && cert.certificatePem
                  ? [
                      {
                        id: "certificate:copy-pem",
                        label: "Copy certificate PEM",
                        icon: <Copy className="h-4 w-4" />,
                        onClick: copyPem,
                      },
                    ]
                  : []),
                ...(canRevokeCertificate && cert.status === "active" && !cert.isSystem
                  ? [
                      {
                        id: "certificate:revoke",
                        label: "Revoke certificate",
                        icon: <ShieldOff className="h-4 w-4" />,
                        onClick: () => setRevokeDialogOpen(true),
                        destructive: true,
                        separatorBefore: true,
                      },
                    ]
                  : []),
              ]}
            >
              {canExportCertificate && (
                <>
                  <Button variant="outline" onClick={() => void handleDownload("pem-bundle")}>
                    <Download className="h-4 w-4" />
                    Download PEM bundle
                  </Button>
                  <Button variant="outline" onClick={() => void handleDownload("pem")}>
                    <Download className="h-4 w-4" />
                    Download PEM
                  </Button>
                  <Button variant="outline" onClick={() => void handleDownload("der")}>
                    <Download className="h-4 w-4" />
                    Download DER
                  </Button>
                  <Button variant="outline" onClick={() => void handleDownload("chain")}>
                    <Download className="h-4 w-4" />
                    Download intermediate CA chain
                  </Button>
                  <Button variant="outline" onClick={() => void handleDownload("fullchain")}>
                    <Download className="h-4 w-4" />
                    Download full chain
                  </Button>
                  <Button variant="outline" onClick={() => void handleDownload("private-key")}>
                    <Download className="h-4 w-4" />
                    Download private key
                  </Button>
                  <Button variant="outline" onClick={() => setPkcs12DialogOpen(true)}>
                    <Download className="h-4 w-4" />
                    Download PKCS#12
                  </Button>
                </>
              )}
              <Button variant="outline" onClick={copySerial}>
                <Copy className="h-4 w-4" />
                Copy Serial Number
              </Button>
              {canExportCertificate && cert.certificatePem && (
                <Button variant="outline" onClick={copyPem}>
                  <Copy className="h-4 w-4" />
                  Copy PEM
                </Button>
              )}
              {canRevokeCertificate && cert.status === "active" && !cert.isSystem && (
                <Button variant="destructive" onClick={() => setRevokeDialogOpen(true)}>
                  <ShieldOff className="h-4 w-4" />
                  Revoke Certificate
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <PanelShell title="Certificate Details" bodyClassName="divide-y divide-border">
            <DetailRow label="Common Name" value={cert.commonName} />
            {cert.subjectDn && <DetailRow label="Subject DN" value={cert.subjectDn} />}
            {cert.issuerDn && <DetailRow label="Issuer DN" value={cert.issuerDn} />}
            <DetailRow label="Serial Number" value={formatSerialNumber(cert.serialNumber)} />
            <DetailRow label="Key Algorithm" value={cert.keyAlgorithm} />
            {cert.templateId && <DetailRow label="Template ID" value={cert.templateId} />}
            <DetailRow label="Issued By" value={cert.issuedById || "—"} />
          </PanelShell>

          <PanelShell title="Validity & Usage" bodyClassName="divide-y divide-border">
            <DetailRow label="Valid From" value={formatDate(cert.notBefore)} />
            <DetailRow label="Valid Until" value={formatDate(cert.notAfter)} />
            <DetailRow
              label="Validity"
              value={
                <span>
                  {expiryDays > 0
                    ? `Expires in ${expiryDays} days`
                    : hoursUntil(cert.notAfter) > 0
                      ? `Expires in ${hoursUntil(cert.notAfter)} hours`
                      : "Expired"}
                </span>
              }
            />
            {cert.revokedAt && (
              <>
                <DetailRow label="Revoked At" value={<RelativeTime value={cert.revokedAt} />} />
                <DetailRow
                  label="Revocation Reason"
                  value={cert.revocationReason || "unspecified"}
                />
              </>
            )}
            {(cert.sans?.length ?? 0) > 0 && (
              <DetailRow
                label="SANs"
                value={
                  <span className="flex max-w-full flex-col items-end gap-1">
                    {cert.sans.map((san, i) => (
                      <span key={i} className="max-w-full break-all">
                        {san}
                      </span>
                    ))}
                  </span>
                }
              />
            )}
            {(cert.keyUsage?.length ?? 0) > 0 && (
              <DetailRow
                label="Key Usage"
                value={
                  <span className="flex max-w-full flex-wrap justify-end gap-1">
                    {cert.keyUsage.map((ku) => (
                      <Badge key={ku} variant="secondary">
                        {ku}
                      </Badge>
                    ))}
                  </span>
                }
              />
            )}
            {(cert.extKeyUsage?.length ?? 0) > 0 && (
              <DetailRow
                label="Extended Key Usage"
                value={
                  <span className="flex max-w-full flex-wrap justify-end gap-1">
                    {cert.extKeyUsage.map((eku) => (
                      <Badge key={eku} variant="secondary">
                        {eku}
                      </Badge>
                    ))}
                  </span>
                }
              />
            )}
          </PanelShell>
        </div>
        {/* Revoke Dialog */}
        <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Revoke Certificate</DialogTitle>
              <DialogDescription>
                Select a reason for revocation. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Select value={revokeReason} onValueChange={setRevokeReason}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unspecified">Unspecified</SelectItem>
                  <SelectItem value="keyCompromise">Key Compromise</SelectItem>
                  <SelectItem value="caCompromise">CA Compromise</SelectItem>
                  <SelectItem value="affiliationChanged">Affiliation Changed</SelectItem>
                  <SelectItem value="superseded">Superseded</SelectItem>
                  <SelectItem value="cessationOfOperation">Cessation of Operation</SelectItem>
                  <SelectItem value="certificateHold">Certificate Hold</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRevokeDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleRevoke} pending={isRevoking}>
                Revoke
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={pkcs12DialogOpen}
          onOpenChange={(open) => {
            if (downloadingFormat === "pkcs12") return;
            setPkcs12DialogOpen(open);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Export PKCS#12</DialogTitle>
              <DialogDescription>
                Enter a passphrase to protect the exported certificate archive.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Passphrase</label>
              <Input
                type="password"
                value={pkcs12Passphrase}
                onChange={(event) => setPkcs12Passphrase(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handlePkcs12Download();
                }}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setPkcs12DialogOpen(false);
                }}
                disabled={downloadingFormat === "pkcs12"}
              >
                Cancel
              </Button>
              <Button
                onClick={handlePkcs12Download}
                disabled={!pkcs12Passphrase.trim()}
                pending={downloadingFormat === "pkcs12"}
              >
                Export
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PageTransition>
  );
}

function CertificateDetailSkeleton() {
  return <DetailPageSkeleton label="Loading certificate" />;
}
