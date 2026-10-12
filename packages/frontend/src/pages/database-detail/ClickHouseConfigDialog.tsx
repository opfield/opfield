import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";

export function ClickHouseConfigDialog({
  database,
  open,
  onOpenChange,
  onSaved,
}: {
  database: DatabaseConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const managed = database.managed!;
  const savedConfig = managed.clickhouseConfigXml ?? "";
  const [configXml, setConfigXml] = useState(savedConfig);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) setConfigXml(savedConfig);
  }, [open, savedConfig]);

  const normalizedConfig = useMemo(() => configXml.trim(), [configXml]);
  const changed = normalizedConfig !== savedConfig.trim();

  const save = async () => {
    if (!changed || saving || confirming) return;
    setConfirming(true);
    const confirmed = await confirm({
      title: "Save & Recreate",
      description:
        "Applying ClickHouse configuration recreates the database container and temporarily takes it offline. It usually takes about 15 seconds; managed storage is retained. Continue?",
      confirmLabel: "Recreate",
      variant: "default",
    });
    setConfirming(false);
    if (!confirmed) return;

    setSaving(true);
    try {
      await api.updateManagedDatabase(managed.id, { clickhouseConfigXml: normalizedConfig });
      toast.success("ClickHouse configuration updated — container recreated");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to update ClickHouse configuration");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Configure ClickHouse</DialogTitle>
        </DialogHeader>
        <PanelShell
          title="ClickHouse configuration fragment"
          description="Optional XML configuration. Network and managed storage paths remain controlled by Opfield."
          className="min-h-0"
          bodyClassName="min-h-0 bg-background"
        >
          <CodeEditor
            value={configXml}
            onChange={setConfigXml}
            language="xml"
            height="min(46dvh, 380px)"
            minHeight="220px"
            bordered={false}
            showGutterBorder={false}
            readOnly={saving}
          />
        </PanelShell>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            pending={saving}
            disabled={!changed || confirming}
          >
            {saving ? "Recreating database..." : "Save & Recreate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
