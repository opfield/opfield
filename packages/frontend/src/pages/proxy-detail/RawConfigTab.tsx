import { RefreshCw, Save } from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { cn } from "@/lib/utils";

export interface RawConfigTabProps {
  isRawMode: boolean;
  rawConfig: string;
  setRawConfig: (v: string) => void;
  renderedConfig: string;
  isLoadingRaw: boolean;
  hasLoadedRendered?: boolean;
  isSavingRaw: boolean;
  editorErrorLines: number[];
  setEditorErrorLines: (v: number[]) => void;
  onValidate: () => Promise<boolean>;
  onSaveRaw: () => void;
  onRefreshRendered: () => void;
  dirty: boolean;
  canManage: boolean;
}

export function RawConfigTab({
  isRawMode,
  rawConfig,
  setRawConfig,
  renderedConfig,
  isLoadingRaw,
  hasLoadedRendered = renderedConfig !== "",
  isSavingRaw,
  editorErrorLines,
  setEditorErrorLines,
  onValidate,
  onSaveRaw,
  onRefreshRendered,
  dirty,
  canManage,
}: RawConfigTabProps) {
  // The tab reveals with the first rendered document; later refreshes keep it.
  useContentLoading(!isRawMode && !hasLoadedRendered);

  if (isRawMode) {
    return (
      <PanelShell
        title="Raw Config"
        description="Full custom Nginx config for this route"
        dirty={dirty}
        actions={
          canManage ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onValidate}>
                Validate
              </Button>
              <Button onClick={onSaveRaw} pending={isSavingRaw}>
                <Save className="h-4 w-4" />
                Save
              </Button>
            </div>
          ) : null
        }
        className="flex min-h-0 flex-1 flex-col"
        bodyClassName="flex min-h-0 flex-1"
        wrapHeader
      >
        <CodeEditor
          value={rawConfig}
          minHeight="0px"
          bordered={false}
          showGutterBorder={false}
          readOnly={!canManage}
          onChange={(val) => {
            setRawConfig(val);
            setEditorErrorLines([]);
          }}
          errorLines={editorErrorLines}
        />
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Rendered Config"
      description="Generated Nginx config for this route"
      actions={
        <Button variant="outline" onClick={onRefreshRendered} disabled={isLoadingRaw}>
          <RefreshCw className={cn("h-4 w-4", isLoadingRaw && "animate-spin")} />
          Refresh
        </Button>
      }
      className="flex min-h-0 flex-1 flex-col"
      bodyClassName="flex min-h-0 flex-1"
      wrapHeader
    >
      <CodeEditor
        value={renderedConfig}
        preserveScrollOnChange
        onChange={() => {}}
        readOnly
        minHeight="0px"
        bordered={false}
        showGutterBorder={false}
      />
    </PanelShell>
  );
}
