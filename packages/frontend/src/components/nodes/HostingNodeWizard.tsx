import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { type FolderOption, flattenFolderTree } from "@/components/common/scope-list-helpers";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClientUuid } from "@/lib/client-id";
import { formatHostingAmount } from "@/lib/hosting-money";
import { nodeTypeLabel } from "@/lib/node-appearance";
import { canCreateInFolder } from "@/lib/scope-utils";
import { AnimatedHeight, STEP_ANIMATION } from "@/pages/notifications/template-editor";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import type {
  HostingCatalog,
  HostingCatalogOption,
  HostingConnector,
  HostingOperation,
  HostingProvisionInput,
  HostingResource,
  HostingRole,
} from "@/types/hosting";

export function hostingHostnameError(value: string) {
  const hostname = value.trim();
  if (!hostname) return "Hostname is required.";
  if (hostname.length > 63 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(hostname))
    return "Use 1–63 letters, digits or hyphens. Start and end with a letter or digit.";
  return null;
}

const ROLES: HostingRole[] = ["nginx", "docker", "builder", "storage", "monitoring", "relay"];
type Draft = { input: HostingProvisionInput };

function imageSupportsRole(image: HostingCatalog["images"][number], role: HostingRole) {
  return image.supportedRoles?.includes(role) === true;
}

export function hostingWizardPrice(
  catalog: HostingCatalog | null,
  sizeId: string,
  location: string
) {
  const size = catalog?.sizes.find((option) => option.id === sizeId);
  return size?.locationPrices?.[location] ?? size?.price;
}

