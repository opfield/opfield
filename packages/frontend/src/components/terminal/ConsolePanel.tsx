import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { TerminalConsole } from "./TerminalConsole";

interface ConsolePanelProps {
  title: string;
  description: string;
  wsFactory: () => WebSocket;
  channelKey: string;
  popoutUrl: string;
  connectLabel?: string;
  headerActions?: ReactNode;
  onContainerUnavailable?: () => void;
}

export function ConsolePanel({
  title,
  description,
  wsFactory,
  channelKey,
  popoutUrl,
  connectLabel,
  headerActions,
  onContainerUnavailable,
}: ConsolePanelProps) {
  const openPopout = () => {
    window.open(popoutUrl, `console-${channelKey}`, "width=900,height=600,menubar=no,toolbar=no");
  };

  return (
    <PanelShell
      title={title}
      description={description}
      className="flex min-h-0 flex-1 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={openPopout}
            title="Pop out"
            aria-label="Pop out console"
          >
            <ExternalLink />
          </Button>
          {headerActions}
        </>
      }
    >
      <TerminalConsole
        wsFactory={wsFactory}
        channelKey={channelKey}
        connectLabel={connectLabel}
        onContainerUnavailable={onContainerUnavailable}
      />
    </PanelShell>
  );
}
