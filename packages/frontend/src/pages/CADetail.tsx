import { Copy, Download, Pencil, Plus, Shield, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { CACreateDialog } from "@/components/ca/CACreateDialog";
import { CertificateIssueDialog } from "@/components/certificates/CertificateIssueDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
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
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { daysUntil, formatDate, formatSerialNumber, hoursUntil } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useUIStore } from "@/stores/ui";
import type { Certificate } from "@/types";

const INSTALL_COMMAND_CLASS = "min-h-0 whitespace-pre-wrap break-all font-mono text-xs";

export function CADetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();
  const { selectedCA, selectCA, fetchCAs, cas } = useCAStore();
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [createIntermediateOpen, setCreateIntermediateOpen] = useState(false);
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const [endpointsDialogOpen, setEndpointsDialogOpen] = useState(false);
  const [epCrlUrl, setEpCrlUrl] = useState("");
  const [epCaIssuersUrl, setEpCaIssuersUrl] = useState("");
  const [isSavingEndpoints, setIsSavingEndpoints] = useState(false);

  const reloadCerts = useCallback(async () => {
    if (!id) return;
    try {
      const certs = await api.listCertificates({
        caId: id,
        limit: 10,
        showSystem: showSystemCertificates,
      });
      setCertificates(certs.data || []);
    } catch {}
  }, [id, showSystemCertificates]);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      setIsLoading(true);
      try {
        // Child CAs come from the CA list, which a direct visit has not loaded yet.
        await Promise.all([
          selectCA(id),
          reloadCerts(),
          useCAStore.getState().cas.length === 0 ? fetchCAs() : undefined,
        ]);
      } catch {
        toast.error("Failed to load CA details");
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, [fetchCAs, id, reloadCerts, selectCA]);

  useRealtime("ca.changed", (payload) => {
    if (!id) return;
    const ev = payload as { id?: string; action?: string };
    fetchCAs();
    if (ev?.id === id && ev.action !== "deleted") {
      void selectCA(id);
    }
    if (ev?.id === id && ev.action === "deleted") {
      toast.info("Certificate Authority was deleted");
      navigate("/certificates/authorities");
    }
  });

  useRealtime("cert.changed", (payload) => {
    if (!id) return;
    const ev = payload as { caId?: string };
    if (ev?.caId !== id) return;
    fetchCAs();
    void selectCA(id);
    void reloadCerts();
  });

  const handleRevoke = async () => {
    if (!selectedCA) return;
    const ok = await confirm({
      title: "Revoke CA",
      description:
        "This will revoke the CA and all certificates issued by it. This action cannot be undone.",
      confirmLabel: "Revoke CA",
    });
    if (!ok) return;
    try {
      await api.revokeCA(selectedCA.id, "cessationOfOperation");
      toast.success("CA revoked");
      await selectCA(selectedCA.id);
      await fetchCAs();
    } catch (err) {
      toastApiError(err, "Failed to revoke CA");
    }
  };

  if (isLoading) return <CADetailSkeleton />;
  if (!selectedCA) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">CA not found</p>
      </div>
    );
  }

  const ca = selectedCA;
  const expiryDays = daysUntil(ca.notAfter);

  const openEndpointsDialog = () => {
    setEpCrlUrl(ca.crlDistributionUrl || "");
    setEpCaIssuersUrl(ca.caIssuersUrl || "");
    setEndpointsDialogOpen(true);
  };

  const handleSaveEndpoints = async () => {
    setIsSavingEndpoints(true);
    try {
      await api.updateCA(ca.id, {
        crlDistributionUrl: epCrlUrl || null,
        caIssuersUrl: epCaIssuersUrl || null,
      });
      toast.success("Endpoints updated");
      setEndpointsDialogOpen(false);
      fetchCAs();
    } catch (err) {
      toastApiError(err, "Failed to update endpoints");
    } finally {
      setIsSavingEndpoints(false);
    }
  };
  const childCAs = (cas || []).filter((c) => c.parentId === ca.id);
  const canCreateIntermediate = hasScope(`pki:ca:create:intermediate:${ca.id}`);
  const canIssueCertificate = hasScope("pki:cert:issue") || hasScope(`pki:cert:issue:${ca.id}`);
  const canRevokeCA = hasScope(
    ca.type === "root" ? "pki:ca:revoke:root" : "pki:ca:revoke:intermediate"
  );
  const downloadPem = () => {
    const blob = new Blob([ca.certificatePem || ""], {
      type: "application/x-pem-file",
    });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${ca.commonName}.pem`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };
  const downloadCrt = () => {
    const b64 = (ca.certificatePem || "").replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let index = 0; index < bin.length; index++) bytes[index] = bin.charCodeAt(index);
    const blob = new Blob([bytes], { type: "application/x-x509-ca-cert" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${ca.commonName}.crt`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };
  const copyPem = () => {
    void navigator.clipboard.writeText(ca.certificatePem || "");
    toast.success("PEM copied");
  };
  const copySerial = () => {
    void navigator.clipboard.writeText(ca.serialNumber);
    toast.success("Serial copied");
  };
  const issuedCertificateColumns: SimpleTableColumn<Certificate>[] = [
    {
      id: "common-name",
      header: "Common Name",
      render: (cert) => (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{cert.commonName}</span>
          {cert.isSystem && (
            <Badge variant="outline" size="inline">
              System
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "type",
      header: "Type",
      render: (cert) => <Badge variant="secondary">{cert.type}</Badge>,
    },
    {
      id: "status",
      header: "Status",
      render: (cert) => <StatusBadge status={cert.status} />,
    },
    {
      id: "expires",
      header: "Expires",
      align: "right",
      cellClassName: "whitespace-nowrap",
      render: (cert) => (
        <span className="text-sm text-muted-foreground">{formatDate(cert.notAfter)}</span>
      ),
    },
  ];
  const childCAColumns: SimpleTableColumn<(typeof childCAs)[number]>[] = [
    {
      id: "common-name",
      header: "Common Name",
      render: (child) => <span className="text-sm font-medium">{child.commonName}</span>,
    },
    {
      id: "status",
      header: "Status",
      align: "right",
      render: (child) => <StatusBadge status={child.status} />,
    },
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-6">
        <PageHeader
          leading={<PageBackButton onClick={() => navigate("/certificates/authorities")} />}
          title={ca.commonName}
          badges={
            <>
              <StatusBadge status={ca.status} size="inline" />
              {ca.isSystem && (
                <Badge variant="outline" size="inline">
                  System
                </Badge>
              )}
            </>
          }
          description={ca.type === "root" ? "Root CA" : "Intermediate CA"}
          actions={
            <ResponsiveHeaderActions
              actions={[
                ...(canCreateIntermediate && ca.status === "active" && !ca.isSystem
                  ? [
                      {
                        id: "ca:create-intermediate",
                        label: "Create intermediate CA",
                        icon: <Shield className="h-4 w-4" />,
                        onClick: () => setCreateIntermediateOpen(true),
                      },
                    ]
                  : []),
                ...(canIssueCertificate && ca.status === "active" && !ca.isSystem
                  ? [
                      {
                        id: "ca:issue-certificate",
                        label: "Issue certificate",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => setIssueDialogOpen(true),
                      },
                    ]
                  : []),
                {
                  id: "ca:download-pem",
                  label: "Download CA as PEM",
                  icon: <Download className="h-4 w-4" />,
                  onClick: downloadPem,
                },
                {
                  id: "ca:download-crt",
                  label: "Download CA as CRT",
                  icon: <Download className="h-4 w-4" />,
                  onClick: downloadCrt,
                },
                ...(ca.type === "root"
                  ? [
                      {
                        id: "ca:install-guide",
                        label: "Open CA install guide",
                        icon: <Shield className="h-4 w-4" />,
                        onClick: () => setInstallGuideOpen(true),
                      },
                    ]
                  : []),
                {
                  id: "ca:copy-pem",
                  label: "Copy CA PEM",
                  icon: <Copy className="h-4 w-4" />,
                  onClick: copyPem,
                },
                {
                  id: "ca:copy-serial",
                  label: "Copy CA serial",
                  icon: <Copy className="h-4 w-4" />,
                  onClick: copySerial,
                },
                ...(canRevokeCA && ca.status === "active" && !ca.isSystem
                  ? [
                      {
                        id: "ca:revoke",
                        label: "Revoke CA",
                        icon: <ShieldOff className="h-4 w-4" />,
                        onClick: handleRevoke,
                        destructive: true,
                        separatorBefore: true,
                      },
                    ]
                  : []),
              ]}
            >
              {canCreateIntermediate && ca.status === "active" && !ca.isSystem && (
                <Button variant="outline" onClick={() => setCreateIntermediateOpen(true)}>
                  <Shield className="h-4 w-4" />
                  Create Intermediate
                </Button>
              )}
              {canIssueCertificate && ca.status === "active" && !ca.isSystem && (
                <Button onClick={() => setIssueDialogOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Issue Certificate
                </Button>
              )}
              <Button variant="outline" onClick={downloadPem}>
                <Download className="h-4 w-4" />
                Download PEM
              </Button>
              <Button variant="outline" onClick={downloadCrt}>
                <Download className="h-4 w-4" />
                Download CRT
              </Button>
              {ca.type === "root" && (
                <Button variant="outline" onClick={() => setInstallGuideOpen(true)}>
                  <Shield className="h-4 w-4" />
                  Install Guide
                </Button>
              )}
              <Button variant="outline" onClick={copyPem}>
                <Copy className="h-4 w-4" />
                Copy PEM
              </Button>
              <Button variant="outline" onClick={copySerial}>
                <Copy className="h-4 w-4" />
                Copy Serial
              </Button>
              {canRevokeCA && ca.status === "active" && !ca.isSystem && (
                <Button variant="destructive" onClick={handleRevoke}>
                  <ShieldOff className="h-4 w-4" />
                  Revoke CA
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
          {/* Left: Details + Certs */}
          <div className="lg:col-span-2 space-y-6">
            <PanelShell
              title="Certificate Details"
              description="Identity and issuance metadata for this certificate authority."
              bodyClassName="divide-y divide-border"
            >
              <DetailRow label="Common Name" value={ca.commonName} />
              {ca.subjectDn && <DetailRow label="Subject DN" value={ca.subjectDn} />}
              {ca.issuerDn && <DetailRow label="Issuer DN" value={ca.issuerDn} />}
              <DetailRow label="Serial Number" value={formatSerialNumber(ca.serialNumber)} />
              <DetailRow label="Key Algorithm" value={ca.keyAlgorithm} />
              <DetailRow label="Valid From" value={formatDate(ca.notBefore)} />
              <DetailRow label="Valid Until" value={formatDate(ca.notAfter)} />
              <DetailRow
                label="Path Length"
                value={
                  ca.pathLengthConstraint != null ? ca.pathLengthConstraint.toString() : "Unlimited"
                }
              />
              <DetailRow label="Max Cert Validity" value={`${ca.maxValidityDays} days`} />
            </PanelShell>

            {/* Issued Certificates — same column */}
            <PanelShell
              title="Issued Certificates"
              description="Leaf certificates issued and signed by this CA."
              actions={
                <Link
                  to="/certificates/pki"
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  View all
                </Link>
              }
            >
              {certificates.length > 0 ? (
                <SimpleTable
                  columns={issuedCertificateColumns}
                  rows={certificates}
                  getRowKey={(cert) => cert.id}
                  onRowClick={(cert) => navigate(`/certificates/${cert.id}`)}
                />
              ) : (
                <EmptyState
                  message="No certificates issued yet."
                  {...(!ca.isSystem && canIssueCertificate
                    ? {
                        actionLabel: "Issue one",
                        actionHref: `/certificates/pki?ca=${ca.id}`,
                      }
                    : {})}
                />
              )}
            </PanelShell>
          </div>

          {/* Right: Summary + Child CAs */}
          <div className="space-y-4">
            <PanelShell
              title="Summary"
              description="Current CA state, limits, and certificate counts."
              bodyClassName="divide-y divide-border"
            >
              <DetailRow label="Certificates" value={ca.certCount.toString()} />
              <DetailRow
                label="Expires in"
                value={
                  <span className={expiryDays <= 30 ? "text-warning-foreground" : undefined}>
                    {expiryDays > 0
                      ? `${expiryDays} days`
                      : hoursUntil(ca.notAfter) > 0
                        ? `${hoursUntil(ca.notAfter)} hours`
                        : "Expired"}
                  </span>
                }
              />
              <DetailRow label="Type" value={<span className="capitalize">{ca.type}</span>} />
              <DetailRow label="CRL Number" value={ca.crlNumber.toString()} />
            </PanelShell>

            <PanelShell
              title="Distribution Endpoints"
              description="URLs embedded into certificates issued under this CA."
              actions={
                hasScope(`pki:ca:edit:${ca.id}`) && !ca.isSystem ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit distribution endpoints"
                    onClick={openEndpointsDialog}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                ) : null
              }
              bodyClassName="divide-y divide-border"
            >
              <DetailRow label="CRL Distribution URL" value={ca.crlDistributionUrl || "—"} />
              <DetailRow label="CA Issuers URL" value={ca.caIssuersUrl || "—"} />
            </PanelShell>

            {expiryDays <= 30 && expiryDays > 0 && (
              <Notice
                tone="warning"
                title={`This CA expires in ${expiryDays > 0 ? `${expiryDays} days` : `${hoursUntil(ca.notAfter)} hours`}`}
              >
                <p>Certificates it issued stop being trusted when it expires.</p>
              </Notice>
            )}

            {childCAs.length > 0 && (
              <PanelShell
                title="Child CAs"
                description="Intermediate certificate authorities issued under this CA."
              >
                <SimpleTable
                  columns={childCAColumns}
                  rows={childCAs}
                  getRowKey={(child) => child.id}
                  onRowClick={(child) => navigate(`/cas/${child.id}`)}
                />
              </PanelShell>
            )}
          </div>
        </div>

        {id && (
          <>
            <CertificateIssueDialog
              open={issueDialogOpen}
              onOpenChange={setIssueDialogOpen}
              caId={id}
              onSuccess={reloadCerts}
            />
            <CACreateDialog
              open={createIntermediateOpen}
              onOpenChange={setCreateIntermediateOpen}
              parentId={id}
            />
          </>
        )}

        <Dialog open={installGuideOpen} onOpenChange={setInstallGuideOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Install Root CA — {ca.commonName}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <CopyCodeBlock
                label="macOS"
                value={`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${ca.commonName}.pem`}
                codeClassName={INSTALL_COMMAND_CLASS}
              />
              <CopyCodeBlock
                label="Windows"
                value={`certutil -addstore -f "ROOT" ${ca.commonName}.crt`}
                codeClassName={INSTALL_COMMAND_CLASS}
              />
              <CopyCodeBlock
                label="Ubuntu / Debian"
                value={`sudo cp ${ca.commonName}.crt /usr/local/share/ca-certificates/\nsudo update-ca-certificates`}
                codeClassName={INSTALL_COMMAND_CLASS}
              />
              <CopyCodeBlock
                label="RHEL / Fedora"
                value={`sudo cp ${ca.commonName}.pem /etc/pki/ca-trust/source/anchors/\nsudo update-ca-trust`}
                codeClassName={INSTALL_COMMAND_CLASS}
              />
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Firefox</p>
                <p className="text-sm">
                  Settings → Privacy & Security → Certificates → View Certificates → Import
                </p>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Chrome / Edge</p>
                <p className="text-sm">
                  Settings → Privacy and Security → Security → Manage certificates → Import
                </p>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        {/* Endpoints Edit Dialog */}
        <Dialog open={endpointsDialogOpen} onOpenChange={setEndpointsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Distribution Endpoints</DialogTitle>
              <DialogDescription>
                Configure CRL and CA Issuers URLs for certificates issued under this CA.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">CRL Distribution URL</label>
                <Input
                  value={epCrlUrl}
                  onChange={(e) => setEpCrlUrl(e.target.value)}
                  placeholder="http://crl.example.com/ca.crl"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">CA Issuers URL</label>
                <Input
                  value={epCaIssuersUrl}
                  onChange={(e) => setEpCaIssuersUrl(e.target.value)}
                  placeholder="http://ca.example.com/cert.pem"
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEndpointsDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveEndpoints} pending={isSavingEndpoints}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PageTransition>
  );
}

function CADetailSkeleton() {
  return <DetailPageSkeleton label="Loading certificate authority" />;
}
