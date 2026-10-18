import { useEffect, useState } from "react";
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
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import {
  DEFAULT_RELAY_PORT,
  parseRelayPort,
  relayEndpointLabel,
  relayPortError,
} from "@/lib/relay-port";
import type { DashboardRelayInstance } from "@/types";

/** The relay of the pool that already listens on this address and port, if any. */
function relayOnEndpoint(
  instances: DashboardRelayInstance[],
  relay: DashboardRelayInstance,
  port: number
): DashboardRelayInstance | undefined {
  return instances.find(
    (other) =>
      other.id !== relay.id &&
      other.servicePort === port &&
      other.advertisedAddresses.some((address) => relay.advertisedAddresses.includes(address))
  );
}

/** Moves a remote relay to another TCP port; daemons follow the endpoint it reports. */
export function RelayPortDialog({
  relay,
  instances,
  onOpenChange,
  onSubmit,
}: {
  /** The relay to move; the dialog is open while it is set. */
  relay: DashboardRelayInstance | null;
  instances: DashboardRelayInstance[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (relay: DashboardRelayInstance, port: number) => Promise<void>;
}) {
  const open = relay !== null;
  const shown = useRetainedDialogValue(relay, open);
  const [port, setPort] = useState(String(relay?.servicePort ?? DEFAULT_RELAY_PORT));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (relay) {
      setPort(String(relay.servicePort));
      setSubmitting(false);
    }
  }, [relay]);

  const parsed = parseRelayPort(port);
  const taken = shown && parsed !== null ? relayOnEndpoint(instances, shown, parsed) : undefined;
  const problem =
    relayPortError(port) ??
    (taken && shown
      ? `${taken.displayName} already listens on ${relayEndpointLabel(
          shown.advertisedAddresses[0] ?? "",
          parsed ?? DEFAULT_RELAY_PORT
        )}.`
      : null);
  const unchanged = parsed !== null && parsed === shown?.servicePort;
  const endpoints =
    shown?.advertisedAddresses
      .map((address) => relayEndpointLabel(address, shown.servicePort))
      .join(", ") ?? "";

  const submit = async () => {
    if (!relay || parsed === null || problem || unchanged) return;
    setSubmitting(true);
    try {
      await onSubmit(relay, parsed);
      onOpenChange(false);
    } catch {
      // The section's toast reports the failure; the dialog stays open with the typed port.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Relay Port</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {shown?.displayName} listens on {endpoints}. Opfield drains it, restarts it on the new
          port and returns it to the pool. Daemons reconnect to the new port by themselves; streams
          still open on the relay when it restarts are closed.
        </DialogDescription>
        <div className="space-y-1.5">
          <label htmlFor="relay-new-port" className="text-sm font-medium">
            Relay Port
          </label>
          <Input
            id="relay-new-port"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            inputMode="numeric"
            placeholder={String(DEFAULT_RELAY_PORT)}
            aria-invalid={!!problem}
            aria-describedby="relay-new-port-help"
            autoFocus
          />
          <p
            id="relay-new-port-help"
            className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
          >
            {problem ??
              "Open this TCP port on the relay host's firewall and port forward before you change it."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={submitting}
            disabled={parsed === null || !!problem || unchanged}
          >
            Change port
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
