import { motion } from "framer-motion";
import { ArrowLeft, Check, KeyRound, Network, RefreshCw, Server, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedSwitch, CONTENT_SWITCH_ANIMATION } from "@/components/common/AnimatedSwitch";
import { Combobox } from "@/components/common/Combobox";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import {
  DEFAULT_HOSTING_SETTINGS,
  HOSTING_API_ORIGINS,
  HOSTING_PROVIDER_LABELS,
  type HostingConnector,
  type HostingConnectorInput,
  type HostingDiscovery,
  type HostingProvider,
  type HostingSettings,
} from "@/types/hosting";
import { previewHostingPool } from "./hosting-pool-preview";

type Placement = NonNullable<HostingSettings["proxmox"]>;
const DEFAULT_PLACEMENT: Placement = {
  nodes: [],
  storage: "",
  imageStorage: "",
  seedStorage: "",
  bridge: "vmbr0",
  network: "dhcp",
  vmidRange: "",
  ipRange: "",
  vlan: null,
  dnsServers: [],
};
const optional = (value: string | undefined) => value?.trim() || undefined;
const entries = (value: string) =>
  value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
const options = (items: Array<{ id: string; name: string }>) =>
  items.map(({ id, name }) => ({ value: id, label: name }));

/** Only writable settings; credentials/read-model fields never leak into a saved profile. */
export function hostingSettingsInput(
  settings: HostingSettings,
  provisioning: boolean
): HostingSettings {
  const p = settings.proxmox ?? DEFAULT_PLACEMENT;
  return {
    kind: "hosting",
    autoSyncEnabled: settings.autoSyncEnabled,
    autoSyncIntervalSeconds: settings.autoSyncIntervalSeconds,
    resourceIds: [...settings.resourceIds],
    adoptionEnabled: settings.adoptionEnabled,
    adoptionNodeIds: [...settings.adoptionNodeIds],
    tokenId: optional(settings.tokenId),
    clusterId: optional(settings.clusterId),
    proxmoxHost: optional(settings.proxmoxHost),
    caCertificate: optional(settings.caCertificate),
    certificateFingerprint: optional(settings.certificateFingerprint),
    defaultLocation: optional(settings.defaultLocation),
    defaultSize: optional(settings.defaultSize),
    defaultImage: optional(settings.defaultImage),
    ...(provisioning
      ? {
          proxmox: {
            nodes: settings.proxmoxHost ? [settings.proxmoxHost] : [...p.nodes],
            storage: p.storage?.trim() ?? "",
            imageStorage: p.imageStorage?.trim() ?? "",
            seedStorage: p.seedStorage?.trim() ?? "",
            bridge: p.bridge?.trim() ?? "",
            pool: optional(p.pool),
            network: p.network,
            vmidRange: optional(p.vmidRange),
            vlan: p.vlan,
            dnsServers: p.dnsServers?.map((ip) => ip.trim()).filter(Boolean),
            searchDomain: optional(p.searchDomain),
            mtu: p.mtu,
            firewall: p.firewall,
            ...(p.maxCpu == null ? {} : { maxCpu: p.maxCpu }),
            ...(p.maxMemoryMb == null ? {} : { maxMemoryMb: p.maxMemoryMb }),
            ...(p.maxDiskGb == null ? {} : { maxDiskGb: p.maxDiskGb }),
            ...(p.network === "static"
              ? {
                  gateway: optional(p.gateway),
                  subnet: optional(p.subnet),
                  ipRange: optional(p.ipRange),
                }
              : {}),
          },
        }
      : {}),
  };
}

