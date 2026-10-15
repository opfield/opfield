import { useEffect, useMemo, useState } from "react";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { Notice } from "@/components/common/Notice";
import { api } from "@/services/api";
import type { MissingRouteDomain } from "@/types";

const LOOKUP_DELAY_MS = 400;
const HOSTNAME = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * The hostnames of a route about to be created that no registered domain covers, with what Create
 * would do for each (POST /proxy-hosts/missing-domains). Empty while nothing is missing or unknown.
 */
export function useMissingRouteDomains({
  enabled,
  domainNames,
  folderId,
  nodeId,
  ingressGroupId,
}: {
  enabled: boolean;
  domainNames: readonly string[];
  folderId: string | null;
  nodeId: string;
  ingressGroupId: string;
}): MissingRouteDomain[] {
  const [entries, setEntries] = useState<MissingRouteDomain[]>([]);
  const names = useMemo(
    () =>
      [...new Set(domainNames.map((name) => name.trim().toLowerCase()))].filter((name) =>
        HOSTNAME.test(name)
      ),
    [domainNames]
  );
  const key = names.join(",");

  useEffect(() => {
    if (!enabled || key === "") {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .listMissingRouteDomains({
          domainNames: key.split(","),
          ...(folderId ? { folderId } : {}),
          ...(ingressGroupId ? { ingressGroupId } : nodeId ? { nodeId } : {}),
        })
        .then((result) => {
          if (!cancelled) setEntries(result);
        })
        .catch(() => {
          if (!cancelled) setEntries([]);
        });
    }, LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, folderId, ingressGroupId, key, nodeId]);

  return entries;
}

function entryText(entry: MissingRouteDomain): string {
  return entry.status === "create"
    ? `Domain not registered. It will be created in Cloudflare zone ${entry.zoneName}`
    : `Domain not registered. ${entry.reason ?? "It cannot be created here"}`;
}

/** Per missing hostname what happens, and one option to create the creatable ones with the route. */
export function MissingRouteDomainsField({
  entries,
  checked,
  onCheckedChange,
}: {
  entries: readonly MissingRouteDomain[];
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  if (entries.length === 0) return null;
  const list = (
    // Inside the option's label: lines of phrasing content, no list elements.
    <span className="block space-y-0.5">
      {entries.map((entry) => (
        <span key={entry.hostname} className="block">
          <span className="font-medium text-foreground">{entry.hostname}</span>: {entryText(entry)}
        </span>
      ))}
    </span>
  );
  if (!entries.some((entry) => entry.status === "create")) {
    return (
      <Notice tone="warning" title="Domains not registered">
        {list}
      </Notice>
    );
  }
  return (
    <CheckboxCard
      checked={checked}
      onCheckedChange={onCheckedChange}
      label="Create missing domains"
      description={list}
    />
  );
}
