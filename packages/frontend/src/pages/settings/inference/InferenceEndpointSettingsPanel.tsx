import { useState } from "react";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { CopyValueField } from "@/components/common/CopyValueField";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const CLI_COMMAND = "npx -y @sqgateway/inference@latest";

export function InferenceEndpointRow() {
  const gatewayUrl = window.location.origin;
  const baseUrl = `${gatewayUrl}/api/inference/v1`;

  return (
    <SettingsControlRow
      title="Base URL"
      description="Root URL for the OpenAI-compatible inference API used by clients."
      help="Use this address as the provider base URL in OpenAI-compatible clients. Authentication still uses a Gateway inference API token."
    >
      <CopyValueField label="Base URL" showLabel={false} value={baseUrl} className="w-full" />
    </SettingsControlRow>
  );
}

export function InferenceEndpointSettingsPanel() {
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const gatewayUrl = window.location.origin;
  const baseUrl = `${gatewayUrl}/api/inference/v1`;

  return (
    <>
      <PanelShell>
        <SettingsControlRow
          title="Inference endpoints"
          description={
            <>
              Connect OpenAI-compatible tools directly, or use the companion CLI for Codex and
              Claude Code.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => setInstructionsOpen(true)}
              >
                Set up a harness
              </button>
            </>
          }
        >
          <CopyValueField label="Base URL" showLabel={false} value={baseUrl} className="w-full" />
        </SettingsControlRow>
      </PanelShell>
      <InferenceHarnessDialog open={instructionsOpen} onOpenChange={setInstructionsOpen} />
    </>
  );
}

export function InferenceHarnessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const gatewayUrl = window.location.origin;
  const interactiveSetupCopyCommand = `${CLI_COMMAND} --url ${gatewayUrl}`;
  const codexSetupCommand = `${CLI_COMMAND} setup codex`;
  const codexSetupCopyCommand = `${codexSetupCommand} --url ${gatewayUrl}`;
  const claudeCodeSetupCommand = `${CLI_COMMAND} setup claude-code`;
  const claudeCodeSetupCopyCommand = `${claudeCodeSetupCommand} --url ${gatewayUrl}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Set Up an Inference Harness</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Run the companion CLI on the device where the harness is installed.
        </DialogDescription>

        <div className="space-y-4">
          <CopyCodeBlock
            label="Interactive setup"
            value={CLI_COMMAND}
            copyValue={interactiveSetupCopyCommand}
            codeClassName="min-h-0"
          />

          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">Codex</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Configures Codex CLI and Desktop through a managed local proxy and Gateway model
                catalog.
              </p>
            </div>
            <CopyCodeBlock
              label="Direct Codex setup"
              value={codexSetupCommand}
              copyValue={codexSetupCopyCommand}
              codeClassName="min-h-0"
            />
            <div className="border border-border p-3">
              <p className="text-sm font-medium">Codex Desktop requires extra setup</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Sign in to an OpenAI account through Codex’s normal login flow first. Codex Desktop
                does not show custom model catalogs without that account session. After Gateway
                setup or login changes, fully quit and reopen Codex so it reloads the catalog.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">Claude Code</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Requires Claude Code 2.1.129 or newer and configures its native Anthropic gateway
                connection.
              </p>
            </div>
            <CopyCodeBlock
              label="Direct Claude Code setup"
              value={claudeCodeSetupCommand}
              copyValue={claudeCodeSetupCopyCommand}
              codeClassName="min-h-0"
            />
            <div className="border border-border p-3">
              <p className="text-sm font-medium">Claude Code CLI only</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Claude Desktop and the Claude Code VS Code extension use separate configuration
                surfaces and are not modified automatically.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