export function HostingConnectorDialog({
  open,
  connector,
  onClose,
  onSaved,
}: {
  open: boolean;
  connector?: HostingConnector | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { hasScope } = useAuthStore();
  const canManage = hasScope(
    connector ? `integrations:hosting:manage:${connector.id}` : "integrations:hosting:manage"
  );
  const [provider, setProvider] = useState<HostingProvider>("hostkey");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [settings, setSettings] = useState<HostingSettings>(DEFAULT_HOSTING_SETTINGS);
  const [nodeScope, setNodeScope] = useState("");
  const [dns, setDns] = useState("");
  const [provisioning, setProvisioning] = useState(true);
  const [tls, setTls] = useState<"system" | "ca" | "pin">("system");
  const [discovery, setDiscovery] = useState<HostingDiscovery | null>(null);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [configurationLoaded, setConfigurationLoaded] = useState(false);
  // An existing connector's configuration loads when the dialog opens. Set the flags in the
  // render that opens it, so the dialog waits for the request from its first frame.
  const [openedFor, setOpenedFor] = useState<boolean>(false);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) {
      setLoading(!!connector?.id);
      setConfigurationLoaded(!connector?.id);
    }
  }
  const [pendingAction, setPendingAction] = useState<"test" | "continue" | "save" | null>(null);
  const [connectionTested, setConnectionTested] = useState(false);
  const busy = pendingAction !== null;
  const generation = useRef(0);
  const pve = provider === "proxmox";
  const placement = settings.proxmox ?? DEFAULT_PLACEMENT;
  const steps = pve
    ? provisioning
      ? ["Connection", "Proxmox host", "Infrastructure", "Network", "Review"]
      : ["Connection", "Proxmox host", "Settings"]
    : ["Connection", "Settings"];
  const connectionStep = pve ? 2 : 1;
  const locked = !canManage || busy || loading || !configurationLoaded;
  const last = step === steps.length;
  const host = settings.proxmoxHost ?? "";
  const hostStorages = useMemo(
    () => (discovery?.storages ?? []).filter((item) => item.host === host),
    [discovery, host]
  );
  const diskStorages = useMemo(
    () => hostStorages.filter((item) => item.content?.includes("images")),
    [hostStorages]
  );
  const imageStorages = useMemo(
    () => hostStorages.filter((item) => item.content?.includes("import")),
    [hostStorages]
  );
  const seedStorages = useMemo(
    () => hostStorages.filter((item) => item.content?.includes("iso")),
    [hostStorages]
  );
  let vmids: number[] = [],
    ips: number[] = [],
    vmidError: string | null = null,
    ipError: string | null = null;
  try {
    vmids = previewHostingPool(placement.vmidRange ?? "", "vmid");
  } catch (cause) {
    vmidError = (cause as Error).message;
  }
  try {
    ips = previewHostingPool(placement.ipRange ?? "", "ipv4");
  } catch (cause) {
    ipError = (cause as Error).message;
  }
  const set = (patch: Partial<HostingSettings>) =>
    setSettings((current) => ({ ...current, ...patch }));
  const updatePlacement = (patch: Partial<Placement>) =>
    setSettings((current) => ({
      ...current,
      proxmox: { ...DEFAULT_PLACEMENT, ...current.proxmox, ...patch },
    }));

  useEffect(() => {
    if (!pve || !provisioning || !host || !discovery) return;
    const chooseUnique = (
      key: "storage" | "imageStorage" | "seedStorage",
      candidates: typeof hostStorages
    ) => {
      if (candidates.length !== 1) return;
      setSettings((current) => {
        const currentPlacement = { ...DEFAULT_PLACEMENT, ...current.proxmox };
        if (candidates.some((item) => item.id === currentPlacement[key])) return current;
        return {
          ...current,
          proxmox: { ...currentPlacement, [key]: candidates[0].id },
        };
      });
    };
    chooseUnique("storage", diskStorages);
    chooseUnique("imageStorage", imageStorages);
    chooseUnique("seedStorage", seedStorages);
  }, [discovery, diskStorages, host, imageStorages, pve, provisioning, seedStorages]);
  const invalidateConnection = () => {
    setDiscovery(null);
    setConnectionTested(false);
  };

  useEffect(() => {
    if (!open) return;
    const run = ++generation.current;
    setStep(1);
    setDiscovery(null);
    setConnectionTested(false);
    setToken("");
    setPendingAction(null);
    setProvider(connector?.provider ?? "hostkey");
    setName(connector?.name ?? "");
    setBaseUrl(connector?.baseUrl ?? HOSTING_API_ORIGINS.hostkey);
    setEnabled(connector?.enabled ?? true);
    setSettings(DEFAULT_HOSTING_SETTINGS);
    setNodeScope("");
    setDns("");
    setTls("system");
    setProvisioning(!connector?.id);
    setConfigurationLoaded(!connector?.id);
    setLoading(!!connector?.id);
    if (connector?.id)
      void api
        .getHostingConfiguration(connector.id)
        .then((result) => {
          if (run !== generation.current) return;
          const data = hostingSettingsInput(result.settings, !!result.settings.proxmox);
          setSettings({
            ...data,
            proxmoxHost:
              data.proxmoxHost ??
              (data.proxmox?.nodes.length === 1 ? data.proxmox.nodes[0] : undefined),
          });
          setNodeScope(data.adoptionNodeIds.join(", "));
          setDns(data.proxmox?.dnsServers?.join(", ") ?? "");
          setProvisioning(!!data.proxmox);
          setTls(data.caCertificate ? "ca" : data.certificateFingerprint ? "pin" : "system");
          setConfigurationLoaded(true);
        })
        .catch((cause) => {
          if (run === generation.current) toast.error(cause.message);
        })
        .finally(() => {
          if (run === generation.current) setLoading(false);
        });
    return () => {
      generation.current++;
    };
  }, [
    open,
    connector?.id,
    connector?.provider,
    connector?.name,
    connector?.baseUrl,
    connector?.enabled,
  ]);

  const input = (includeProfile = true): HostingConnectorInput => ({
    provider,
    name: name.trim(),
    baseUrl: pve ? baseUrl.trim() : HOSTING_API_ORIGINS[provider],
    enabled: connector ? enabled : true,
    ...(token.trim() ? { token: token.trim() } : {}),
    settings: hostingSettingsInput(
      {
        ...settings,
        caCertificate: pve && tls === "ca" ? settings.caCertificate : undefined,
        certificateFingerprint: pve && tls === "pin" ? settings.certificateFingerprint : undefined,
      },
      includeProfile && pve && provisioning
    ),
  });
  const validate = (target: number) => {
    if (target === 1) {
      if (!name.trim() || (!connector && !token.trim()))
        return "Name and token are required for a new connector.";
      if (pve && (!baseUrl.trim() || !settings.tokenId?.trim()))
        return "Enter the Proxmox API address and token ID.";
    }
    if (pve && target === connectionStep) {
      if (tls === "ca" && !settings.caCertificate?.trim())
        return "Paste the trusted CA certificate.";
      if (tls === "pin" && !settings.certificateFingerprint?.trim())
        return "Enter the independently verified certificate fingerprint.";
    }
    if (pve && provisioning && target === 3) {
      if (!host || !placement.storage || !placement.imageStorage || !placement.seedStorage)
        return "Choose a host, disk storage, image storage and seed ISO storage.";
      if (
        !diskStorages.some((item) => item.id === placement.storage) ||
        !imageStorages.some((item) => item.id === placement.imageStorage) ||
        !seedStorages.some((item) => item.id === placement.seedStorage)
      )
        return "Choose images storage for VM disks, import storage for OS images, and iso storage for bootstrap media.";
      if (vmidError || !vmids.length) return vmidError ?? "Configure the allowed VMID pool.";
      if (
        [placement.maxCpu, placement.maxMemoryMb, placement.maxDiskGb].some(
          (value) => value != null && (!Number.isInteger(value) || value <= 0)
        )
      )
        return "Aggregate CPU, memory and disk budgets must be positive whole numbers or blank.";
    }
    if (pve && provisioning && target === 4) {
      if (!placement.bridge) return "Choose an existing network bridge.";
      if (
        placement.vlan != null &&
        (!Number.isInteger(placement.vlan) || placement.vlan < 1 || placement.vlan > 4094)
      )
        return "VLAN must be 1–4094, or leave it blank for untagged networking.";
      if (placement.network === "static") {
        if (ipError) return ipError;
        if (!placement.subnet?.trim() || !placement.gateway?.trim())
          return "Static networking requires subnet and gateway.";
        if (ips.length < vmids.length)
          return `Provide at least ${vmids.length} IP addresses for ${vmids.length} VMIDs.`;
      }
    }
    if (target === steps.length) {
      if (
        !Number.isInteger(settings.autoSyncIntervalSeconds) ||
        settings.autoSyncIntervalSeconds < 60 ||
        settings.autoSyncIntervalSeconds > 86400
      )
        return "Set a sync interval between 60 and 86400 seconds.";
    }
    return null;
  };
  const stepInvalid = validate(step) !== null;
  const hostRequired =
    pve && step === connectionStep && !discovery?.hosts.some((item) => item.id === host);
  const testConnection = async (testOnly: boolean): Promise<string | null> => {
    const run = generation.current;
    invalidateConnection();
    if (pve) {
      const result = await api.discoverHostingConnector({
        ...input(false),
        enabled: true,
        tlsMode: tls,
        ...(connector ? { connectorId: connector.id } : {}),
      });
      if (run !== generation.current) return null;
      setDiscovery(result);
      setConnectionTested(true);
      const selectedHost = result.hosts.some((item) => item.id === host)
        ? host
        : result.hosts.length === 1
          ? result.hosts[0].id
          : "";
      set({ proxmoxHost: selectedHost || undefined });
      return selectedHost;
    }
    const result =
      connector && !token.trim()
        ? await api.testHostingConnector(connector.id)
        : await api.previewHostingConnector(input(false));
    if (run === generation.current) {
      setConnectionTested(true);
      const limitations = [
        ...new Set(
          Object.values(result.capabilities ?? {})
            .filter(
              (capability) => !capability.available && capability.reasonCode === "permission_denied"
            )
            .map((capability) => capability.reason)
            .filter(Boolean)
        ),
      ];
      if (limitations.length)
        toast.warning("Connected with limited permissions", { description: limitations.join(" ") });
      else if (testOnly) toast.success("Connection successful");
    }
    return null;
  };
  const advance = async (testOnly = false) => {
    if (locked) return;
    const problem = validate(step);
    if (problem) {
      toast.error(problem);
      return;
    }
    setPendingAction(testOnly ? "test" : last ? "save" : "continue");
    const run = generation.current;
    try {
      if (step === connectionStep && (testOnly || !connectionTested)) {
        const selectedHost = await testConnection(testOnly);
        if (run !== generation.current) return;
        if (testOnly) {
          if (pve) toast.success("Connection successful");
          return;
        }
        if (pve && !selectedHost) {
          toast.error("Choose the physical Proxmox host for this connector.");
          return;
        }
      }
      if (last) {
        if (connector) await api.updateHostingConnector(connector.id, input());
        else await api.createHostingConnector(input());
        if (run === generation.current) {
          onSaved();
          onClose();
        }
      } else setStep((current) => current + 1);
    } catch (cause) {
      if (run === generation.current) toastApiError(cause, "Hosting connector request failed");
    } finally {
      if (run === generation.current) setPendingAction(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {connector ? `Configure ${connector.name}` : "Add Hosting Connector"}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Step {step} of {steps.length} — {steps[step - 1]}
        </DialogDescription>
        {/* One body child either way, so the dialog body keeps its layout. */}
        {loading ? (
          <ContentLoading loading />
        ) : (
          <AnimatedSwitch>
            <motion.div key={step} {...CONTENT_SWITCH_ANIMATION} className="space-y-5">
              {step === 1 && (
                <PanelShell
                  title="Connection"
                  icon={<Server className="h-4 w-4" />}
                  description="Hosting provider, account and API credentials."
                >
                  <SettingsControlRow
                    title="Provider"
                    description="Service that hosts your virtual machines."
                    help="A saved connector stays bound to its provider."
                  >
                    <Combobox
                      ariaLabel="Provider"
                      value={provider}
                      disabled={!!connector || locked}
                      options={Object.entries(HOSTING_PROVIDER_LABELS).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                      onValueChange={(value) => {
                        const next = value as HostingProvider;
                        setProvider(next);
                        setBaseUrl(HOSTING_API_ORIGINS[next]);
                        setSettings(DEFAULT_HOSTING_SETTINGS);
                        setProvisioning(true);
                        invalidateConnection();
                        setTls("system");
                      }}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Connector name"
                    description="Display name used throughout Opfield."
                  >
                    <Input
                      aria-label="Connector name"
                      placeholder="Production hosting"
                      value={name}
                      disabled={locked}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="API origin"
                    description={
                      pve
                        ? "HTTPS address of your Proxmox API."
                        : "Official API address for this provider."
                    }
                    help="Enter only the HTTPS origin and port, without an API path."
                  >
                    <Input
                      aria-label="API origin"
                      placeholder="https://pve.example.com:8006"
                      value={pve ? baseUrl : HOSTING_API_ORIGINS[provider]}
                      disabled={locked || !pve}
                      onChange={(e) => {
                        setBaseUrl(e.target.value);
                        invalidateConnection();
                      }}
                    />
                  </SettingsControlRow>
                  {pve && (
                    <SettingsControlRow
                      title="Token ID"
                      description="User, realm and name of the API token."
                      help="This identifier is not the secret. Enter its secret in API token below."
                    >
                      <Input
                        aria-label="Token ID"
                        placeholder="opfield@pve!hosting"
                        value={settings.tokenId ?? ""}
                        disabled={locked}
                        onChange={(e) => {
                          set({ tokenId: e.target.value });
                          invalidateConnection();
                        }}
                      />
                    </SettingsControlRow>
                  )}
                  <SettingsControlRow
                    title={
                      provider === "hostkey"
                        ? connector
                          ? "Replacement API key"
                          : "API key"
                        : connector
                          ? "Replacement token"
                          : "API token"
                    }
                    description={
                      provider === "hostkey"
                        ? "Original HOSTKEY API key, not its displayed hash or a session token. Opfield manages session authorization automatically."
                        : connector?.provider === "hetzner"
                          ? "Create a new connector to change the Hetzner project token."
                          : connector
                            ? "Leave blank to retain the saved token. Re-enter it to change the API address or TLS policy."
                            : "API credential for the provider account."
                    }
                    help={
                      provider === "hostkey"
                        ? "Create a dedicated key in Invapi → API keys. For an existing connector, leave blank to retain its saved key. Credentials are encrypted and never displayed."
                        : provider === "cloudblast"
                          ? "Create a token in CloudBlast Account Settings → API. New servers get Opfield over SSH with a one-time key that is deleted after installation. Saved credentials are encrypted and never displayed."
                          : "Use a dedicated scoped token. Saved credentials are encrypted and never displayed."
                    }
                  >
                    <Input
                      aria-label={provider === "hostkey" ? "API key" : "API token"}
                      type="password"
                      placeholder={
                        provider === "hostkey"
                          ? connector
                            ? "Leave blank to keep the saved key"
                            : "Original HOSTKEY API key"
                          : connector
                            ? "Leave blank to keep the saved token"
                            : "Provider API token"
                      }
                      value={token}
                      autoComplete="new-password"
                      disabled={locked || (!!connector && provider === "hetzner")}
                      onChange={(e) => {
                        setToken(e.target.value);
                        invalidateConnection();
                      }}
                    />
                  </SettingsControlRow>
                  {connector && (
                    <SettingsControlRow
                      title="Enabled"
                      description="Allow Opfield to use this connector."
                      help="Disabling it does not stop or delete provider VMs."
                    >
                      <Switch
                        ariaLabel="Enabled"
                        checked={enabled}
                        disabled={locked}
                        onChange={setEnabled}
                      />
                    </SettingsControlRow>
                  )}
                </PanelShell>
              )}
              {pve && step === 2 && (
                <PanelShell
                  title="Proxmox host and trust"
                  icon={<KeyRound className="h-4 w-4" />}
                  description="One physical host per connector; cluster identity is detected by Opfield."
                >
                  <SettingsControlRow
                    title="Certificate verification"
                    description="How Opfield verifies the Proxmox HTTPS certificate."
                    help="Use system trust, your private CA, or an independently verified fingerprint. TLS verification cannot be disabled."
                  >
                    <Combobox
                      ariaLabel="Certificate verification"
                      value={tls}
                      disabled={locked}
                      options={[
                        { value: "system", label: "System trust" },
                        { value: "ca", label: "Private CA certificate" },
                        { value: "pin", label: "Verified certificate fingerprint" },
                      ]}
                      onValueChange={(value) => {
                        setTls(value as typeof tls);
                        invalidateConnection();
                      }}
                    />
                  </SettingsControlRow>
                  {tls === "ca" && (
                    <SettingsControlRow
                      title="Trusted CA certificate"
                      description="PEM certificate of your private certificate authority."
                      help="Verify the CA independently before trusting certificates it signs."
                    >
                      <Textarea
                        aria-label="CA certificate"
                        placeholder="-----BEGIN CERTIFICATE-----"
                        rows={4}
                        value={settings.caCertificate ?? ""}
                        disabled={locked}
                        onChange={(e) => {
                          set({ caCertificate: e.target.value });
                          invalidateConnection();
                        }}
                      />
                    </SettingsControlRow>
                  )}
                  {tls === "pin" && (
                    <SettingsControlRow
                      title="Certificate SHA-256 pin"
                      description="Fingerprint of the Proxmox API certificate."
                      help="Verify this fingerprint on the Proxmox server through a trusted channel; do not trust an unknown certificate automatically."
                    >
                      <Input
                        aria-label="Certificate SHA-256 pin"
                        placeholder="64 hexadecimal characters"
                        value={settings.certificateFingerprint ?? ""}
                        disabled={locked}
                        onChange={(e) => {
                          set({ certificateFingerprint: e.target.value });
                          invalidateConnection();
                        }}
                      />
                    </SettingsControlRow>
                  )}
                  <SettingsControlRow
                    title="Physical host"
                    description="Test the connection to load available Proxmox hosts."
                    help="New VMs stay on this host. VMIDs remain unique across the entire cluster."
                  >
                    <Combobox
                      ariaLabel="Physical host"
                      value={host}
                      disabled={locked || !discovery}
                      options={options(discovery?.hosts ?? [])}
                      onValueChange={(value) => {
                        set({ proxmoxHost: value });
                        updatePlacement({
                          nodes: [value],
                          storage: "",
                          imageStorage: "",
                          seedStorage: "",
                          bridge: "",
                        });
                      }}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="VM provisioning"
                    description="Create new VMs using a saved host and network profile."
                    help="Turn off to connect existing VM/CT inventory and automatic adoption only."
                  >
                    <Switch
                      ariaLabel="VM provisioning"
                      checked={provisioning}
                      disabled={locked}
                      onChange={setProvisioning}
                    />
                  </SettingsControlRow>
                </PanelShell>
              )}
              {pve && provisioning && step === 3 && (
                <PanelShell
                  title="Infrastructure"
                  icon={<Settings2 className="h-4 w-4" />}
                  description="Choose disk, image import and seed ISO storage, allowed VMIDs and optional aggregate budgets."
                >
                  <SettingsControlRow
                    title="Disk storage"
                    description="Storage for VM disks; it must provide images content."
                    help="Choose storage on the selected host that can hold imported VM disks."
                  >
                    <Combobox
                      ariaLabel="Disk storage"
                      value={placement.storage}
                      disabled={locked}
                      options={options(diskStorages)}
                      onValueChange={(storage) => updatePlacement({ storage })}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Image storage"
                    description="Storage for temporary OS images; it must support import content."
                    help="Use dedicated storage. Proxmox requires Datastore.AllocateTemplate to upload and Datastore.Allocate to clean up operation-owned files."
                  >
                    <Combobox
                      ariaLabel="Image storage"
                      value={placement.imageStorage ?? ""}
                      disabled={locked}
                      options={options(imageStorages)}
                      onValueChange={(imageStorage) => updatePlacement({ imageStorage })}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Seed storage"
                    description="Storage for per-VM NoCloud seed ISOs; it must provide iso content."
                    help="Use dedicated ISO storage. Proxmox requires Datastore.Allocate on this storage for automatic cleanup after enrollment; do not grant global administrator access."
                  >
                    <Combobox
                      ariaLabel="Seed storage"
                      value={placement.seedStorage ?? ""}
                      disabled={locked}
                      options={options(seedStorages)}
                      onValueChange={(seedStorage) => updatePlacement({ seedStorage })}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Allowed VMIDs"
                    description={
                      vmidError ??
                      `Comma-separated IDs and ranges, combined as needed. ${vmids.length} allowed · ${vmids.filter((id) => discovery?.usedVmids?.includes(id)).length} occupied · ${vmids.filter((id) => !discovery?.usedVmids?.includes(id)).length} available at last check.`
                    }
                    help="Opfield creates only inside this pool and skips occupied IDs across the cluster. Maximum 1000 unique IDs."
                  >
                    <Input
                      aria-label="Allowed VMIDs"
                      placeholder="250-260,271,273-280"
                      value={placement.vmidRange ?? ""}
                      disabled={locked}
                      onChange={(e) => updatePlacement({ vmidRange: e.target.value })}
                    />
                  </SettingsControlRow>
                  {(
                    [
                      [
                        "maxCpu",
                        "Maximum CPU budget (cores)",
                        "Unlimited",
                        "vCPU budget for Opfield-created or adopted resources, including pending operations.",
                        "Leave blank for unrestricted total CPU.",
                      ],
                      [
                        "maxMemoryMb",
                        "Maximum memory budget (MiB)",
                        "Unlimited",
                        "Memory budget for Opfield-created or adopted resources, including pending operations.",
                        "Leave blank for unrestricted total memory.",
                      ],
                      [
                        "maxDiskGb",
                        "Maximum disk budget (GiB)",
                        "Unlimited",
                        "Disk budget for Opfield-created or adopted resources, including pending operations.",
                        "Leave blank for unrestricted total disk.",
                      ],
                    ] as const
                  ).map(([key, label, placeholder, description, help]) => (
                    <SettingsControlRow
                      key={key}
                      title={label}
                      description={description}
                      help={help}
                    >
                      <Input
                        aria-label={label}
                        type="number"
                        min={1}
                        placeholder={placeholder}
                        value={placement[key] ?? ""}
                        disabled={locked}
                        onChange={(e) =>
                          updatePlacement({
                            [key]: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />
                    </SettingsControlRow>
                  ))}
                  <SettingsControlRow
                    title="Resource pool"
                    description="Optional existing Proxmox pool for new VMs."
                  >
                    <Input
                      aria-label="Resource pool"
                      placeholder="opfield-nodes"
                      value={placement.pool ?? ""}
                      disabled={locked}
                      onChange={(e) => updatePlacement({ pool: e.target.value })}
                    />
                  </SettingsControlRow>
                </PanelShell>
              )}
              {pve && provisioning && step === 4 && (
                <PanelShell
                  title="Network defaults"
                  icon={<Network className="h-4 w-4" />}
                  description="Applied to new VMs only; existing guests and hypervisor networks stay unchanged."
                >
                  <SettingsControlRow
                    title="Bridge"
                    description="Existing bridge for the VM network interface."
                    help="This is the bridge on the hypervisor, not the interface name inside Linux."
                  >
                    <Combobox
                      ariaLabel="Bridge"
                      value={placement.bridge}
                      disabled={locked}
                      options={options(
                        (discovery?.bridges ?? []).filter((item) => item.host === host)
                      )}
                      onValueChange={(bridge) => updatePlacement({ bridge })}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="VLAN"
                    description="VLAN tag, or leave blank for untagged networking."
                    help="The bridge and upstream network must already support this VLAN. Opfield does not reconfigure them."
                  >
                    <Input
                      aria-label="VLAN"
                      type="number"
                      min={1}
                      max={4094}
                      placeholder="Untagged"
                      value={placement.vlan ?? ""}
                      disabled={locked}
                      onChange={(e) =>
                        updatePlacement({ vlan: e.target.value ? Number(e.target.value) : null })
                      }
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Address assignment"
                    description="DHCP or automatic allocation from a static IPv4 pool."
                  >
                    <Combobox
                      ariaLabel="Address assignment"
                      value={placement.network}
                      disabled={locked}
                      options={[
                        { value: "dhcp", label: "DHCP" },
                        { value: "static", label: "Static IPv4 pool" },
                      ]}
                      onValueChange={(network) =>
                        updatePlacement({ network: network as Placement["network"] })
                      }
                    />
                  </SettingsControlRow>
                  {placement.network === "static" && (
                    <>
                      <SettingsControlRow
                        title="IP pool"
                        description="IPv4 addresses and full ranges reserved exclusively for Opfield."
                        help="Exclude these addresses from DHCP and manual assignment. Opfield rejects addresses outside the subnet, the gateway, network and broadcast addresses; silence on ping is not proof an IP is free."
                      >
                        <Input
                          aria-label="IP pool"
                          placeholder="192.0.2.100-192.0.2.119,192.0.2.150"
                          value={placement.ipRange ?? ""}
                          disabled={locked}
                          onChange={(e) => updatePlacement({ ipRange: e.target.value })}
                        />
                      </SettingsControlRow>
                      <SettingsControlRow title="Address capacity">
                        <span className="text-sm text-muted-foreground">
                          {ipError ??
                            `${ips.length} addresses for ${vmids.length} VMIDs${ips.length < vmids.length ? " — more addresses required" : ""}`}
                        </span>
                      </SettingsControlRow>
                      {(
                        [
                          [
                            "subnet",
                            "Subnet",
                            "192.0.2.0/24",
                            "CIDR subnet containing the entire IP pool.",
                          ],
                          [
                            "gateway",
                            "Gateway",
                            "192.0.2.1",
                            "Default router in the selected subnet.",
                          ],
                        ] as const
                      ).map(([key, label, placeholder, description]) => (
                        <SettingsControlRow key={key} title={label} description={description}>
                          <Input
                            aria-label={label}
                            placeholder={placeholder}
                            value={placement[key] ?? ""}
                            disabled={locked}
                            onChange={(e) => updatePlacement({ [key]: e.target.value })}
                          />
                        </SettingsControlRow>
                      ))}
                    </>
                  )}
                  <SettingsControlRow
                    title="DNS servers"
                    description="Optional comma-separated resolver addresses."
                    help="Applied via cloud-init. If omitted, DNS comes from DHCP or the selected cloud image."
                  >
                    <Input
                      aria-label="DNS servers"
                      placeholder="192.0.2.53,192.0.2.54"
                      value={dns}
                      disabled={locked}
                      onChange={(e) => {
                        setDns(e.target.value);
                        updatePlacement({ dnsServers: entries(e.target.value) });
                      }}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Search domain"
                    description="Optional DNS search suffix."
                  >
                    <Input
                      aria-label="Search domain"
                      placeholder="nodes.example.com"
                      value={placement.searchDomain ?? ""}
                      disabled={locked}
                      onChange={(e) => updatePlacement({ searchDomain: e.target.value })}
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="MTU"
                    description="Optional interface MTU; blank preserves the template value."
                    help="Only override if the entire network path supports the chosen MTU."
                  >
                    <Input
                      aria-label="MTU"
                      type="number"
                      min={576}
                      max={65520}
                      placeholder="Proxmox default"
                      value={placement.mtu ?? ""}
                      disabled={locked}
                      onChange={(e) =>
                        updatePlacement({
                          mtu: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="Interface firewall"
                    description="Firewall flag for the new VM network interface."
                    help="Default leaves the interface flag to Proxmox. This does not create firewall rules or change the host firewall."
                  >
                    <Combobox
                      ariaLabel="Interface firewall"
                      value={
                        placement.firewall === undefined ? "inherit" : String(placement.firewall)
                      }
                      disabled={locked}
                      options={[
                        { value: "inherit", label: "Proxmox default" },
                        { value: "true", label: "Enabled" },
                        { value: "false", label: "Disabled" },
                      ]}
                      onValueChange={(value) =>
                        updatePlacement({
                          firewall: value === "inherit" ? undefined : value === "true",
                        })
                      }
                    />
                  </SettingsControlRow>
                </PanelShell>
              )}
              {last && (
                <>
                  {pve && provisioning && (
                    <PanelShell
                      title="Profile summary"
                      icon={<Check className="h-4 w-4" />}
                      description="Nothing is provisioned when saving this connector. Node role, OS and resources are chosen when a VM is created."
                    >
                      <SettingsControlRow title="Physical host">
                        <span className="text-sm text-muted-foreground">{host}</span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Disk storage">
                        <span className="text-sm text-muted-foreground">{placement.storage}</span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Image storage">
                        <span className="text-sm text-muted-foreground">
                          {placement.imageStorage}
                        </span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Seed storage">
                        <span className="text-sm text-muted-foreground">
                          {placement.seedStorage}
                        </span>
                      </SettingsControlRow>
                      <SettingsControlRow title="VMIDs">
                        <span className="text-sm text-muted-foreground">{placement.vmidRange}</span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Total CPU limit">
                        <span className="text-sm text-muted-foreground">
                          {placement.maxCpu == null ? "Unlimited" : `${placement.maxCpu} cores`}
                        </span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Total memory limit">
                        <span className="text-sm text-muted-foreground">
                          {placement.maxMemoryMb == null
                            ? "Unlimited"
                            : `${placement.maxMemoryMb.toLocaleString()} MiB`}
                        </span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Total disk limit">
                        <span className="text-sm text-muted-foreground">
                          {placement.maxDiskGb == null
                            ? "Unlimited"
                            : `${placement.maxDiskGb.toLocaleString()} GiB`}
                        </span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Network bridge">
                        <span className="text-sm text-muted-foreground">{placement.bridge}</span>
                      </SettingsControlRow>
                      <SettingsControlRow title="VLAN">
                        <span className="text-sm text-muted-foreground">
                          {placement.vlan ?? "Untagged"}
                        </span>
                      </SettingsControlRow>
                      <SettingsControlRow title="Address assignment">
                        <span className="text-sm text-muted-foreground">
                          {placement.network === "static" ? "Static" : "DHCP"}
                        </span>
                      </SettingsControlRow>
                      {placement.network === "static" && (
                        <SettingsControlRow
                          title="IP pool"
                          description={`${ips.length} reserved addresses`}
                        >
                          <span className="text-sm text-muted-foreground">{placement.ipRange}</span>
                        </SettingsControlRow>
                      )}
                      <SettingsControlRow
                        title="Guest connectivity"
                        description="New VMs must reach Opfield or a relay, DNS and installation sources."
                        help="Connectivity can only be verified after a guest starts; saving a connector does not provision a VM."
                      >
                        <span className="text-sm text-muted-foreground">
                          Verified after provisioning
                        </span>
                      </SettingsControlRow>
                    </PanelShell>
                  )}
                  <PanelShell
                    title="Synchronization and scope"
                    icon={<RefreshCw className="h-4 w-4" />}
                    description="Inventory refresh and automatic matching of existing Opfield nodes."
                  >
                    <SettingsControlRow
                      title="Automatic sync"
                      description="Refresh provider inventory on a schedule."
                      help="Existing Opfield monitoring remains unchanged."
                    >
                      <Switch
                        ariaLabel="Automatic sync"
                        checked={settings.autoSyncEnabled}
                        disabled={locked}
                        onChange={(autoSyncEnabled) => set({ autoSyncEnabled })}
                      />
                    </SettingsControlRow>
                    <SettingsControlRow
                      title="Sync interval (seconds)"
                      description="Time between scheduled inventory refreshes."
                      help="Choose 60–86400 seconds; shorter intervals make more API requests."
                    >
                      <Input
                        aria-label="Sync interval"
                        type="number"
                        min={60}
                        max={86400}
                        placeholder="300"
                        value={settings.autoSyncIntervalSeconds}
                        disabled={locked}
                        onChange={(e) => set({ autoSyncIntervalSeconds: Number(e.target.value) })}
                      />
                    </SettingsControlRow>
                    <SettingsControlRow
                      title="Automatic adoption"
                      description="Link existing nodes automatically when identity evidence is unambiguous."
                      help="Opfield preserves node identity and workloads; ambiguous matches remain unlinked without a manual picker."
                    >
                      <Switch
                        ariaLabel="Automatic adoption"
                        checked={settings.adoptionEnabled}
                        disabled={locked}
                        onChange={(adoptionEnabled) => set({ adoptionEnabled })}
                      />
                    </SettingsControlRow>
                    {!pve && (
                      <SettingsControlRow
                        title="Node scope"
                        description="Optional comma-separated Opfield node UUIDs."
                        help="Limits which existing Opfield nodes can be automatically linked. Empty means all authorized nodes, not provider VMIDs."
                      >
                        <Input
                          aria-label="Node scope"
                          placeholder="Opfield node UUIDs"
                          value={nodeScope}
                          disabled={locked}
                          onChange={(e) => {
                            setNodeScope(e.target.value);
                            set({ adoptionNodeIds: entries(e.target.value) });
                          }}
                        />
                      </SettingsControlRow>
                    )}
                    {pve && settings.adoptionNodeIds.length > 0 && (
                      <SettingsControlRow
                        title="Existing adoption restriction"
                        description="The saved restriction to these Opfield nodes remains unchanged."
                      >
                        <span className="text-sm text-muted-foreground">
                          {settings.adoptionNodeIds.join(", ")}
                        </span>
                      </SettingsControlRow>
                    )}
                    {!pve &&
                      (
                        [
                          [
                            "defaultLocation",
                            "Default location",
                            "Provider location ID",
                            "Optional location preselected for new VMs.",
                          ],
                          [
                            "defaultSize",
                            "Default size",
                            "Provider size ID",
                            "Optional VM size preselected for new VMs.",
                          ],
                          [
                            "defaultImage",
                            "Default image",
                            "Provider image ID",
                            "Optional OS image preselected for new VMs.",
                          ],
                        ] as const
                      ).map(([key, label, placeholder, description]) => (
                        <SettingsControlRow
                          key={key}
                          title={label}
                          description={description}
                          help="Use an ID from the provider catalog. The node wizard validates defaults before ordering."
                        >
                          <Input
                            aria-label={label}
                            placeholder={placeholder}
                            value={settings[key] ?? ""}
                            disabled={locked}
                            onChange={(e) => set({ [key]: e.target.value })}
                          />
                        </SettingsControlRow>
                      ))}
                  </PanelShell>
                </>
              )}
            </motion.div>
          </AnimatedSwitch>
        )}
        <DialogFooter>
          {step === connectionStep && (
            <Button
              variant="outline"
              pending={pendingAction === "test"}
              disabled={locked || stepInvalid}
              onClick={() => void advance(true)}
            >
              {pendingAction !== "test" && connectionTested ? <Check /> : null}
              Test Connection
            </Button>
          )}
          {step === 1 ? (
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setStep((current) => current - 1);
              }}
            >
              <ArrowLeft />
              Back
            </Button>
          )}
          <Button
            pending={pendingAction === "continue" || pendingAction === "save"}
            disabled={locked || stepInvalid || hostRequired}
            onClick={() => void advance()}
          >
            {pendingAction !== "continue" && pendingAction !== "save" && last && !connector ? (
              <KeyRound />
            ) : null}
            {last
              ? connector
                ? "Save"
                : "Create connector"
              : steps[step] === "Review"
                ? "Review"
                : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
