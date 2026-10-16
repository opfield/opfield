import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HostingFirewallDirection, HostingFirewallRule } from "@/types/hosting";

export interface NodeFirewallRulesPanelProps {
  direction: HostingFirewallDirection;
  rules: HostingFirewallRule[];
  editingLocked: boolean;
  onAdd: (direction: HostingFirewallDirection) => void;
  onEdit: (rule: HostingFirewallRule) => void;
  /**
   * Moves the rule one place among the rules of its direction, for a provider that checks the rules in order
   * (the first match wins). Without it the rules have no order and show no move buttons.
   */
  onMove?: (rule: HostingFirewallRule, delta: -1 | 1) => void;
  onDelete: (rule: HostingFirewallRule) => void;
}

export function NodeFirewallRulesPanel({
  direction,
  rules,
  editingLocked,
  onAdd,
  onEdit,
  onMove,
  onDelete,
}: NodeFirewallRulesPanelProps) {
  const inbound = direction === "in";
  const columns: SimpleTableColumn<HostingFirewallRule>[] = [
    {
      id: "action",
      header: "Action",
      render: (rule) => (
        <Badge variant={rule.action === "deny" ? "destructive" : "success"} size="inline">
          {rule.action}
        </Badge>
      ),
    },
    { id: "protocol", header: "Protocol", render: (rule) => rule.protocol.toUpperCase() },
    { id: "ports", header: "Ports", render: (rule) => rule.ports },
    {
      id: "addresses",
      header: inbound ? "Source addresses" : "Destination addresses",
      render: (rule) => <span className="break-words">{rule.addresses.join(", ")}</span>,
    },
    { id: "comment", header: "Comment", render: (rule) => rule.description || "—" },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      render: (rule) => {
        const index = rules.indexOf(rule);
        return (
          <div className="flex justify-end gap-1">
            {onMove ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${inbound ? "inbound" : "outbound"} firewall rule ${index + 1} up`}
                  disabled={editingLocked || index === 0}
                  onClick={() => onMove(rule, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${inbound ? "inbound" : "outbound"} firewall rule ${index + 1} down`}
                  disabled={editingLocked || index === rules.length - 1}
                  onClick={() => onMove(rule, 1)}
                >
                  <ArrowDown />
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Edit ${inbound ? "inbound" : "outbound"} firewall rule`}
              disabled={editingLocked}
              onClick={() => onEdit(rule)}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Delete ${inbound ? "inbound" : "outbound"} firewall rule`}
              disabled={editingLocked}
              onClick={() => onDelete(rule)}
            >
              <Trash2 />
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <PanelShell
      title={inbound ? "Inbound rules" : "Outbound rules"}
      description={`${onMove ? "Checked in order; the first matching rule wins. " : ""}Rules are retained when the firewall is disabled. The selected default policy applies when no rule matches.`}
      actions={
        <Button
          type="button"
          variant="outline"
          aria-label={`Add ${inbound ? "inbound" : "outbound"} firewall rule`}
          disabled={editingLocked}
          onClick={() => onAdd(direction)}
        >
          <Plus /> Add rule
        </Button>
      }
    >
      <SimpleTable
        columns={columns}
        rows={rules}
        getRowKey={(rule) => rule.id}
        emptyMessage={
          inbound
            ? "No inbound rules. The default inbound policy applies."
            : "No outbound rules. The default outbound policy applies."
        }
      />
    </PanelShell>
  );
}
