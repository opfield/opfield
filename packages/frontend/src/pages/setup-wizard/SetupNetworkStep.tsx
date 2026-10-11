import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  deriveGrpcPublicTarget,
  isNetworkDraftValid,
  type NetworkDraft,
} from "./setup-wizard-model";

function grpcTargetForIp(ip: string): string {
  return `${ip.includes(":") ? `[${ip}]` : ip}:9443`;
}

function detectedOption(value: string, label: string): ComboboxOption {
  return { value, label, keywords: `detected automatic ${value}` };
}

function renderDetectedOption(option: ComboboxOption) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-mono text-xs">{option.value}</span>
      <span className="block text-xs text-muted-foreground">{option.label}</span>
    </span>
  );
}

export function SetupNetworkStep({
  busy,
  network,
  publicUrl,
  suggestions,
  setNetwork,
  onBack,
  onContinue,
}: {
  busy: boolean;
  network: NetworkDraft;
  publicUrl: string;
  suggestions: { publicIps: string[]; localIps: string[] };
  setNetwork: (value: NetworkDraft) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const grpcPublicOptions = useMemo(() => {
    const values = [
      deriveGrpcPublicTarget(publicUrl),
      ...suggestions.publicIps.map(grpcTargetForIp),
    ].filter(Boolean);
    return [...new Set(values)].map((value) =>
      detectedOption(value, "Suggested public gRPC target")
    );
  }, [publicUrl, suggestions.publicIps]);
  const grpcLocalOptions = useMemo(
    () => suggestions.localIps.map((value) => detectedOption(value, "Detected local address")),
    [suggestions.localIps]
  );
  const canContinue = isNetworkDraftValid(network);

  return (
    <section className="space-y-3">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canContinue) onContinue();
        }}
      >
        <PanelShell
          title="Opfield network"
          description="Choose the public and optional local targets used for node enrollment. Detected values can be replaced."
        >
          <SettingsControlRow
            title="gRPC public target"
            description="Public host or IP included in node enrollment commands."
          >
            <Combobox
              freeText
              showAllOptionsOnFocus
              ariaLabel="gRPC public target"
              value={network.grpcPublicTarget}
              options={grpcPublicOptions}
              placeholder="opfield.example.com:9443"
              searchPlaceholder="Enter or select a public target"
              emptyMessage="Enter a hostname or IP address."
              disabled={busy}
              inputClassName="font-mono text-xs"
              renderOption={renderDetectedOption}
              onValueChange={(grpcPublicTarget) => setNetwork({ ...network, grpcPublicTarget })}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="gRPC local IP"
            description="Optional private address used by nodes on the same network."
          >
            <Combobox
              freeText
              showAllOptionsOnFocus
              ariaLabel="gRPC local IP"
              value={network.grpcLocalIp}
              options={grpcLocalOptions}
              placeholder="Uses public target when empty"
              searchPlaceholder="Enter or select a local IP"
              emptyMessage="Enter a private IPv4 or IPv6 address."
              disabled={busy}
              inputClassName="font-mono text-xs"
              renderOption={renderDetectedOption}
              onValueChange={(grpcLocalIp) => setNetwork({ ...network, grpcLocalIp })}
            />
          </SettingsControlRow>
        </PanelShell>
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-max flex-none"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button type="submit" className="w-max flex-none" pending={busy} disabled={!canContinue}>
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}
