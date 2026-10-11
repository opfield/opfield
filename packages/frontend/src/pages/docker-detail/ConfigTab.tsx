import { Check, ClipboardCopy } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import type { InspectData } from "./helpers";

export function ConfigTab({ data, editorHeight }: { data: InspectData; editorHeight?: string }) {
  const jsonText = useMemo(() => JSON.stringify(data, null, 2), [data]);

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonText).then(
      () => {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1000);
      },
      () => toast.error("Failed to copy")
    );
  };

  return (
    <PanelShell
      title="Container Inspect"
      description="Full container configuration (read-only)"
      className="flex flex-1 flex-col min-h-0"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <Button variant="ghost" size="icon" onClick={handleCopy} title="Copy JSON">
          <Check
            className={`h-3.5 w-3.5 absolute transition-all duration-200 ${copied ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
          />
          <ClipboardCopy
            className={`h-3.5 w-3.5 transition-all duration-200 ${copied ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
          />
        </Button>
      }
    >
      <CodeEditor
        value={jsonText}
        onChange={() => {}}
        readOnly
        language="json"
        height={editorHeight}
        bordered={false}
      />
    </PanelShell>
  );
}
