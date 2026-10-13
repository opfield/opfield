// Expiry and IP limits of API tokens, inference tokens and OAuth grants: the Expires select (presets
// and a custom date), the one-row Allowed addresses link with its own small dialog, and the
// expiry/address line of the token lists.
import { ArrowRight, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";

export const MAX_ALLOWED_ADDRESSES = 20;
/** A custom expiry must lie at least this far ahead. */
const MIN_CUSTOM_EXPIRY_MS = 15 * 60_000;

// ── Expiry ──────────────────────────────────────────────────────────────────

export type ExpiryPreset = "15m" | "1h" | "1d" | "1w" | "1mo" | "1y" | "never";

const EXPIRY_PRESETS: { value: ExpiryPreset; label: string }[] = [
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
  { value: "1mo", label: "1 month" },
  { value: "1y", label: "1 year" },
  { value: "never", label: "Never" },
];

/** The Expires field: a preset, or "custom" with a local date-time ("2026-11-27T14:05"). */
export interface ExpiryValue {
  choice: ExpiryPreset | "custom";
  custom: string;
}

function presetDate(preset: ExpiryPreset, from = new Date()): Date | null {
  const at = new Date(from);
  switch (preset) {
    case "15m":
      return new Date(at.getTime() + 15 * 60_000);
    case "1h":
      return new Date(at.getTime() + 3_600_000);
    case "1d":
      return new Date(at.getTime() + 86_400_000);
    case "1w":
      return new Date(at.getTime() + 7 * 86_400_000);
    case "1mo":
      at.setMonth(at.getMonth() + 1);
      return at;
    case "1y":
      at.setFullYear(at.getFullYear() + 1);
      return at;
    default:
      return null;
  }
}

/** "2026-11-27T14:05" for an `<input type="datetime-local">`. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A create dialog starts at 1 month. */
export function newTokenExpiry(): ExpiryValue {
  return { choice: "1mo", custom: toLocalInput(presetDate("1mo") ?? new Date()) };
}

/** An edit dialog starts at the token's current expiry, as a custom date, or Never. */
export function currentTokenExpiry(expiresAt: string | null | undefined): ExpiryValue {
  if (!expiresAt) return { choice: "never", custom: toLocalInput(presetDate("1mo") ?? new Date()) };
  return { choice: "custom", custom: toLocalInput(new Date(expiresAt)) };
}

export function sameExpiry(a: ExpiryValue, b: ExpiryValue): boolean {
  return a.choice === b.choice && (a.choice !== "custom" || a.custom === b.custom);
}

/** The moment the field stands for now (null: never; undefined: no valid custom date). */
export function resolveExpiry(value: ExpiryValue, now = new Date()): Date | null | undefined {
  if (value.choice !== "custom") return presetDate(value.choice, now);
  const at = value.custom ? new Date(value.custom) : null;
  return at && !Number.isNaN(at.getTime()) ? at : undefined;
}

/** Why the field cannot be saved, or null. */
export function expiryError(value: ExpiryValue, now = Date.now()): string | null {
  if (value.choice !== "custom") return null;
  const at = resolveExpiry(value);
  if (!at) return "Pick a date and time.";
  if (at.getTime() <= now + MIN_CUSTOM_EXPIRY_MS) return "Pick a moment at least 15 minutes ahead.";
  return null;
}

/** The ISO moment to send (null: no expiry). Call only when expiryError is null. */
export function expiryRequestValue(value: ExpiryValue): string | null {
  return resolveExpiry(value)?.toISOString() ?? null;
}

/** "in 6 days", "in 5 hours", "in 11 months": the time left until a future moment. */
function timeLeft(date: Date, now = new Date()): string {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  const plural = (count: number, unit: string) => `in ${count} ${unit}${count === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(Math.max(1, minutes), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 60) return plural(days, "day");
  const months = Math.round(days / 30.4);
  if (months < 12) return plural(months, "month");
  return plural(Math.round(days / 365), "year");
}

const DATE_INPUT_CLASS =
  "[&::-webkit-calendar-picker-indicator]:pointer-events-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none";

/**
 * Expires: one Select with the presets and "Custom date…", which shows a date-time field next
 * to it. `showError` turns the custom-date check on (an edit dialog checks only a changed expiry).
 */
export function ExpiryField({
  value,
  onChange,
  showError = true,
}: {
  value: ExpiryValue;
  onChange: (value: ExpiryValue) => void;
  showError?: boolean;
}) {
  const id = useId();
  const error = showError ? expiryError(value) : null;
  const at = resolveExpiry(value);
  const custom = value.choice === "custom";
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={`${id}-expiry`}>
        Expires
      </label>
      {/* The preset keeps its own width (at most half); the date field gets the rest. */}
      <div
        className={custom ? "grid gap-2 sm:grid-cols-[fit-content(50%)_minmax(0,1fr)]" : undefined}
      >
        <Select
          value={value.choice}
          onValueChange={(next) => onChange({ ...value, choice: next as ExpiryValue["choice"] })}
        >
          <SelectTrigger id={`${id}-expiry`} aria-label="Expires">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY_PRESETS.map((preset) => (
              <SelectItem key={preset.value} value={preset.value}>
                {preset.label}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value="custom">Custom date…</SelectItem>
          </SelectContent>
        </Select>
        {custom ? (
          <Input
            type="datetime-local"
            value={value.custom}
            onChange={(event) => onChange({ ...value, custom: event.target.value })}
            aria-label="Expiry date and time"
            aria-invalid={Boolean(error)}
            className={error ? `border-destructive ${DATE_INPUT_CLASS}` : DATE_INPUT_CLASS}
          />
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {!at
            ? "The token works until you revoke it."
            : at.getTime() <= Date.now()
              ? `Expired ${formatDateTime(at)}.`
              : `Expires ${formatDateTime(at)}, ${timeLeft(at)}.`}
        </p>
      )}
    </div>
  );
}

// ── Allowed addresses ─────────────────────────────────────────────────────────

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv6(value: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(":")) return false;
  const doubles = value.split("::").length - 1;
  if (doubles > 1) return false;
  const groups = value.split(":").filter((group) => group !== "");
  if (groups.some((group) => group.length > 4)) return false;
  return doubles === 1 ? groups.length < 8 : groups.length === 8;
}

type ParsedAddress = { kind: "v4" | "v6"; prefix: number | null };

/** An IPv4/IPv6 address or CIDR range, or null. */
function parseAddress(input: string): ParsedAddress | null {
  const [address, prefixText, extra] = input.trim().split("/");
  if (extra !== undefined || !address) return null;
  const kind = IPV4.test(address) ? "v4" : isIpv6(address) ? "v6" : null;
  if (!kind) return null;
  if (prefixText === undefined) return { kind, prefix: null };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (kind === "v4" ? 32 : 128)) return null;
  return { kind, prefix };
}

/** "Single address", "65,536 addresses", "IPv6 /48 range". */
function addressSize(input: string): string {
  const parsed = parseAddress(input);
  if (!parsed) return "";
  if (parsed.prefix === null || parsed.prefix === (parsed.kind === "v4" ? 32 : 128)) {
    return parsed.kind === "v4" ? "Single address" : "Single IPv6 address";
  }
  if (parsed.kind === "v6") return `IPv6 /${parsed.prefix} range`;
  return `${(2 ** (32 - parsed.prefix)).toLocaleString("en-US")} addresses`;
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** "Any address", "3 allowed addresses". */
export function addressSummary(values: readonly string[]): string {
  if (values.length === 0) return "Any address";
  return `${values.length} allowed address${values.length === 1 ? "" : "es"}`;
}

export function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => sameAddress(value, b[index] ?? ""));
}

// The address Opfield sees for this browser, asked once per page load.
let clientAddress: Promise<string | null> | null = null;

function useClientAddress(enabled: boolean): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    clientAddress ??= api
      .getTokenClientAddress()
      .then((result) => result.ipAddress)
      .catch(() => {
        clientAddress = null;
        return null;
      });
    let cancelled = false;
    void clientAddress.then((value) => {
      if (!cancelled) setAddress(value);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return address;
}

function CountedLabel({ children, count }: { children: ReactNode; count: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium">{children}</span>
      <span
        className={
          count > MAX_ALLOWED_ADDRESSES
            ? "text-xs tabular-nums text-destructive"
            : "text-xs tabular-nums text-muted-foreground"
        }
      >
        {count} / {MAX_ALLOWED_ADDRESSES}
      </span>
    </div>
  );
}

/** The address editor: a field with Add (Enter too), removable rows, Add my current IP. */
function AddressListEditor({
  values,
  onChange,
  myAddress,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  myAddress: string | null;
}) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const draftError = !trimmed
    ? null
    : !parseAddress(trimmed)
      ? "Not an IP address or CIDR range."
      : values.some((value) => sameAddress(value, trimmed))
        ? "Already in the list."
        : values.length >= MAX_ALLOWED_ADDRESSES
          ? `Up to ${MAX_ALLOWED_ADDRESSES} addresses.`
          : null;
  const hasMine = myAddress ? values.some((value) => sameAddress(value, myAddress)) : true;

  const add = () => {
    if (!trimmed || draftError) return;
    onChange([...values, trimmed]);
    setDraft("");
  };

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="203.0.113.10 or 10.0.0.0/8"
          spellCheck={false}
          aria-label="IP address or CIDR range"
          aria-invalid={Boolean(draftError)}
          className={draftError ? "border-destructive font-mono" : "font-mono"}
        />
        <Button variant="outline" onClick={add} disabled={!trimmed || Boolean(draftError)}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>
      {draftError ? <p className="text-xs text-destructive">{draftError}</p> : null}
      {values.length > 0 ? (
        <div className="divide-y divide-border border border-border">
          {values.map((value) => (
            <div key={value} className="flex items-center justify-between gap-3 py-1 pl-3 pr-1">
              <span className="min-w-0 truncate font-mono text-sm">{value}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {myAddress && sameAddress(value, myAddress)
                    ? "Your current IP"
                    : addressSize(value)}
                </span>
                {/* size-exception: remove button inside a compact address row */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${value}`}
                  onClick={() => onChange(values.filter((item) => item !== value))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No addresses: the token works from any address.
        </p>
      )}
      {hasMine || !myAddress || values.length >= MAX_ALLOWED_ADDRESSES ? null : (
        <Button
          variant="link"
          className="h-auto p-0"
          onClick={() => onChange([...values, myAddress])}
        >
          Add my current IP ({myAddress})
        </Button>
      )}
    </div>
  );
}

