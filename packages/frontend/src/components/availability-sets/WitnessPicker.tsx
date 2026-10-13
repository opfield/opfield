import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AvailabilityWitnessChoice, AvailabilityWitnessPick } from "@/types";

/** "auto", "relay:<id>" or "node:<id>". */
export type WitnessPickerValue = string;

export function witnessChoiceOf(value: WitnessPickerValue): AvailabilityWitnessChoice | null {
  if (value.startsWith("relay:")) return { relayIds: [value.slice("relay:".length)] };
  if (value.startsWith("node:")) return { nodeId: value.slice("node:".length) };
  return null;
}

/**
 * Witness of an availability set: Opfield's automatic pick, or one allowed relay or docker node
 * on another host. A witness only votes on which server is primary; it holds no data.
 */
export function WitnessPicker({
  value,
  onChange,
  candidates,
  disabled,
  id,
}: {
  value: WitnessPickerValue;
  onChange: (value: WitnessPickerValue) => void;
  candidates: AvailabilityWitnessPick[];
  disabled?: boolean;
  id?: string;
}) {
  const relays = candidates.filter((candidate) => candidate.kind === "relay");
  const nodes = candidates.filter((candidate) => candidate.kind === "node");
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label="Witness">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          value="auto"
          description="Allowed relays first, then docker nodes on other hosts."
        >
          Automatic
        </SelectItem>
        {relays.map((relay) => (
          <SelectItem key={relay.id} value={`relay:${relay.id}`} description="Relay">
            {relay.name}
          </SelectItem>
        ))}
        {nodes.map((node) => (
          <SelectItem key={node.id} value={`node:${node.id}`} description="Docker node">
            {node.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
