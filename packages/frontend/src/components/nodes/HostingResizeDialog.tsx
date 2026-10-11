import { Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { performHostingAction } from "@/lib/hosting-intents";
import { formatHostingAmount } from "@/lib/hosting-money";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import type {
  HostingActionInput,
  HostingCatalog,
  HostingOperation,
  HostingProvider,
  HostingResource,
} from "@/types/hosting";
import { hostingSizeDescription } from "./HostingNodeWizard";

export function HostingResizeDialog({
  resource,
  provider,
  catalog,
  onClose,
  onChanged,
}: {
  resource: HostingResource | null;
  provider: HostingProvider;
  catalog?: HostingCatalog | null;
  onClose: () => void;
  onChanged?: (operation: HostingOperation) => void;
}) {
  const displayed = useRetainedDialogValue(resource, !!resource);
  const [form, setForm] = useState({ size: "", cpu: "", memoryMb: "", diskGb: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const currentTarget = useRef(resource);
  currentTarget.current = resource;
  useEffect(
    () => () => {
      currentTarget.current = null;
    },
    []
  );
  useEffect(() => {
    if (resource)
      setForm({
        size: resource.sizeId ?? "",
        cpu: String(resource.cpu ?? ""),
        memoryMb: String(resource.memoryMb ?? ""),
        diskGb: String(resource.diskGb ?? ""),
      });
    setError(null);
  }, [resource]);
  const sizes =
    catalog?.sizes.filter(
      (x) => !x.locations?.length || x.locations.includes(displayed?.location ?? "")
    ) ?? [];
  const size = sizes.find((x) => x.id === form.size);
  const price = size?.locationPrices?.[displayed?.location ?? ""] ?? size?.price;
  const shrink =
    provider === "proxmox" &&
    !!form.diskGb &&
    (displayed?.diskGb == null || Number(form.diskGb) < displayed.diskGb);
  const submit = async () => {
    if (!resource?.incarnation || sending.current || shrink) return;
    const target = resource;
    const authKey = accessContextKey(useAuthStore.getState());
    const isCurrent = () =>
      currentTarget.current?.id === target.id &&
      currentTarget.current.incarnation === target.incarnation &&
      accessContextKey(useAuthStore.getState()) === authKey;
    const extra: Partial<HostingActionInput> = {};
    if (provider === "proxmox") {
      for (const key of ["cpu", "memoryMb", "diskGb"] as const) {
        if (!form[key]) continue;
        const value = Number(form[key]);
        if (!Number.isInteger(value) || value <= 0) {
          setError("CPU, memory, and disk must be positive integers.");
          return;
        }
        if (value !== target[key]) extra[key] = value;
      }
      if (!Object.keys(extra).length) {
        setError("Change at least one CPU, memory, or disk value.");
        return;
      }
    } else {
      if (!size || !price) {
        setError("Select a provider size with a current quote.");
        return;
      }
      extra.size = size.id;
      extra.confirmedPrice = { amount: price.amount, currency: price.currency };
    }
    sending.current = true;
    setBusy(true);
    try {
      if (
        !(await confirm({
          title: "Confirm Resource Resize",
          description: `Resize “${target.name}”? All Opfield roles on this VM are affected.${price ? ` Selected quote: ${formatHostingAmount(price.amount)} ${price.currency}.` : ""}`,
          confirmLabel: "Resize resource",
        }))
      )
        return;
      if (!isCurrent()) return;
      const operation = await performHostingAction(target.id, {
        ...extra,
        action: "resize",
        expectedIncarnation: target.incarnation!,
        confirmed: true,
      });
      if (!isCurrent()) return;
      onChanged?.(operation);
      onClose();
      toast.success("Resize requested");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resize failed");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!resource}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Resize Provider Resource</DialogTitle>
          <DialogDescription>
            Configure the VM resources. Shut down the VM before resizing; disks can only grow.
          </DialogDescription>
        </DialogHeader>
        {displayed && (
          <div className="space-y-4">
            <PanelShell
              title={displayed.name}
              icon={<Server className="h-4 w-4" />}
              description={`Provider ID ${displayed.remoteId}`}
            >
              {provider === "proxmox" ? (
                (
                  [
                    ["cpu", "CPU"],
                    ["memoryMb", "Memory (MB)"],
                    ["diskGb", "Disk (GB)"],
                  ] as const
                ).map(([key, title]) => (
                  <SettingsControlRow
                    key={key}
                    title={title}
                    description={key === "diskGb" ? "Disks cannot be reduced." : undefined}
                  >
                    <Input
                      aria-label={title}
                      type="number"
                      min={key === "diskGb" ? (displayed.diskGb ?? 1) : 1}
                      disabled={busy || (key === "diskGb" && displayed.diskGb == null)}
                      value={form[key]}
                      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    />
                  </SettingsControlRow>
                ))
              ) : (
                <>
                  <SettingsControlRow title="Server size">
                    <Select
                      value={size ? form.size : ""}
                      onValueChange={(value) => setForm((f) => ({ ...f, size: value }))}
                      disabled={busy}
                    >
                      <SelectTrigger aria-label="Server size">
                        <SelectValue placeholder="Select catalog size" />
                      </SelectTrigger>
                      <SelectContent>
                        {sizes.map((option) => (
                          <SelectItem
                            key={option.id}
                            value={option.id}
                            description={hostingSizeDescription(option, displayed.location)}
                          >
                            {option.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsControlRow>
                  <SettingsControlRow title="Selected quote">
                    <span className="text-sm text-muted-foreground">
                      {price
                        ? `${formatHostingAmount(price.amount)} ${price.currency} (estimated)`
                        : "Quote unavailable"}
                    </span>
                  </SettingsControlRow>
                </>
              )}
            </PanelShell>
            <p className="text-xs text-muted-foreground">
              Affected Opfield nodes:{" "}
              {displayed.nodes.map((n) => `${n.name} · ${n.type}`).join(", ") || "none"}.
            </p>
          </div>
        )}
        {(error || shrink) && (
          <p role="alert" className="text-sm text-destructive">
            {shrink ? "Shrinking disks is not supported." : error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            pending={busy}
            disabled={
              shrink || !resource?.incarnation || (provider !== "proxmox" && (!size || !price))
            }
            onClick={() => void submit()}
          >
            Resize resource
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
