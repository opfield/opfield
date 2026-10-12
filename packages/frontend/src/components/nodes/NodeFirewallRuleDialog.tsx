import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { createClientUuid } from "@/lib/client-id";
import type {
  HostingFirewallAction,
  HostingFirewallProtocol,
  HostingFirewallRule,
} from "@/types/hosting";

export interface NodeFirewallRuleDialogState {
  direction: HostingFirewallRule["direction"];
  rule: HostingFirewallRule | null;
}

interface RuleFormState {
  action: HostingFirewallAction;
  protocol: HostingFirewallProtocol;
  ports: string;
  addresses: string;
  description: string;
}

export interface NodeFirewallRuleDialogProps {
  dialog: NodeFirewallRuleDialogState | null;
  disabled?: boolean;
  onClose: () => void;
  onSave: (rule: HostingFirewallRule) => void;
}

function emptyRuleForm(): RuleFormState {
  return {
    action: "allow",
    protocol: "tcp",
    ports: "all",
    addresses: "",
    description: "",
  };
}

function formForRule(rule: HostingFirewallRule): RuleFormState {
  return {
    action: rule.action,
    protocol: rule.protocol,
    ports: rule.ports,
    addresses: rule.addresses.join(", "),
    description: rule.description,
  };
}

function parseAddresses(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((address) => address.trim())
    .filter(Boolean);
}

function validateRuleForm(form: RuleFormState): string | null {
  if (parseAddresses(form.addresses).length === 0) return "Add at least one address or CIDR.";
  if (form.description.trim().length > 120) return "The comment must be 120 characters or fewer.";
  if (form.protocol === "icmp") return null;
  if (!/^(all|[1-9]\d{0,4}(?:-[1-9]\d{0,4})?)$/.test(form.ports.trim())) {
    return "Ports must be all, a port number, or a port range.";
  }
  if (form.ports.trim() === "all") return null;
  const [from, to = from] = form.ports.split("-").map(Number);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || to > 65535) {
    return "Ports must be between 1 and 65535.";
  }
  return null;
}

export function NodeFirewallRuleDialog({
  dialog,
  disabled = false,
  onClose,
  onSave,
}: NodeFirewallRuleDialogProps) {
  const displayedDialog = useRetainedDialogValue(dialog, Boolean(dialog));
  const [form, setForm] = useState<RuleFormState>(emptyRuleForm);

  useEffect(() => {
    if (!dialog) return;
    setForm(dialog.rule ? formForRule(dialog.rule) : emptyRuleForm());
  }, [dialog]);

  const save = () => {
    if (!dialog || !displayedDialog || disabled) return;
    const validationError = validateRuleForm(form);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    onSave({
      id: displayedDialog.rule?.id ?? createClientUuid(),
      direction: displayedDialog.direction,
      action: form.action,
      protocol: form.protocol,
      ports: form.protocol === "icmp" ? "all" : form.ports.trim(),
      addresses: parseAddresses(form.addresses),
      description: form.description.trim(),
    });
    onClose();
  };

  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {displayedDialog?.rule ? "Edit Firewall Rule" : "Add Firewall Rule"}
            {displayedDialog ? (
              <Badge variant="secondary" size="inline">
                {displayedDialog.direction === "in" ? "Inbound" : "Outbound"}
              </Badge>
            ) : null}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>
          This edits the local draft only. The provider is unchanged until you save the firewall
          configuration.
        </DialogDescription>
        {displayedDialog ? (
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="block font-medium">Action</span>
              <Select
                value={form.action}
                onValueChange={(action) =>
                  setForm((current) => ({
                    ...current,
                    action: action as HostingFirewallAction,
                  }))
                }
                disabled={disabled}
              >
                <SelectTrigger aria-label="Rule action">
                  <SelectValue placeholder="Select action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="block font-medium">Protocol</span>
              <Select
                value={form.protocol}
                onValueChange={(protocol) =>
                  setForm((current) => ({
                    ...current,
                    protocol: protocol as HostingFirewallProtocol,
                    ports: protocol === "icmp" ? "all" : current.ports,
                  }))
                }
                disabled={disabled}
              >
                <SelectTrigger aria-label="Rule protocol">
                  <SelectValue placeholder="Select protocol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                  <SelectItem value="icmp">ICMP</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="block font-medium">Ports</span>
              <span className="text-xs text-muted-foreground">
                Use all, a port, or a port range. ICMP has no ports.
              </span>
              <Input
                aria-label="Rule ports"
                placeholder="all, 443, or 8000-9000"
                value={form.ports}
                disabled={disabled || form.protocol === "icmp"}
                onChange={(event) =>
                  setForm((current) => ({ ...current, ports: event.target.value }))
                }
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="block font-medium">
                {displayedDialog.direction === "in" ? "Source addresses" : "Destination addresses"}
              </span>
              <span className="text-xs text-muted-foreground">
                {displayedDialog.direction === "in"
                  ? "Traffic from these IP addresses or CIDRs to this VM."
                  : "Traffic from this VM to these IP addresses or CIDRs."}{" "}
                Separate addresses with commas. Use 0.0.0.0/0 for any IPv4 address or ::/0 for any
                IPv6 address.
              </span>
              <Input
                aria-label={
                  displayedDialog.direction === "in" ? "Source addresses" : "Destination addresses"
                }
                placeholder="192.0.2.10, 10.0.0.0/8, 2001:db8::/32"
                value={form.addresses}
                disabled={disabled}
                onChange={(event) =>
                  setForm((current) => ({ ...current, addresses: event.target.value }))
                }
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="block font-medium">
                {displayedDialog.direction === "in" ? "Destination" : "Source"}
              </span>
              <Input
                aria-label={displayedDialog.direction === "in" ? "Destination VM" : "Source VM"}
                value="This VM"
                readOnly
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="block font-medium">Comment</span>
              <span className="text-xs text-muted-foreground">
                Optional comment, up to 120 characters.
              </span>
              <Input
                aria-label="Rule comment"
                placeholder="Allow HTTPS from the office network"
                maxLength={120}
                value={form.description}
                disabled={disabled}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={disabled} onClick={save}>
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