export function hostingSizeDescription(
  option: HostingCatalogOption,
  location: string,
  includePrice = true
) {
  const price = option.locationPrices?.[location] ?? option.price;
  return [
    option.cpu != null ? `${option.cpu} vCPU` : null,
    option.memoryMb != null ? `${option.memoryMb / 1024} GiB RAM` : null,
    option.diskGb != null ? `${option.diskGb} GB disk` : null,
    includePrice && price
      ? `${formatHostingAmount(price.amount)} ${price.currency} / ${price.period ?? "billing period"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function HostingNodeWizard({
  open,
  onClose,
  connectorId,
  existingResource,
  onCreated,
  onModeLockChange,
  render,
}: {
  open: boolean;
  onClose: () => void;
  connectorId?: string;
  existingResource?: HostingResource;
  onCreated?: (operation: HostingOperation) => void;
  onModeLockChange?: (locked: boolean) => void;
  render?: (slots: { body: ReactNode; footer: ReactNode }) => ReactNode;
}) {
  const { user, hasScope } = useAuthStore();
  const actorId = user?.id;
  const existingId = existingResource?.id;
  const [connectors, setConnectors] = useState<HostingConnector[]>([]);
  const [catalog, setCatalog] = useState<HostingCatalog | null>(null);
  const [sshOptions, setSshOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [selected, setSelected] = useState(connectorId ?? "");
  const [role, setRole] = useState<HostingRole>("docker");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const hostnameError = hostingHostnameError(name);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const canCreateNode = canCreateInFolder(user?.scopes ?? [], "nodes:create", folderId);
  // Options the first step renders. Each flag turns true when its request settles and resets
  // when the wizard closes, so every opening waits for fresh options.
  const [optionsLoaded, setOptionsLoaded] = useState({
    folders: false,
    connectors: false,
    ssh: false,
    catalogFor: null as string | null,
  });
  useEffect(() => {
    if (!open)
      setOptionsLoaded({ folders: false, connectors: false, ssh: false, catalogFor: null });
  }, [open]);
  useEffect(() => {
    if (!open || !actorId) return;
    let cancelled = false;
    setFolderId(null);
    setFolders([]);
    void api
      .listNodeFolders()
      .then((tree) => {
        if (!cancelled) setFolders(flattenFolderTree(tree, "nodes"));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setOptionsLoaded((current) => ({ ...current, folders: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [open, actorId]);
  const [location, setLocation] = useState("");
  const [size, setSize] = useState("");
  const [image, setImage] = useState("");
  const [cpu, setCpu] = useState("2");
  const [memory, setMemory] = useState("2048");
  const [disk, setDisk] = useState("20");
  const [ip, setIp] = useState("");
  const [relay, setRelay] = useState("");
  const [ssh, setSsh] = useState("");
  const [step, setStep] = useState<"role" | "resources" | "review">("role");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (error) toast.error(error, { id: "hosting-node-error" });
  }, [error]);
  useEffect(() => {
    onModeLockChange?.(busy);
  }, [busy, onModeLockChange]);
  const draft = useRef<Draft | null>(null);
  const session = useRef(0);
  const submitting = useRef(false);
  const connector = connectors.find((item) => item.id === selected);
  const price = existingResource ? undefined : hostingWizardPrice(catalog, size, location);
  const pve = connector?.provider === "proxmox";
  const roleImages =
    catalog?.images.filter(
      (item) =>
        imageSupportsRole(item, role) &&
        (item.compatibleSizes === undefined || item.compatibleSizes.includes(size)) &&
        (!item.locations?.length || item.locations.includes(location)) &&
        (!item.architecture ||
          !catalog.sizes.find((option) => option.id === size)?.architecture ||
          item.architecture === catalog.sizes.find((option) => option.id === size)?.architecture)
    ) ?? [];
  const availableSizes =
    catalog?.sizes.filter((item) => !item.locations?.length || item.locations.includes(location)) ??
    [];
  const selectedSize = availableSizes.find((item) => item.id === size);
  const [sizeFamily, setSizeFamily] = useState("");
  const family = sizeFamily || selectedSize?.name || availableSizes[0]?.name || "";
  const families = [...new Set(availableSizes.map((item) => item.name))];

  useEffect(() => {
    if (!open || !actorId) return;
    const generation = ++session.current;
    let cancelled = false;
    submitting.current = false;
    setBusy(false);
    setError(null);
    setStep("role");
    setSelected(connectorId ?? "");
    setSizeFamily("");
    setRole("docker");
    setSsh("");
    const initialName = `gateway-${createClientUuid().slice(0, 8)}`;
    setName(initialName);
    setDisplayName(initialName);
    setIp("");
    setRelay("");
    draft.current = null;
    setLocation("");
    setSize("");
    setImage("");
    setCpu("2");
    setMemory("2048");
    setDisk("20");
    void api
      .listHostingConnectors()
      .then((result) => {
        if (!cancelled) setConnectors(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setOptionsLoaded((current) => ({ ...current, connectors: true }));
      });
    if (existingId && hasScope("integrations:ssh:use")) {
      void api
        .listExternalSshConnectors()
        .then((result) => {
          if (!cancelled)
            setSshOptions(result.map((item) => ({ value: item.id, label: item.name })));
        })
        .catch(() => {
          if (!cancelled) setSshOptions([]);
        })
        .finally(() => {
          if (!cancelled) setOptionsLoaded((current) => ({ ...current, ssh: true }));
        });
    }
    return () => {
      cancelled = true;
      if (session.current === generation) session.current += 1;
    };
  }, [open, connectorId, existingId, actorId, hasScope]);

  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    setCatalog(null);
    setLoading(true);
    void api
      .getHostingCatalog(selected)
      .then((result) => {
        if (cancelled) return;
        setCatalog(result);
        if (draft.current?.input.connectorId !== selected) {
          const profile = connectors.find((item) => item.id === selected)?.settings;
          setLocation(
            existingResource?.location ??
              (profile?.proxmox?.nodes.length === 1 ? profile.proxmox.nodes[0] : undefined) ??
              result.locations[0]?.id ??
              ""
          );
          setSize(existingResource?.sizeId ?? result.sizes[0]?.id ?? "");
          const selectedImage = existingResource?.imageId
            ? result.images.find((option) => option.id === existingResource.imageId)
            : undefined;
          const initialImage = selectedImage ?? result.images[0];
          setImage(initialImage?.id ?? "");
          setCpu("2");
          setMemory("2048");
          setDisk(String(Math.max(20, initialImage?.diskGb ?? 0)));
          setIp("");
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setOptionsLoaded((current) =>
          current.catalogFor === selected ? current : { ...current, catalogFor: selected }
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open, selected, connectors, existingResource]);

  useEffect(() => {
    if (!catalog || existingResource || draft.current) return;
    if (roleImages.length === 0) {
      setImage("");
      return;
    }
    if (!roleImages.some((item) => item.id === image)) setImage(roleImages[0]!.id);
  }, [catalog, existingResource, image, roleImages]);

  const submit = async () => {
    if (submitting.current) return;
    if (!canCreateNode || !hasScope(`hosting:resources:create:${selected}`)) {
      setError("Select an authorized hosting account and destination folder");
      return;
    }
    const generation = session.current;
    submitting.current = true;
    const input: HostingProvisionInput = {
      connectorId: selected,
      folderId,
      idempotencyKey: draft.current?.input.idempotencyKey ?? createClientUuid(),
      name: name.trim(),
      displayName: displayName.trim(),
      role,
      location: existingResource?.location ?? location,
      size: size || "existing",
      image: image || "existing",
      ...(pve && !existingResource
        ? {
            cpu: Number(cpu),
            memoryMb: Number(memory),
            diskGb: Number(disk),
            ...(ip ? { ipAddress: ip } : {}),
          }
        : {}),
      ...(relay ? { relayAddress: relay } : {}),
      ...(price ? { confirmedPrice: { amount: price.amount, currency: price.currency } } : {}),
      ...(existingResource
        ? { existingResourceId: existingResource.id, ...(ssh ? { sshConnectorId: ssh } : {}) }
        : {}),
    };
    // Retain only the current form request for a safe retry after a lost HTTP response.
    // Background execution belongs to the backend, never to a reopened wizard.
    if (!draft.current) draft.current = { input };
    setBusy(true);
    setError(null);
    let accepted = false;
    try {
      const result = await api.provisionHostingNode(draft.current.input);
      accepted = true;
      onCreated?.(result);
      if (session.current === generation) onClose();
    } catch (cause) {
      if (session.current !== generation) return;
      setError(cause instanceof Error ? cause.message : "Could not submit the request");
      if (
        cause instanceof ApiRequestError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        [
          "HOSTING_PRICE_CHANGED",
          "HOSTING_PRICE_UNAVAILABLE",
          "HOSTING_CONFIGURATION_UNAVAILABLE",
          "HOSTING_GATEWAY_PRIVATE",
          "HOSTING_GATEWAY_INVALID",
          "HOSTING_GATEWAY_NOT_READY",
          "HOSTING_PROVIDER_PERMISSION_REQUIRED",
          "HOSTING_PROVIDER_ERROR",
          "HOSTING_IMAGE_UNSUPPORTED",
          "HOSTING_ARCHITECTURE_MISMATCH",
          "VALIDATION_ERROR",
        ].includes(cause.code ?? "")
      ) {
        // These admission errors occur before reserving an intent or contacting a mutation endpoint.
        draft.current = null;
        setStep("resources");
        void api
          .getHostingCatalog(selected)
          .then((result) => {
            if (session.current === generation) setCatalog(result);
          })
          .catch(() => undefined);
      }
    } finally {
      if (session.current === generation && !accepted) {
        submitting.current = false;
        setBusy(false);
      }
    }
  };

  const roleReady = Boolean(
    canCreateNode &&
      hasScope(`hosting:resources:create:${selected}`) &&
      !hostnameError &&
      displayName.trim().length > 0 &&
      displayName.trim().length <= 255 &&
      (role !== "relay" || relay.trim()) &&
      connector?.enabled &&
      (existingResource || connector.capabilities?.create) &&
      (existingResource || catalog?.images.some((item) => imageSupportsRole(item, role)))
  );
  const canReview = Boolean(
    canCreateNode &&
      hasScope(`hosting:resources:create:${selected}`) &&
      (existingResource || connector?.capabilities?.create) &&
      !hostnameError &&
      displayName.trim().length > 0 &&
      displayName.trim().length <= 255 &&
      (existingResource ||
        (location && selectedSize && roleImages.some((item) => item.id === image))) &&
      (role !== "relay" || relay.trim()) &&
      (!pve ||
        existingResource ||
        ([cpu, memory, disk].every(
          (value) =>
            Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 1_048_576
        ) &&
          Number(disk) >= (roleImages.find((item) => item.id === image)?.diskGb ?? 1))) &&
      (!existingResource || existingResource.capabilities.bootstrap.available || ssh)
  );
  const optionsLoading =
    open &&
    !!actorId &&
    (!optionsLoaded.folders ||
      !optionsLoaded.connectors ||
      (!!existingId && hasScope("integrations:ssh:use") && !optionsLoaded.ssh) ||
      (!!connectorId && optionsLoaded.catalogFor !== connectorId));
  const goBack =
    step !== "role" && !draft.current
      ? () => setStep(step === "resources" ? "role" : "resources")
      : undefined;
  const body = (
    <AnimatePresence initial={false} mode="wait">
      <motion.div key={step} {...STEP_ANIMATION} className="space-y-4">
        <ContentLoading loading={optionsLoading} />
        {step === "role" && (
          <div className="space-y-4">
            {(folders.length > 0 ||
              !canCreateInFolder(user?.scopes ?? [], "nodes:create", null)) && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Folder</label>
                <Select
                  value={
                    folderId ??
                    (canCreateInFolder(user?.scopes ?? [], "nodes:create", null) ? "__root__" : "")
                  }
                  onValueChange={(value) => setFolderId(value === "__root__" ? null : value)}
                >
                  <SelectTrigger aria-label="Node folder">
                    <SelectValue placeholder="Select a folder" />
                  </SelectTrigger>
                  <SelectContent>
                    {canCreateInFolder(user?.scopes ?? [], "nodes:create", null) && (
                      <SelectItem value="__root__">No folder</SelectItem>
                    )}
                    {folders
                      .filter((folder) =>
                        canCreateInFolder(user?.scopes ?? [], "nodes:create", folder.id)
                      )
                      .map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          {folder.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!connectorId && !existingResource && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Hosting Connector</label>
                <Select
                  value={selected}
                  onValueChange={(value) => {
                    setSelected(value);
                    setSizeFamily("");
                    setError(null);
                  }}
                >
                  <SelectTrigger aria-label="Hosting connector">
                    <SelectValue placeholder="Select a hosting account" />
                  </SelectTrigger>
                  <SelectContent>
                    {connectors.map((item) => (
                      <SelectItem
                        key={item.id}
                        value={item.id}
                        disabled={
                          !item.enabled ||
                          !item.capabilities?.create ||
                          !hasScope(`hosting:resources:create:${item.id}`)
                        }
                      >
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Choose where to create this node.</p>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Node Type</label>
              <Select
                value={role}
                onValueChange={(value) => {
                  const nextRole = value as HostingRole;
                  setRole(nextRole);
                  setError(null);
                  if (!existingResource && catalog) {
                    const candidates = catalog.images.filter((item) =>
                      imageSupportsRole(item, nextRole)
                    );
                    if (candidates.length === 0) {
                      setImage("");
                      toast.error("No OS image is available for the selected node role.");
                    } else if (!candidates.some((item) => item.id === image)) {
                      setImage(candidates[0]!.id);
                    }
                  }
                }}
              >
                <SelectTrigger aria-label="Node Type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((value) => (
                    <SelectItem
                      key={value}
                      value={value}
                      disabled={Boolean(
                        catalog && !catalog.images.some((item) => imageSupportsRole(item, value))
                      )}
                    >
                      {nodeTypeLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {catalog &&
                !catalog.images.some((item) => imageSupportsRole(item, role)) &&
                !existingResource
                  ? "No supported OS images are available for this node role."
                  : "Choose the Opfield service this node will provide."}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="hosting-display-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="hosting-display-name"
                aria-label="Node name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={255}
                placeholder="Build Worker"
              />
              <p className="text-xs text-muted-foreground">Display name in Opfield.</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="hosting-hostname" className="text-sm font-medium">
                Hostname
              </label>
              <Input
                id="hosting-hostname"
                aria-label="Hostname"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={!!hostnameError}
                aria-describedby="hosting-hostname-help"
                placeholder="build-worker"
              />
              <p
                id="hosting-hostname-help"
                className={
                  hostnameError ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                }
              >
                {hostnameError ??
                  "Network hostname used for the VM. Letters, digits and hyphens only."}
              </p>
            </div>
            {role === "relay" && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Relay Address</label>
                <Input
                  aria-label="Relay advertised address"
                  value={relay}
                  onChange={(event) => setRelay(event.target.value)}
                  placeholder="relay.example.com"
                />
                <p className="text-xs text-muted-foreground">
                  Reachable address advertised to participating nodes.
                </p>
              </div>
            )}
          </div>
        )}
        {step === "resources" && (
          <div className="space-y-4">
            {existingResource ? (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Existing VM</label>
                <p className="text-xs text-muted-foreground">{`${existingResource.name} · ${existingResource.remoteId}`}</p>
              </div>
            ) : (
              <>
                {!pve && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Location / Host</label>
                    <Select
                      disabled={!!connector?.settings.proxmoxHost}
                      value={location}
                      onValueChange={(value) => {
                        setLocation(value);
                        setSize("");
                        setSizeFamily("");
                      }}
                    >
                      <SelectTrigger aria-label="Location">
                        <SelectValue placeholder="Select a location" />
                      </SelectTrigger>
                      <SelectContent>
                        {catalog?.locations.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {connector?.provider === "digitalocean" && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Plan family</label>
                    <Select
                      value={family}
                      onValueChange={(value) => {
                        setSizeFamily(value);
                        setSize("");
                      }}
                    >
                      <SelectTrigger aria-label="Plan family">
                        <SelectValue placeholder="Select a plan family" />
                      </SelectTrigger>
                      <SelectContent>
                        {families.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Choose a family, then compare its available configurations below.
                    </p>
                  </div>
                )}
                {!pve && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Size</label>
                    <Select value={selectedSize ? size : ""} onValueChange={setSize}>
                      <SelectTrigger aria-label="Size">
                        <SelectValue placeholder="Select a size" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableSizes
                          .filter(
                            (item) => connector?.provider !== "digitalocean" || item.name === family
                          )
                          .map((item) => (
                            <SelectItem
                              key={item.id}
                              value={item.id}
                              textValue={`${item.name} · ${item.id}`}
                              description={hostingSizeDescription(item, location)}
                              className="items-start py-2"
                            >
                              {`${item.name} · ${item.id}`}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {selectedSize && (
                      <p className="text-xs text-muted-foreground">
                        {hostingSizeDescription(selectedSize, location)}
                      </p>
                    )}
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">OS Image</label>
                  <Select value={image} onValueChange={setImage}>
                    <SelectTrigger aria-label="Image">
                      <SelectValue placeholder="Select an OS image" />
                    </SelectTrigger>
                    <SelectContent>
                      {roleImages.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {pve
                      ? "Choose the canonical OS image for this node role."
                      : "Choose the provider OS image for this node role."}
                  </p>
                </div>
                {pve && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">vCPU</label>
                      <Input
                        aria-label="vCPU"
                        placeholder="2"
                        type="number"
                        min={1}
                        value={cpu}
                        onChange={(event) => setCpu(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Virtual CPU cores allocated to this VM. This allocation counts toward the
                        connector's managed CPU limit.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Memory (MiB)</label>
                      <Input
                        aria-label="Memory (MiB)"
                        placeholder="2048"
                        type="number"
                        min={1}
                        value={memory}
                        onChange={(event) => setMemory(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        1024 MiB equals 1 GiB. Pending allocations count toward the connector's
                        limit.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Disk (GiB)</label>
                      <Input
                        aria-label="Disk (GiB)"
                        placeholder="20"
                        type="number"
                        min={1}
                        value={disk}
                        onChange={(event) => setDisk(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Choose at least the minimum size required by the selected OS image. Disk
                        shrinking is not supported.
                      </p>
                    </div>
                    {connector.settings.proxmox?.network === "static" &&
                      !connector.settings.proxmox.ipRange && (
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Static IP</label>
                          <Input
                            aria-label="Static IP"
                            value={ip}
                            onChange={(event) => setIp(event.target.value)}
                            placeholder="192.0.2.10"
                          />
                          <p className="text-xs text-muted-foreground">
                            {connector.settings.proxmox.subnet}
                          </p>
                        </div>
                      )}
                    {connector.settings.proxmox?.ipRange && (
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">IP Address</label>
                        <p className="text-xs text-muted-foreground">
                          Opfield reserves an address from the connector pool when creating the VM.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
            {existingResource && !existingResource.capabilities.bootstrap.available && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Trusted SSH Connection</label>
                <Select value={ssh} onValueChange={setSsh}>
                  <SelectTrigger aria-label="SSH connection">
                    <SelectValue placeholder="Select a trusted SSH connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {sshOptions.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The connection must resolve to this VM's actual interface address.
                </p>
              </div>
            )}
          </div>
        )}
        {step === "review" && (
          <PanelShell
            title="Review node"
            description="Review the node and VM configuration before provisioning."
            icon={<Check className="h-4 w-4" />}
          >
            <SettingsControlRow title="Node" controlsClassName="text-right">
              <span className="text-sm text-muted-foreground">{`${displayName} · ${nodeTypeLabel(role)}`}</span>
            </SettingsControlRow>
            <SettingsControlRow title="Hostname" controlsClassName="text-right">
              <span className="text-sm text-muted-foreground">{name}</span>
            </SettingsControlRow>
            <SettingsControlRow title="Account" controlsClassName="text-right">
              <span className="text-sm text-muted-foreground">{connector?.name ?? selected}</span>
            </SettingsControlRow>
            <SettingsControlRow
              title={existingResource ? "Existing VM" : "Host / location"}
              controlsClassName="text-right"
            >
              <span className="text-sm text-muted-foreground">
                {existingResource ? existingResource.name : location}
              </span>
            </SettingsControlRow>
            {!existingResource && (
              <>
                <SettingsControlRow title="OS image" controlsClassName="text-right">
                  <span className="text-sm text-muted-foreground">
                    {catalog?.images.find((item) => item.id === image)?.name ?? image}
                  </span>
                </SettingsControlRow>
                {pve ? (
                  <>
                    <SettingsControlRow title="vCPU">
                      <span className="text-sm text-muted-foreground">{cpu}</span>
                    </SettingsControlRow>
                    <SettingsControlRow title="Memory (MiB)">
                      <span className="text-sm text-muted-foreground">
                        {Number(memory).toLocaleString()}
                      </span>
                    </SettingsControlRow>
                    <SettingsControlRow title="Disk (GiB)">
                      <span className="text-sm text-muted-foreground">
                        {Number(disk).toLocaleString()}
                      </span>
                    </SettingsControlRow>
                  </>
                ) : (
                  <SettingsControlRow title="Size" controlsClassName="text-right">
                    <span className="text-sm text-muted-foreground">
                      {selectedSize
                        ? `${selectedSize.name} · ${selectedSize.id} · ${hostingSizeDescription(selectedSize, location, false)}`
                        : size}
                    </span>
                  </SettingsControlRow>
                )}
              </>
            )}
            <SettingsControlRow title="Price" controlsClassName="text-right">
              <span className="text-sm text-muted-foreground">
                {existingResource
                  ? "Existing provider charges continue"
                  : price
                    ? `${formatHostingAmount(price.amount)} ${price.currency} / ${price.period ?? "billing period"}${price.estimated ? " (estimate)" : ""}`
                    : pve
                      ? "Your own infrastructure"
                      : "Provider price unavailable — check the provider account before proceeding"}
              </span>
            </SettingsControlRow>
          </PanelShell>
        )}
      </motion.div>
    </AnimatePresence>
  );
  const footer = (
    <>
      {goBack && (
        <Button variant="outline" disabled={busy} onClick={goBack}>
          Back
        </Button>
      )}
      {step === "role" && (
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      )}
      <Button
        pending={busy}
        disabled={
          loading ||
          (!existingResource && !connector?.capabilities?.create) ||
          (step === "role" && !roleReady) ||
          (step === "resources" && !canReview)
        }
        onClick={() =>
          step === "review" ? void submit() : setStep(step === "role" ? "resources" : "review")
        }
      >
        {busy
          ? "Submitting…"
          : step === "review"
            ? draft.current
              ? "Try again"
              : existingResource
                ? "Install Opfield"
                : "Confirm and create VM"
            : "Continue"}
      </Button>
    </>
  );
  return render ? (
    render({ body, footer })
  ) : (
    <>
      <AnimatedHeight>{body}</AnimatedHeight>
      <DialogFooter>{footer}</DialogFooter>
    </>
  );
}
