import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SESSION_LENGTHS, sessionLengthLabel } from "./access-options";

const DEFAULT_VALUE = "default";

/**
 * How long a visitor stays signed in. With `defaultLabel` the first item is the installation
 * default (value null); a length set outside the presets keeps an item of its own.
 */
export function SessionSelect({
  id,
  value,
  onChange,
  defaultLabel,
}: {
  id?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  defaultLabel?: string;
}) {
  const custom =
    value !== null && !SESSION_LENGTHS.some((length) => length.seconds === value) ? value : null;
  return (
    <Select
      value={value === null ? DEFAULT_VALUE : String(value)}
      onValueChange={(next) => onChange(next === DEFAULT_VALUE ? null : Number(next))}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {defaultLabel !== undefined ? (
          <SelectItem value={DEFAULT_VALUE}>{defaultLabel}</SelectItem>
        ) : null}
        {SESSION_LENGTHS.map((length) => (
          <SelectItem key={length.seconds} value={String(length.seconds)}>
            {length.label}
          </SelectItem>
        ))}
        {custom !== null ? (
          <SelectItem value={String(custom)}>{sessionLengthLabel(custom)}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}
