import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DomainAutocompleteInput } from "@/components/domains/DomainAutocompleteInput";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  allowedCreationFolderId,
  creationFolderChoices,
  flattenCreationFolders,
} from "@/lib/creation-folders";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { ACMEChallengeType, DNSChallenge, DomainSearchResult } from "@/types";
import { DNSChallengeVerification } from "./DNSChallengeVerification";

interface SSLCertificateCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  hasDomains?: boolean;
  pkiEnabled?: boolean;
  cloudflareConfigured: boolean;
  onCloudflareRequired: () => void;
  initialTab?: CertificateCreationMethod;
  devPreview?: SSLCertificateCreateDialogDevPreview | null;
}

export type CertificateCreationMethod = "acme" | "upload" | "internal";
type ACMEChallengeMode = "http-01" | "dns-01-manual" | "dns-01-cloudflare";
type PkiCertificateOption = { id: string; commonName: string; caId: string };

export interface SSLCertificateCreateDialogDevPreview {
  mode: ACMEChallengeType;
  domains: string[];
  dnsChallenges?: DNSChallenge[];
}

const DEV_PREVIEW_CERT_ID = "__dev_ssl_preview__";
const NO_SCOPES: string[] = [];
const FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export function SSLCertificateCreateDialog({
  open,
  onOpenChange,
  onCreated,
  hasDomains = true,
  pkiEnabled = true,
  cloudflareConfigured,
  onCloudflareRequired,
  initialTab,
  devPreview,
}: SSLCertificateCreateDialogProps) {
  const resetTimerRef = useRef<number | null>(null);
  const availableTabs = useMemo<CertificateCreationMethod[]>(() => {
    const tabs: CertificateCreationMethod[] = [];
    if (hasDomains) tabs.push("acme");
    tabs.push("upload");
    if (pkiEnabled) tabs.push("internal");
    return tabs;
  }, [hasDomains, pkiEnabled]);
  const defaultTab =
    initialTab && availableTabs.includes(initialTab) ? initialTab : (availableTabs[0] ?? "upload");
  const defaultChallengeMode: ACMEChallengeMode = cloudflareConfigured
    ? "dns-01-cloudflare"
    : "dns-01-manual";
  const [activeTab, setActiveTab] = useState<CertificateCreationMethod>(defaultTab);
  const [folderId, setFolderId] = useState("");
  // ACME tab state
  const [acmeDomains, setAcmeDomains] = useState<string[]>([""]);
  const [selectedDomains, setSelectedDomains] = useState<Array<DomainSearchResult | null>>([null]);
  const [challengeMode, setChallengeMode] = useState<ACMEChallengeMode>(defaultChallengeMode);
  const [acmeProvider, setAcmeProvider] = useState("letsencrypt");
  const [isRequestingACME, setIsRequestingACME] = useState(false);
  const [dnsChallenges, setDnsChallenges] = useState<DNSChallenge[] | null>(null);
  const [pendingCertId, setPendingCertId] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isCancellingACME, setIsCancellingACME] = useState(false);

  // Upload tab state
  const [uploadName, setUploadName] = useState("");
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [chainPem, setChainPem] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  // Internal CA tab state
  // null until the list for this opening arrives; the Internal CA tab waits for it.
  const [pkiCerts, setPkiCerts] = useState<PkiCertificateOption[] | null>(null);
  const [selectedPkiCertId, setSelectedPkiCertId] = useState("");
  const [internalName, setInternalName] = useState("");
  const [isLinking, setIsLinking] = useState(false);
  // Linking puts the PKI private key into service on nginx (never back to a user), so the backend
  // requires pki:cert:deploy on the certificate or its issuing CA; pki:cert:export implies it.
  const hasScope = useAuthStore((state) => state.hasScope);
  const hasScopedAccess = useAuthStore((state) => state.hasScopedAccess);
  const canDeployAnyPkiCert = hasScopedAccess("pki:cert:deploy");
  const canDeployPkiCert = (certId: string) => {
    const caId = pkiCerts?.find((cert) => cert.id === certId)?.caId;
    return hasScope(`pki:cert:deploy:${certId}`) || (!!caId && hasScope(`pki:cert:deploy:${caId}`));
  };
  const canLinkSelectedPkiCert = !!selectedPkiCertId && canDeployPkiCert(selectedPkiCertId);
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const folders = useResourceFolderStore((state) => state.foldersByType["ssl-certificate"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["ssl-certificate"]);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  // Every creation method needs ssl:cert:issue on the destination (broad or folder).
  const folderChoices = useMemo(
    () => creationFolderChoices(scopes, "ssl:cert:issue", flattenCreationFolders(folders ?? [])),
    [folders, scopes]
  );
  const canCreateInSelectedFolder = canCreateInFolder(scopes, "ssl:cert:issue", folderId || null);

  useEffect(() => {
    if (open && resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    if (!open) return;
    setActiveTab(defaultTab);
    setChallengeMode(defaultChallengeMode);
    setFolderId("");
    void fetchFolders("ssl-certificate");
    if (!pkiEnabled) {
      setPkiCerts([]);
      return;
    }
    const loadPkiCerts = async () => {
      try {
        const res = await api.listCertificates({
          limit: 100,
          status: "active",
          type: "tls-server",
        });
        setPkiCerts((res.data || []).map(({ id, commonName, caId }) => ({ id, commonName, caId })));
      } catch {
        // non-critical
        setPkiCerts((current) => current ?? []);
      }
    };
    void loadPkiCerts();
  }, [defaultChallengeMode, defaultTab, fetchFolders, open, pkiEnabled]);

  useEffect(() => {
    if (!open) return;
    setFolderId((current) => allowedCreationFolderId(folderChoices, current));
  }, [folderChoices, open]);

  useEffect(() => {
    if (!open || !devPreview) return;
    setAcmeDomains(devPreview.domains.length > 0 ? devPreview.domains : ["example.com"]);
    setSelectedDomains(
      (devPreview.domains.length > 0 ? devPreview.domains : ["example.com"]).map(() => null)
    );
    setChallengeMode(devPreview.mode === "http-01" ? "http-01" : "dns-01-manual");
    setAcmeProvider("letsencrypt");
    if (devPreview.mode === "dns-01") {
      setDnsChallenges(devPreview.dnsChallenges ?? []);
      setPendingCertId(DEV_PREVIEW_CERT_ID);
    } else {
      setDnsChallenges(null);
      setPendingCertId(null);
    }
  }, [devPreview, open]);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    []
  );

  const resetForm = () => {
    setActiveTab(defaultTab);
    setFolderId("");
    setAcmeDomains([""]);
    setSelectedDomains([null]);
    setChallengeMode(defaultChallengeMode);
    setAcmeProvider("letsencrypt");
    setDnsChallenges(null);
    setPendingCertId(null);
    setUploadName("");
    setCertPem("");
    setKeyPem("");
    setChainPem("");
    setSelectedPkiCertId("");
    setInternalName("");
    setPkiCerts(null);
  };

  const hasUnselectedDomain = acmeDomains.some(
    (domain, index) => domain.trim() === "" || selectedDomains[index]?.domain !== domain
  );

  const challengeType: ACMEChallengeType = challengeMode === "http-01" ? "http-01" : "dns-01";
  const usesCloudflareDns = challengeMode === "dns-01-cloudflare";
  const canUploadCertificate =
    uploadName.trim() !== "" && certPem.trim() !== "" && keyPem.trim() !== "";
  const hasPendingACMEIssue = pendingCertId !== null && pendingCertId !== DEV_PREVIEW_CERT_ID;
  const acmeFlowStarted = activeTab === "acme" && (isRequestingACME || hasPendingACMEIssue);

  const scheduleResetForm = () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      resetForm();
      resetTimerRef.current = null;
    }, 250);
  };

  const handleClose = (value: boolean) => {
    if (!value && acmeFlowStarted) return;
    if (!value) scheduleResetForm();
    onOpenChange(value);
  };

  const handleRequestACME = async () => {
    const domains = acmeDomains.filter((d) => d.trim() !== "");
    if (domains.length === 0) {
      toast.error("At least one domain is required");
      return;
    }
    if (hasUnselectedDomain) {
      toast.error("Select every domain from the registered domains list");
      return;
    }
    if (challengeType === "http-01" && domains.some((domain) => domain.trim().startsWith("*."))) {
      toast.error("HTTP-01 cannot validate wildcard domains. Use DNS-01 instead.");
      return;
    }
    if (devPreview) {
      toast.info("Local ACME modal preview only");
      return;
    }
    if (usesCloudflareDns && !cloudflareConfigured) {
      onCloudflareRequired();
      return;
    }
    setIsRequestingACME(true);
    try {
      const result = await api.requestACMECert({
        domains,
        challengeType,
        provider: acmeProvider,
        ...(usesCloudflareDns ? { dnsProvider: "cloudflare" as const } : {}),
        folderId: folderId || null,
        autoRenew: challengeType === "http-01" || usesCloudflareDns,
      });
      if (result.status === "pending_dns_verification" && result.challenges) {
        setDnsChallenges(result.challenges as DNSChallenge[]);
        setPendingCertId(result.certificate.id);
        toast.success("DNS challenge records created. Please add them to your DNS.");
      } else {
        toast.success("Certificate requested successfully");
        onOpenChange(false);
        onCreated();
        scheduleResetForm();
      }
    } catch (err) {
      if (
        usesCloudflareDns &&
        err instanceof ApiRequestError &&
        ["CLOUDFLARE_DNS_NOT_CONFIGURED", "CLOUDFLARE_ZONE_NOT_FOUND"].includes(err.code ?? "")
      ) {
        onCloudflareRequired();
        return;
      }
      toast.error(err instanceof Error ? err.message : "Failed to request certificate");
    } finally {
      setIsRequestingACME(false);
    }
  };

  const handleVerifyDNS = async () => {
    if (!pendingCertId) {
      toast.error("No pending certificate to verify");
      return;
    }
    if (pendingCertId === DEV_PREVIEW_CERT_ID) {
      toast.info("Local DNS-01 modal preview only");
      return;
    }
    setIsVerifying(true);
    try {
      await api.completeDNSVerify(pendingCertId);
      toast.success("DNS verification complete. Certificate issued.");
      onOpenChange(false);
      onCreated();
      scheduleResetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "DNS verification failed");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleCancelACME = async () => {
    if (!pendingCertId || pendingCertId === DEV_PREVIEW_CERT_ID || isCancellingACME) return;

    const confirmed = await confirm({
      title: "Cancel Certificate Request?",
      description:
        "The pending certificate request will be deleted. You can start a new request later.",
      confirmLabel: "Cancel request",
      cancelLabel: "Keep request",
      variant: "destructive",
    });
    if (!confirmed) return;

    setIsCancellingACME(true);
    try {
      await api.cancelPendingACMECert(pendingCertId);
      toast.success("Certificate request cancelled");
      onOpenChange(false);
      onCreated();
      scheduleResetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel certificate request");
    } finally {
      setIsCancellingACME(false);
    }
  };

  const handleUpload = async () => {
    if (!uploadName.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!certPem.trim()) {
      toast.error("Certificate PEM is required");
      return;
    }
    if (!keyPem.trim()) {
      toast.error("Private key PEM is required");
      return;
    }
    setIsUploading(true);
    try {
      await api.uploadCert({
        name: uploadName,
        folderId: folderId || null,
        certificatePem: certPem,
        privateKeyPem: keyPem,
        chainPem: chainPem || undefined,
      });
      toast.success("Certificate uploaded successfully");
      onOpenChange(false);
      onCreated();
      scheduleResetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload certificate");
    } finally {
      setIsUploading(false);
    }
  };

  const handleLinkInternal = async () => {
    if (!selectedPkiCertId) {
      toast.error("Select a PKI certificate");
      return;
    }
    if (!canDeployPkiCert(selectedPkiCertId)) {
      toast.error("You need permission to deploy this certificate to link it");
      return;
    }
    setIsLinking(true);
    try {
      await api.linkInternalCert({
        internalCertId: selectedPkiCertId,
        name: internalName || undefined,
        folderId: folderId || null,
      });
      toast.success("Internal certificate linked");
      onOpenChange(false);
      onCreated();
      scheduleResetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link certificate");
    } finally {
      setIsLinking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-lg"
        hideCloseButton={acmeFlowStarted}
        onEscapeKeyDown={(event) => {
          if (acmeFlowStarted) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (acmeFlowStarted) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (acmeFlowStarted) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add SSL Certificate</DialogTitle>
          <DialogDescription>Choose a method to add an SSL certificate.</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <ContentLoading loading={foldersLoading} />
          <label className="text-sm font-medium">Folder</label>
          <Select
            value={folderId || (folderChoices.allowRoot ? "__none__" : "")}
            onValueChange={(value) => setFolderId(value === "__none__" ? "" : value)}
            disabled={foldersLoading || acmeFlowStarted}
          >
            <SelectTrigger aria-label="Folder" aria-busy={foldersLoading}>
              <SelectValue
                placeholder={folderChoices.allowRoot ? "No folder" : "Select a folder"}
              />
            </SelectTrigger>
            <SelectContent>
              {folderChoices.allowRoot && <SelectItem value="__none__">No folder</SelectItem>}
              {folderChoices.folders.map((folder) => (
                <SelectItem key={folder.id} value={folder.id}>
                  {"  ".repeat(folder.depth) + folder.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as CertificateCreationMethod)}
        >
          {availableTabs.length > 1 && (
            <TabsList>
              {hasDomains && (
                <TabsTrigger value="acme" disabled={acmeFlowStarted}>
                  Let's Encrypt
                </TabsTrigger>
              )}
              <TabsTrigger value="upload" disabled={acmeFlowStarted}>
                Upload
              </TabsTrigger>
              {pkiEnabled && (
                <TabsTrigger value="internal" disabled={acmeFlowStarted}>
                  Internal CA
                </TabsTrigger>
              )}
            </TabsList>
          )}

          <AnimatedHeight>
            <div className={availableTabs.length > 1 ? "pt-4" : undefined}>
              {/* ACME / Let's Encrypt Tab */}
              {hasDomains && (
                <TabsContent value="acme" className="mt-0">
                  <AnimatePresence initial={false} mode="wait">
                    {dnsChallenges ? (
                      <motion.div key="dns-verification" {...FORM_ANIMATION}>
                        <DNSChallengeVerification
                          challenges={dnsChallenges}
                          onVerify={handleVerifyDNS}
                          isVerifying={isVerifying}
                          showAction={false}
                        />
                      </motion.div>
                    ) : (
                      <motion.div key="acme-form" {...FORM_ANIMATION} className="space-y-4">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Domains</label>
                          <div className="space-y-2">
                            <AnimatePresence initial={false}>
                              {acmeDomains.map((domain, i) => (
                                <motion.div
                                  key={`acme-domain-${i}`}
                                  initial={{ opacity: 0, y: 4 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={{ opacity: 0, y: 4 }}
                                  transition={{
                                    opacity: { duration: 0.12 },
                                    y: { duration: 0.12, ease: [0.25, 0.1, 0.25, 1] },
                                  }}
                                  className="flex border border-input bg-background"
                                >
                                  <DomainAutocompleteInput
                                    registeredOnly
                                    value={domain}
                                    onChange={(v) => {
                                      const next = [...acmeDomains];
                                      next[i] = v;
                                      setAcmeDomains(next);
                                      if (selectedDomains[i]?.domain !== v) {
                                        const nextSelected = [...selectedDomains];
                                        nextSelected[i] = null;
                                        setSelectedDomains(nextSelected);
                                      }
                                    }}
                                    onDomainSelect={(selected) => {
                                      const nextSelected = [...selectedDomains];
                                      nextSelected[i] = selected;
                                      setSelectedDomains(nextSelected);
                                    }}
                                    placeholder="example.com"
                                    inputClassName="border-0 shadow-none"
                                  />
                                  {acmeDomains.length > 1 && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                                      aria-label={`Remove domain ${i + 1}`}
                                      onClick={() => {
                                        setAcmeDomains(acmeDomains.filter((_, j) => j !== i));
                                        setSelectedDomains(
                                          selectedDomains.filter((_, j) => j !== i)
                                        );
                                      }}
                                    >
                                      <Minus className="h-4 w-4" />
                                    </Button>
                                  )}
                                  {i === acmeDomains.length - 1 && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                                      aria-label="Add domain"
                                      onClick={() => {
                                        setAcmeDomains([...acmeDomains, ""]);
                                        setSelectedDomains([...selectedDomains, null]);
                                      }}
                                    >
                                      <Plus className="h-4 w-4" />
                                    </Button>
                                  )}
                                </motion.div>
                              ))}
                            </AnimatePresence>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Challenge Type</label>
                            <Select
                              value={challengeMode}
                              onValueChange={(v) => setChallengeMode(v as ACMEChallengeMode)}
                            >
                              <SelectTrigger aria-label="Challenge Type">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="http-01">HTTP validation</SelectItem>
                                <SelectItem value="dns-01-manual">Manual DNS validation</SelectItem>
                                <SelectItem value="dns-01-cloudflare">
                                  Automatic DNS via Cloudflare
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Provider</label>
                            <Select value={acmeProvider} onValueChange={setAcmeProvider}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="letsencrypt">Let's Encrypt</SelectItem>
                                <SelectItem value="letsencrypt-staging">
                                  Let's Encrypt (Staging)
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <AnimatePresence initial={false}>
                          {challengeType === "dns-01" && (
                            <motion.p
                              initial={{ height: 0, opacity: 0, y: 4 }}
                              animate={{ height: "auto", opacity: 1, y: 0 }}
                              exit={{ height: 0, opacity: 0, y: 4 }}
                              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                              className="overflow-hidden text-xs text-muted-foreground"
                            >
                              {usesCloudflareDns
                                ? "Gateway will create and clean up the Cloudflare validation records automatically."
                                : "DNS-01 requires TXT validation records. After requesting, you'll be shown the records to add."}
                            </motion.p>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </TabsContent>
              )}

              {/* Upload Tab */}
              <TabsContent value="upload" className="mt-0">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Name</label>
                    <Input
                      value={uploadName}
                      onChange={(e) => setUploadName(e.target.value)}
                      placeholder="My Certificate"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Certificate PEM</label>
                    <Textarea
                      className="h-32"
                      value={certPem}
                      onChange={(e) => setCertPem(e.target.value)}
                      placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Private Key PEM</label>
                    <Textarea
                      className="h-32"
                      value={keyPem}
                      onChange={(e) => setKeyPem(e.target.value)}
                      placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Chain PEM (optional)</label>
                    <Textarea
                      className="h-24"
                      value={chainPem}
                      onChange={(e) => setChainPem(e.target.value)}
                      placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                    />
                  </div>
                </div>
              </TabsContent>

              {/* Internal CA Tab */}
              {pkiEnabled && (
                <TabsContent value="internal" className="mt-0">
                  <div className="space-y-4">
                    <ContentLoading loading={pkiCerts === null} />
                    <p className="text-sm text-muted-foreground">
                      Link an existing PKI certificate from your internal Certificate Authorities
                      for use as an SSL certificate.
                    </p>
                    {!canDeployAnyPkiCert && (
                      <p className="text-xs text-muted-foreground">
                        Linking requires the PKI certificate deploy permission (pki:cert:deploy)
                        because the certificate's private key is deployed to nginx.
                      </p>
                    )}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">PKI Certificate</label>
                      <Select
                        value={selectedPkiCertId}
                        onValueChange={setSelectedPkiCertId}
                        disabled={!canDeployAnyPkiCert}
                      >
                        <SelectTrigger aria-label="PKI certificate">
                          <SelectValue placeholder="Select a certificate..." />
                        </SelectTrigger>
                        <SelectContent>
                          {!pkiCerts?.length ? (
                            <SelectItem value="__none__" disabled>
                              No active TLS server certificates
                            </SelectItem>
                          ) : (
                            pkiCerts.map((cert) => {
                              const canDeploy = canDeployPkiCert(cert.id);
                              return (
                                <SelectItem key={cert.id} value={cert.id} disabled={!canDeploy}>
                                  {cert.commonName}
                                  {!canDeploy && " (no deploy permission)"}
                                </SelectItem>
                              );
                            })
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Name Override (optional)</label>
                      <Input
                        value={internalName}
                        onChange={(e) => setInternalName(e.target.value)}
                        placeholder="Auto-generated from certificate"
                      />
                    </div>
                  </div>
                </TabsContent>
              )}
            </div>
          </AnimatedHeight>
        </Tabs>
        <DialogFooter>
          {activeTab === "acme" &&
            (dnsChallenges ? (
              <>
                {hasPendingACMEIssue && (
                  <Button
                    variant="outline"
                    onClick={() => void handleCancelACME()}
                    disabled={isVerifying}
                    pending={isCancellingACME}
                  >
                    Cancel
                  </Button>
                )}
                <Button onClick={handleVerifyDNS} disabled={isCancellingACME} pending={isVerifying}>
                  Verify DNS
                </Button>
              </>
            ) : (
              <Button
                onClick={handleRequestACME}
                disabled={hasUnselectedDomain || !canCreateInSelectedFolder}
                pending={isRequestingACME}
              >
                Request Certificate
              </Button>
            ))}
          {activeTab === "upload" && (
            <Button
              onClick={handleUpload}
              disabled={!canUploadCertificate || !canCreateInSelectedFolder}
              pending={isUploading}
            >
              <Upload className="h-4 w-4" />
              Upload Certificate
            </Button>
          )}
          {activeTab === "internal" && (
            <Button
              onClick={handleLinkInternal}
              disabled={!canLinkSelectedPkiCert || !canCreateInSelectedFolder}
              pending={isLinking}
            >
              Link Certificate
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
