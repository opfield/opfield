import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { NotificationWebhook, WebhookPreset } from "@/types";
import {
  AnimatedHeight,
  STEP_ANIMATION,
  TemplateCheatsheetLink,
  TemplateEditor,
  type TemplateEditorHandle,
  UNIVERSAL_VARIABLES,
} from "./template-editor";

export function WebhookDialog({
  open,
  onOpenChange,
  webhook,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  webhook: NotificationWebhook | null;
  onSaved: () => void;
}) {
  const isEdit = !!webhook;
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [presets, setPresets] = useState<WebhookPreset[]>([]);
  // The presets are fetched on every opening, but the dialog only waits for the first list.
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [step, setStep] = useState(1);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState("POST");
  const [preset, setPreset] = useState("json");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [signingHeader, setSigningHeader] = useState("X-Signature-256");
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([]);

  const bodyEditorRef = useRef<TemplateEditorHandle>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setName(webhook?.name ?? "");
    setUrl(webhook?.url ?? "");
    setMethod(webhook?.method ?? "POST");
    setPreset(webhook?.templatePreset ?? "json");
    setBodyTemplate(webhook?.bodyTemplate ?? "");
    setSigningSecret("");
    setSigningHeader(webhook?.signingHeader ?? "X-Signature-256");
    const wHeaders = webhook?.headers as Record<string, string> | null;
    setHeaders(Object.entries(wHeaders ?? {}).map(([key, value]) => ({ key, value })));
    api
      .getWebhookPresets()
      .then(setPresets)
      .catch(() => {})
      .finally(() => setPresetsLoaded(true));
  }, [open, webhook]);

  const applyPreset = (id: string) => {
    setPreset(id);
    const p = presets.find((p) => p.id === id);
    if (p) {
      setBodyTemplate(p.bodyTemplate);
      if (p.defaultHeaders && Object.keys(p.defaultHeaders).length > 0) {
        setHeaders(Object.entries(p.defaultHeaders).map(([key, value]) => ({ key, value })));
      }
    }
  };

  const updateHeader = (idx: number, field: "key" | "value", val: string) => {
    setHeaders((prev) => prev.map((h, i) => (i === idx ? { ...h, [field]: val } : h)));
  };
  const removeHeader = (idx: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== idx));
  };
  const addHeader = () => {
    setHeaders((prev) => [...prev, { key: "", value: "" }]);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!url.trim()) {
      toast.error("URL is required");
      return;
    }
    if (!/^https?:\/\/.+/.test(url.trim())) {
      toast.error("URL must start with http:// or https://");
      return;
    }
    setSaving(true);
    try {
      const headersObj: Record<string, string> = {};
      for (const h of headers) {
        if (h.key.trim()) headersObj[h.key.trim()] = h.value;
      }
      const data: any = {
        name: name.trim(),
        url: url.trim(),
        method,
        templatePreset: preset || null,
        bodyTemplate: bodyTemplate || undefined,
        signingHeader,
        headers: headersObj,
      };
      if (signingSecret) data.signingSecret = signingSecret;
      if (isEdit) {
        await api.updateWebhook(webhook!.id, data);
        toast.success("Webhook updated");
      } else {
        data.enabled = true;
        await api.createWebhook(data);
        toast.success("Webhook created");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setSaving(false);
      toastApiError(err, "Failed");
    }
  };

  const PRESET_LABELS: Record<string, string> = {
    discord: "Discord",
    slack: "Slack",
    telegram: "Telegram",
    json: "JSON",
    plain: "Plain Text",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Webhook" : "New Webhook"}</DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Configure endpoint and authentication."
              : "Configure body template and variables."}
          </DialogDescription>
        </DialogHeader>
        <AnimatedHeight>
          <ContentLoading loading={!presetsLoaded} />
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div key="wh-step-1" {...STEP_ANIMATION} className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Name</label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Discord Alerts"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Method</label>
                    <Select value={method} onValueChange={setMethod}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="POST">POST</SelectItem>
                        <SelectItem value="PUT">PUT</SelectItem>
                        <SelectItem value="PATCH">PATCH</SelectItem>
                        <SelectItem value="GET">GET</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">URL</label>
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={presets.find((p) => p.id === preset)?.urlHint ?? "https://..."}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">HMAC Header</label>
                    <Input
                      value={signingHeader}
                      onChange={(e) => setSigningHeader(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Signing Secret</label>
                    <Input
                      type="password"
                      value={signingSecret}
                      onChange={(e) => setSigningSecret(e.target.value)}
                      placeholder={isEdit ? "********" : "Optional"}
                    />
                  </div>
                </div>
                <PanelShell
                  title="Custom Headers"
                  description="Extra HTTP headers sent with every delivery."
                  headerActionsClassName="pl-4"
                  actions={
                    <Button onClick={addHeader}>
                      <Plus />
                      Add header
                    </Button>
                  }
                >
                  {headers.length > 0
                    ? headers.map((h, idx) => (
                        <div key={idx} className="flex border-b border-border last:border-b-0">
                          <Input
                            aria-label={`Header ${idx + 1} name`}
                            value={h.key}
                            onChange={(e) => updateHeader(idx, "key", e.target.value)}
                            className="h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            placeholder="Content-Type"
                          />
                          <Input
                            aria-label={`Header ${idx + 1} value`}
                            value={h.value}
                            onChange={(e) => updateHeader(idx, "value", e.target.value)}
                            className="h-9 min-w-0 flex-1 rounded-none border-0 border-l border-border bg-transparent font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            placeholder="application/json"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="rounded-none border-l border-border"
                            aria-label={`Remove header ${idx + 1}`}
                            onClick={() => removeHeader(idx)}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))
                    : null}
                </PanelShell>
              </motion.div>
            )}
            {step === 2 && (
              <motion.div key="wh-step-2" {...STEP_ANIMATION} className="space-y-5">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Preset</label>
                  <Tabs value={preset} onValueChange={applyPreset}>
                    <TabsList>
                      {presets.map((p) => (
                        <TabsTrigger key={p.id} value={p.id}>
                          {PRESET_LABELS[p.id] ?? p.name}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Body Template</label>
                  <TemplateEditor
                    ref={bodyEditorRef}
                    value={bodyTemplate}
                    onChange={setBodyTemplate}
                    minHeight={300}
                  />
                  <TemplateCheatsheetLink variables={UNIVERSAL_VARIABLES} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </AnimatedHeight>
        <DialogFooter className="shrink-0">
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (!name.trim()) {
                    toast.error("Name is required");
                    return;
                  }
                  if (!url.trim()) {
                    toast.error("URL is required");
                    return;
                  }
                  if (!/^https?:\/\/.+/.test(url.trim())) {
                    toast.error("URL must start with http:// or https://");
                    return;
                  }
                  setStep(2);
                }}
              >
                Next <ArrowRight />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft /> Back
              </Button>
              <Button onClick={handleSave} pending={saving}>
                {isEdit ? "Update" : "Create"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
