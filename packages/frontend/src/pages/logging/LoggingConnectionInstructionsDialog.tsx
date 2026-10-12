import { useEffect, useState } from "react";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ConnectionMethod = "sdk" | "api";

export function LoggingConnectionInstructionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [method, setMethod] = useState<ConnectionMethod>("sdk");

  useEffect(() => {
    if (open) setMethod("sdk");
  }, [open]);

  const gatewayUrl = window.location.origin;
  const sdkExample = `import { GatewayLogger } from "@sqgateway/logger";

const logger = new GatewayLogger({
  endpoint: "${gatewayUrl}",
  token: process.env.GATEWAY_LOGGING_TOKEN!,
  service: "my-service",
  source: "application",
});

logger.info("Service started");
await logger.flush();`;
  const apiExample = `curl -X POST '${gatewayUrl}/api/logging/ingest' \\
  -H 'Authorization: Bearer <ingest-token>' \\
  -H 'Content-Type: application/json' \\
  --data '{
    "severity": "info",
    "message": "Service started",
    "service": "my-service",
    "source": "application",
    "labels": { "environment": "production" },
    "fields": { "version": "1.0.0" }
  }'`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent clipOverflow className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect to This Environment</DialogTitle>
          <DialogDescription>
            Create an ingest token in the Tokens tab, store it as a server-side secret, then send
            logs with the SDK or ingest API.
          </DialogDescription>
        </DialogHeader>

        <AnimatedHeight>
          <Tabs value={method} onValueChange={(value) => setMethod(value as ConnectionMethod)}>
            <TabsList>
              <TabsTrigger value="sdk">SDK</TabsTrigger>
              <TabsTrigger value="api">API</TabsTrigger>
            </TabsList>

            <TabsContent value="sdk" className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Install</p>
                <CopyCodeBlock
                  label="Install the Node.js SDK"
                  value="pnpm add @sqgateway/logger"
                  className="[&>p]:hidden"
                  codeClassName="min-h-0"
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Send a log</p>
                <CopyCodeBlock label="SDK example" value={sdkExample} className="[&>p]:hidden" />
              </div>
            </TabsContent>

            <TabsContent value="api" className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Send one event</p>
                <p className="text-sm text-muted-foreground">
                  Use the environment ingest token as a Bearer token. Batch ingestion is available
                  at <span className="font-mono">/api/logging/ingest/batch</span>.
                </p>
                <CopyCodeBlock
                  label="Ingest API example"
                  value={apiExample}
                  className="[&>p]:hidden"
                />
              </div>
            </TabsContent>
          </Tabs>
        </AnimatedHeight>
      </DialogContent>
    </Dialog>
  );
}
