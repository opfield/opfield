import { Save } from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";

export interface AdvancedTabProps {
  advancedConfig: string;
  setAdvancedConfig: (v: string) => void;
  editorErrorLines: number[];
  setEditorErrorLines: (v: number[]) => void;
  onValidate: () => Promise<boolean>;
  onSaveAdvanced: () => void;
  isSavingAdvanced: boolean;
  dirty: boolean;
  canManage: boolean;
}

export function AdvancedTab({
  advancedConfig,
  setAdvancedConfig,
  editorErrorLines,
  setEditorErrorLines,
  onValidate,
  onSaveAdvanced,
  isSavingAdvanced,
  dirty,
  canManage,
}: AdvancedTabProps) {
  return (
    <PanelShell
      title="Advanced Config"
      description="Additional Nginx directives for this route"
      dirty={dirty}
      actions={
        canManage ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onValidate}>
              Validate
            </Button>
            <Button onClick={onSaveAdvanced} pending={isSavingAdvanced}>
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
        value={advancedConfig}
        minHeight="0px"
        bordered={false}
        showGutterBorder={false}
        readOnly={!canManage}
        onChange={(val) => {
          setAdvancedConfig(val);
          setEditorErrorLines([]);
        }}
        errorLines={editorErrorLines}
      />
    </PanelShell>
  );
}
