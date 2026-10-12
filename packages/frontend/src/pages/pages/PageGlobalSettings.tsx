import { ExternalLink, Globe, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
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
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { useScrollToNavigationTarget } from "@/hooks/use-scroll-to-navigation-target";
import { toastApiError } from "@/lib/api-error-toast";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { PageProfile, PageProfileOptions } from "@/types";

function certificateCovers(
  certificate: Pick<PageProfileOptions["certificates"][number], "domainNames">,
  domain: string
): boolean {
  const expected = `*.${domain.replace(/^\*\./, "").replace(/\.$/, "").toLowerCase()}`;
  return certificate.domainNames.some((name) => name.toLowerCase().replace(/\.$/, "") === expected);
}

function templateLabel(template: string, hash = "da32ccagd23fe", project = "docs") {
  return template.replaceAll("{hash}", hash).replaceAll("{project}", project);
}

export function PagesSettingsSection() {
  const canEdit = useAuthStore((state) => state.hasScope("pages:settings:edit"));
  const license = useUIBootstrapStore((state) => state.snapshot?.license);
  const commercialModule = useUIBootstrapStore((state) => state.snapshot?.commercialModule);
  const entitled = license?.entitlements.features.includes("pages") === true;
  // A plan without Pages shows the locked panel and never calls the Pages endpoints,
  // which would only answer with a plan denial.
  const locked = (!!license && !entitled) || (!!commercialModule && commercialModule !== "ready");
  const invalidateUIBootstrap = useUIBootstrapStore((state) => state.invalidate);
  const [profile, setProfile] = useState<PageProfile | null>(null);
  const [options, setOptions] = useState<PageProfileOptions>({
    domains: [],
    nodes: [],
    certificates: [],
  });
  const [loading, setLoading] = useState(!locked);
  const [domainId, setDomainId] = useState("");
  const [certificateId, setCertificateId] = useState("");
  const [labelTemplate, setLabelTemplate] = useState("{hash}");
  const [enabled, setEnabled] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (locked) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextProfile, nextOptions] = await Promise.all([
        api.getPageProfile(),
        api.getPageProfileOptions(),
      ]);
      setProfile(nextProfile);
      setOptions(nextOptions);
      setDomainId(nextProfile.domainId ?? "");
      setCertificateId(nextProfile.certificateId ?? "");
      setLabelTemplate(nextProfile.labelTemplate || "{hash}");
      setEnabled(nextProfile.enabled);
    } catch (error) {
      toastApiError(error, "Failed to load Pages settings", "Pages");
    } finally {
      setLoading(false);
    }
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("pages.profile.changed", () => {
    invalidateUIBootstrap();
    void load();
  });
  const navigationHighlighted = useScrollToNavigationTarget("pages", !loading, {
    block: "center",
    highlightDurationMs: 2200,
  });

  const selectedDomain = options.domains.find((domain) => domain.id === domainId) ?? null;
  const selectedCertificate =
    options.certificates.find((certificate) => certificate.id === certificateId) ?? null;
  const availableCertificates = selectedDomain
    ? options.certificates.filter((certificate) =>
        certificateCovers(certificate, selectedDomain.domain)
      )
    : options.certificates;
  const selectedDomainSharesGateway = Boolean(selectedDomain?.isolation.same);
  const existingOverrideApplies =
    profile?.domainId === selectedDomain?.id && profile?.isolation?.overrideCurrent === true;
  const sameRegistrableDomain = selectedDomainSharesGateway && !existingOverrideApplies;
  const templateError = useMemo(() => {
    const dots = labelTemplate.includes(".");
    const hashes = (labelTemplate.match(/\{hash\}/g) ?? []).length;
    const unknown = /\{(?!hash\}|project\})/.test(labelTemplate);
    const rendered = templateLabel(labelTemplate);
    if (!labelTemplate.trim()) return "Template is required";
    if (dots) return "Template must be one DNS label; dots are not allowed";
    if (hashes !== 1) return "Template must contain {hash} exactly once";
    if (unknown || (labelTemplate.match(/\{project\}/g) ?? []).length > 1)
      return "Only {hash} and {project} are supported";
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rendered) || rendered.length > 63)
      return "Rendered template must be a lowercase DNS label up to 63 characters";
    return null;
  }, [labelTemplate]);

  const validSelection = Boolean(
    selectedDomain &&
      selectedDomain.dnsStatus === "valid" &&
      selectedCertificate &&
      certificateCovers(selectedCertificate, selectedDomain.domain) &&
      !templateError
  );
  const dirty = Boolean(
    profile &&
      (enabled !== profile.enabled ||
        domainId !== (profile.domainId ?? "") ||
        certificateId !== (profile.certificateId ?? "") ||
        labelTemplate !== (profile.labelTemplate || "{hash}"))
  );
  const canSave = dirty && canEdit && !saving && (!enabled || validSelection);

  const save = async (override = false) => {
    if (!canSave) return;
    if (!entitled) {
      requireLicenseFeature("pages", "Pages");
      return;
    }
    if (!enabled) {
      setSaving(true);
      try {
        const updated = await api.updatePageProfile({ enabled: false });
        setProfile(updated);
        setEnabled(updated.enabled);
        invalidateUIBootstrap();
        toast.success("Pages disabled");
      } catch (error) {
        toastApiError(error, "Failed to disable Pages previews", "Pages");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (selectedDomainSharesGateway && !existingOverrideApplies && !override) {
      setWarningOpen(true);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updatePageProfile({
        enabled: true,
        domainId: selectedDomain!.id,
        certificateId: selectedCertificate!.id,
        labelTemplate: labelTemplate.trim(),
        acknowledgeSameRegistrableDomain: override || existingOverrideApplies,
      });
      setProfile(updated);
      setEnabled(updated.enabled);
      setDomainId(updated.domainId ?? "");
      setCertificateId(updated.certificateId ?? "");
      setLabelTemplate(updated.labelTemplate || "{hash}");
      invalidateUIBootstrap();
      toast.success("Pages wildcard profile saved");
      setWarningOpen(false);
    } catch (error) {
      toastApiError(error, "Failed to save Pages profile", "Pages");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      id="pages"
      className={cn("space-y-4 scroll-mt-6", navigationHighlighted && "navigation-target-ripple")}
    >
      {locked ? (
        <PanelShell
          icon={<Globe className="h-4 w-4" />}
          title={
            <span className="inline-flex items-center gap-2">
              <span>Pages</span>
              <LicensePlanBadge feature="pages" label="Personal+" />
            </span>
          }
          description="Wildcard deployment previews need the Personal plan or higher."
          actions={
            <Button variant="outline" onClick={() => requireLicenseFeature("pages", "Pages")}>
              License options
            </Button>
          }
        />
      ) : loading && !profile ? (
        <PanelShell
          icon={<Globe className="h-4 w-4" />}
          title={
            <span className="inline-flex items-center gap-2">
              <span>Pages</span>
              <LicensePlanBadge feature="pages" label="Personal+" />
            </span>
          }
          description="Loading wildcard deployment preview settings…"
        />
      ) : (
        <>
          <PanelShell
            icon={<Globe className="h-4 w-4" />}
            title={
              <span className="inline-flex items-center gap-2">
                <span>Pages</span>
                <LicensePlanBadge feature="pages" label="Personal+" />
              </span>
            }
            description="Each immutable Deployment gets one hostname label under this wildcard Domain."
            actions={
              <Button onClick={() => void save()} disabled={!canSave}>
                <Save className="h-4 w-4" />
                {saving ? "Saving…" : "Save"}
              </Button>
            }
            dirty={dirty}
          >
            <SettingsControlRow
              title="Enabled"
              description={
                enabled
                  ? "Pages projects and immutable preview delivery are enabled."
                  : "Pages is disabled and hidden from navigation."
              }
            >
              <Switch
                checked={enabled}
                onChange={setEnabled}
                disabled={!canEdit || saving}
                ariaLabel="Enable Pages"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Base wildcard Domain"
              help="Pages uses this wildcard domain to create a unique hostname for every immutable deployment. The selected Domain must already be registered and managed by Opfield."
              description={
                <span>
                  Choose a registered wildcard Domain.{" "}
                  <Link className="text-primary underline" to="/routes/domains">
                    Create or manage Domains <ExternalLink className="inline h-3 w-3" />
                  </Link>
                </span>
              }
            >
              <Select
                value={domainId || undefined}
                onValueChange={setDomainId}
                disabled={!canEdit || !enabled || saving}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select wildcard Domain" />
                </SelectTrigger>
                <SelectContent>
                  {options.domains.length === 0 ? (
                    <SelectItem value="__no-pages-domains" disabled>
                      No wildcard Domains available
                    </SelectItem>
                  ) : (
                    options.domains.map((domain) => (
                      <SelectItem key={domain.id} value={domain.id}>
                        {domain.domain} · DNS {domain.dnsStatus}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Wildcard certificate"
              description="The certificate must cover the exact *.base.domain name."
              help="This certificate secures every generated Pages hostname below the wildcard domain. A certificate for only the bare domain does not cover its deployment subdomains."
            >
              <Select
                value={certificateId || undefined}
                onValueChange={setCertificateId}
                disabled={!canEdit || !enabled || saving}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select certificate" />
                </SelectTrigger>
                <SelectContent>
                  {availableCertificates.length === 0 ? (
                    <SelectItem value="__no-pages-certificates" disabled>
                      No matching certificates available
                    </SelectItem>
                  ) : (
                    availableCertificates.map((certificate) => (
                      <SelectItem key={certificate.id} value={certificate.id}>
                        {certificate.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Hostname label template"
              description="Exactly one DNS label is editable; dots are forbidden and {hash} is required."
              help="{hash} is the immutable deployment hash; {project} is optional. The rendered result must be one lowercase DNS label of at most 63 characters."
            >
              <div className="flex w-full flex-col gap-2">
                <Input
                  value={labelTemplate}
                  onChange={(event) => setLabelTemplate(event.target.value.toLowerCase())}
                  disabled={!canEdit || !enabled || saving}
                  aria-invalid={!!templateError}
                  className={
                    templateError
                      ? "border-destructive focus-visible:border-destructive focus-visible:ring-0"
                      : undefined
                  }
                />
              </div>
            </SettingsControlRow>
            {profile?.isolation?.overrideCurrent && (
              <SettingsControlRow
                title="Isolation override acknowledged"
                description={
                  <>
                    Acknowledged{" "}
                    {profile.overrideAcknowledgedAt ? (
                      <RelativeTime value={profile.overrideAcknowledgedAt} />
                    ) : (
                      "previously"
                    )}
                    . Re-evaluate it after changing the Domain.
                  </>
                }
                help="This acknowledgement allows Pages and Opfield to share a registrable parent domain even though deployed JavaScript may then affect parent-domain cookies."
              >
                <Badge variant="warning">Cookie isolation warning accepted</Badge>
              </SettingsControlRow>
            )}
          </PanelShell>

          {sameRegistrableDomain && (
            <Notice tone="warning" title="Separate registrable domain recommended">
              Deployed JavaScript can affect parent-domain cookies when Opfield and Pages share a
              registrable domain. Saving requires explicit acknowledgement.
            </Notice>
          )}

          <Dialog open={warningOpen} onOpenChange={setWarningOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Confirm Same-Domain Pages Previews</DialogTitle>
                <DialogDescription>
                  This override requires explicit acknowledgement.
                </DialogDescription>
              </DialogHeader>
              <Notice tone="warning" title="Why confirmation is required">
                Pages should use a separate registrable domain. Deployed JavaScript may affect
                Opfield cookies on the shared parent domain.
              </Notice>
              <DialogFooter>
                <Button variant="outline" onClick={() => setWarningOpen(false)}>
                  Choose another Domain
                </Button>
                <Button onClick={() => void save(true)}>Acknowledge and save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
