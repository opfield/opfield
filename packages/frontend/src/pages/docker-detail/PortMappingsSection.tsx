import { Minus, Plus } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_DOCKER_PORT_BIND_ADDRESS_OPTIONS,
  type DockerPortBindAddressOption,
} from "@/lib/docker-port-bindings";

export interface PortMapping {
  hostIp?: string;
  hostPort: string;
  containerPort: string;
  protocol: "tcp" | "udp";
}

interface PortMappingsSectionProps {
  canEdit: boolean;
  ports: PortMapping[];
  setPorts: React.Dispatch<React.SetStateAction<PortMapping[]>>;
  portsChanged: boolean;
  inputCell: string;
  bindAddressOptions?: DockerPortBindAddressOption[];
  showBindAddress?: boolean;
  showProtocol?: boolean;
}

export function PortMappingsSection({
  canEdit,
  ports,
  setPorts,
  portsChanged,
  inputCell,
  bindAddressOptions = DEFAULT_DOCKER_PORT_BIND_ADDRESS_OPTIONS,
  showBindAddress = true,
  showProtocol = true,
}: PortMappingsSectionProps) {
  const addPort = () =>
    setPorts((p) => [
      ...p,
      { hostIp: "0.0.0.0", hostPort: "", containerPort: "", protocol: "tcp" },
    ]);
  const removePort = (i: number) => setPorts((p) => p.filter((_, idx) => idx !== i));
  const updatePort = (i: number, field: keyof PortMapping, val: string) =>
    setPorts((p) => p.map((entry, idx) => (idx === i ? { ...entry, [field]: val } : entry)));
  const gridColumns = showBindAddress
    ? showProtocol
      ? canEdit
        ? "grid-cols-[minmax(190px,1.4fr)_1fr_1fr_100px_36px]"
        : "grid-cols-[minmax(190px,1.4fr)_1fr_1fr_100px]"
      : canEdit
        ? "grid-cols-[minmax(190px,1.4fr)_1fr_1fr_36px]"
        : "grid-cols-[minmax(190px,1.4fr)_1fr_1fr]"
    : showProtocol
      ? canEdit
        ? "grid-cols-[1fr_1fr_100px_36px]"
        : "grid-cols-[1fr_1fr_100px]"
      : canEdit
        ? "grid-cols-[1fr_1fr_36px]"
        : "grid-cols-[1fr_1fr]";

  return (
    <PanelShell
      title={
        <SettingsHelpTitle
          label="Port Mappings"
          help="Publishes a container port on the Docker node. Host Port is reached by clients; Container Port is where the application listens inside the container."
        />
      }
      description="Requires container recreation"
      dirty={portsChanged}
      actions={
        canEdit ? (
          <Button onClick={addPort}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        ) : null
      }
    >
      {ports.length > 0 ? (
        <>
          <div
            className={`grid ${gridColumns} border-b border-border bg-header text-xs font-medium text-muted-foreground uppercase tracking-wider`}
          >
            {showBindAddress && <div className="px-3 py-2">Publish On</div>}
            <div className={showBindAddress ? "px-3 py-2 border-l border-border" : "px-3 py-2"}>
              Host Port
            </div>
            <div className="px-3 py-2 border-l border-border">Container Port</div>
            {showProtocol && <div className="px-3 py-2 border-l border-border">Protocol</div>}
            {canEdit && <div />}
          </div>
          <div>
            {ports.map((p, i) => (
              <div key={i} className={`grid ${gridColumns} border-b border-border last:border-b-0`}>
                {showBindAddress && (
                  <Select
                    value={p.hostIp || "0.0.0.0"}
                    onValueChange={(v) => updatePort(i, "hostIp", v)}
                    disabled={!canEdit}
                  >
                    <SelectTrigger className="h-9 border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(bindAddressOptions.some(
                        (option) => option.value === (p.hostIp || "0.0.0.0")
                      )
                        ? bindAddressOptions
                        : [
                            ...bindAddressOptions,
                            {
                              value: p.hostIp || "0.0.0.0",
                              label: `Current (${p.hostIp || "0.0.0.0"})`,
                            },
                          ]
                      ).map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <div className={showBindAddress ? "border-l border-border" : undefined}>
                  <Input
                    type="number"
                    className={inputCell}
                    value={p.hostPort}
                    onChange={(e) => updatePort(i, "hostPort", e.target.value)}
                    placeholder="8080"
                    disabled={!canEdit}
                  />
                </div>
                <div className="border-l border-border">
                  <Input
                    type="number"
                    className={inputCell}
                    value={p.containerPort}
                    onChange={(e) => updatePort(i, "containerPort", e.target.value)}
                    placeholder="80"
                    disabled={!canEdit}
                  />
                </div>
                {showProtocol && (
                  <div className="border-l border-border">
                    <Select
                      value={p.protocol}
                      onValueChange={(v) => updatePort(i, "protocol", v)}
                      disabled={!canEdit}
                    >
                      <SelectTrigger className="h-9 border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">TCP</SelectItem>
                        <SelectItem value="udp">UDP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove port"
                    title="Remove port"
                    className="shrink-0 rounded-none border-l border-border"
                    onClick={() => removePort(i)}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyState message="No port mappings" embedded />
      )}
    </PanelShell>
  );
}
