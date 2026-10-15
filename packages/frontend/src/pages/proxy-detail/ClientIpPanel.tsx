import { Save, Waypoints } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { ClientIpOptions, ClientIpSource, ProxyHost } from "@/types";

interface ClientIpDraft {
  source: ClientIpSource;
  proxies: string;
  header: ClientIpOptions["header"];
}

const SOURCE_LABELS: Record<Exclude<ClientIpSource, "auto">, string> = {
  direct: "Direct connection",
  cloudflare: "Cloudflare",
  reverse_proxy: "Trusted proxies",
};

function draftFromHost(host: ProxyHost): ClientIpDraft {
  return {
    source: host.clientIpSource ?? "auto",
    proxies: (host.clientIpOptions?.trustedProxyCidrs ?? []).join(", "),
    header: host.clientIpOptions?.header ?? "x_forwarded_for",
  };
}

function proxyList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function draftKey(draft: ClientIpDraft): string {
  return draft.source === "reverse_proxy"
    ? JSON.stringify([draft.source, proxyList(draft.proxies), draft.header])
    : draft.source;
}

/** Route setting: where nginx takes the client IP from (access lists, rate limits, logs, upstream headers). */
export function ClientIpPanel({
  host,
  canManage,
  onUpdated,
}: {
  host: ProxyHost;
  canManage: boolean;
  onUpdated: (host: ProxyHost) => void;
}) {
  const persisted = useMemo(() => ({ hostId: host.id, draft: draftFromHost(host) }), [host]);
  const [draft, setDraft] = useState(persisted.draft);
  const [saving, setSaving] = useState(false);
  const lastPersisted = useRef(persisted);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;

  // A refreshed route replaces the draft unless it holds unsaved edits of the same route.
  useEffect(() => {
    const previous = lastPersisted.current;
    lastPersisted.current = persisted;
    if (
      persisted.hostId !== previous.hostId ||
      draftKey(currentDraft.current) === draftKey(previous.draft)
    ) {
      setDraft(persisted.draft);
    }
  }, [persisted]);

  const changed = draftKey(draft) !== draftKey(persisted.draft);
  const valid = draft.source !== "reverse_proxy" || proxyList(draft.proxies).length > 0;
  const effective = host.clientIpEffectiveSource;
  const autoDescription =
    draft.source === "auto" && persisted.draft.source === "auto" && effective
      ? `Auto uses Cloudflare when a domain of this route is proxied by Cloudflare. Now: ${SOURCE_LABELS[effective]}`
      : "Auto uses Cloudflare when a domain of this route is proxied by Cloudflare";

  const save = async () => {
    if (!canManage || !changed || !valid) return;
    setSaving(true);
    try {
      const updated = await api.updateProxyHost(host.id, {
        clientIpSource: draft.source,
        ...(draft.source === "reverse_proxy"
          ? {
              clientIpOptions: {
                trustedProxyCidrs: proxyList(draft.proxies),
                header: draft.header,
              },
            }
          : {}),
      });
      onUpdated(updated);
      toast.success("Client IP source updated");
    } catch (error) {
      toastApiError(error, "Failed to update client IP source");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelShell
      icon={<Waypoints className="h-4 w-4" />}
      title="Client IP"
      description="Where the visitor address comes from behind Cloudflare or a proxy"
      className="overflow-visible"
      dirty={changed}
      actions={
        canManage ? (
          <Button onClick={save} disabled={!changed || !valid} pending={saving}>
            <Save />
            Save
          </Button>
        ) : null
      }
      wrapHeader
    >
      <SettingsControlRow
        title="Source"
        description={autoDescription}
        help="Access list IP rules, rate limits, access logs and the X-Real-IP / X-Forwarded-For sent to the upstream use this address. Forwarded addresses are believed only from Cloudflare's edge or the proxies you list; a visitor that connects directly keeps its own address. Raw configs get it where they contain the line # opfield:client-ip."
      >
        <Select
          value={draft.source}
          onValueChange={(value) =>
            setDraft((current) => ({ ...current, source: value as ClientIpSource }))
          }
          disabled={!canManage || saving}
        >
          <SelectTrigger className="w-full font-sans sm:w-72" aria-label="Client IP source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="font-sans">
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="direct">{SOURCE_LABELS.direct}</SelectItem>
            <SelectItem value="cloudflare">{SOURCE_LABELS.cloudflare}</SelectItem>
            <SelectItem value="reverse_proxy">{SOURCE_LABELS.reverse_proxy}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsControlRow>
      {draft.source === "reverse_proxy" ? (
        <>
          <SettingsControlRow
            title="Trusted proxies"
            description="Proxy addresses or CIDRs, separated by commas"
            help="Only connections from these addresses may name the client. List the load balancer or proxy that connects to this ingress node."
          >
            <Input
              value={draft.proxies}
              onChange={(event) =>
                setDraft((current) => ({ ...current, proxies: event.target.value }))
              }
              placeholder="10.0.0.0/8, 192.0.2.10"
              className="w-full sm:w-72"
              disabled={!canManage || saving}
              aria-label="Trusted proxies"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Header"
            description="Header the trusted proxies set"
            help="X-Forwarded-For takes the right-most address that is not a trusted proxy. X-Real-IP takes the single address the proxy sets."
          >
            <Select
              value={draft.header}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, header: value as ClientIpOptions["header"] }))
              }
              disabled={!canManage || saving}
            >
              <SelectTrigger className="w-full font-sans sm:w-72" aria-label="Client IP header">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="font-sans">
                <SelectItem value="x_forwarded_for">X-Forwarded-For</SelectItem>
                <SelectItem value="x_real_ip">X-Real-IP</SelectItem>
              </SelectContent>
            </Select>
          </SettingsControlRow>
        </>
      ) : null}
    </PanelShell>
  );
}