/** The address editor in its own small dialog over the token dialog; Cancel drops the edits. */
function AllowedAddressesDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string[];
  onSave: (values: string[]) => void;
}) {
  const [values, setValues] = useState(initial);
  const myAddress = useClientAddress(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Allowed Addresses</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Requests from other addresses are refused. Empty allows any address.
          </p>
          <div className="space-y-1.5">
            <CountedLabel count={values.length}>IP addresses or CIDR ranges</CountedLabel>
            <AddressListEditor values={values} onChange={setValues} myAddress={myAddress} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(values);
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One compact row in a token dialog: the current limit and a link that opens the editor. */
export function AllowedAddressesRow({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // A fresh editor per opening: Cancel drops what was typed.
  const [session, setSession] = useState(0);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-sm">
        <span className="font-medium">Allowed addresses</span>
        <span className="text-muted-foreground"> · {addressSummary(value)}</span>
      </p>
      <Button
        variant="link"
        className="h-auto p-0"
        onClick={() => {
          setSession((current) => current + 1);
          setOpen(true);
        }}
      >
        {value.length === 0 ? "Restrict by IP" : "Edit addresses"} <ArrowRight />
      </Button>
      <AllowedAddressesDialog
        key={session}
        open={open}
        onOpenChange={setOpen}
        initial={value}
        onSave={onChange}
      />
    </div>
  );
}

// ── Token lists ───────────────────────────────────────────────────────────────

export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return Boolean(expiresAt) && new Date(expiresAt!).getTime() <= now;
}

/**
 * The end of a token row's meta line: " · Expires in 6 days · Any address". "Expired" is
 * coloured, in the line's own size. OAuth rows pass `withExpiry={false}` (they show theirs).
 */
export function TokenLimitsMeta({
  expiresAt,
  allowedIps,
  withExpiry = true,
}: {
  expiresAt?: string | null;
  allowedIps?: readonly string[];
  withExpiry?: boolean;
}) {
  const expired = isExpired(expiresAt);
  const expiry = !expiresAt
    ? "No expiry"
    : expired
      ? "Expired"
      : `Expires ${timeLeft(new Date(expiresAt))}`;
  return (
    <>
      {" · "}
      {withExpiry ? (
        <>
          <span
            className={expired ? "text-destructive" : undefined}
            title={expiresAt ? formatDate(expiresAt) : undefined}
          >
            {expiry}
          </span>
          {" · "}
        </>
      ) : null}
      {addressSummary(allowedIps ?? [])}
    </>
  );
}
