import { BookOpen, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AIAgentSkill, AIUserSkillInput } from "@/types/ai";

type SkillDialogMode = "create" | "edit" | "view";

const EMPTY_FORM: AIUserSkillInput = {
  name: "",
  description: "",
  instructions: "",
  enabled: true,
};

export function AgentSkillsPanel() {
  const hasScope = useAuthStore((state) => state.hasScope);
  const canManage = hasScope("ai:skills:manage");
  const [skills, setSkills] = useState<AIAgentSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<SkillDialogMode>("view");
  const [selectedSkill, setSelectedSkill] = useState<AIAgentSkill | null>(null);
  const [form, setForm] = useState<AIUserSkillInput>(EMPTY_FORM);
  const [systemSkillsExpanded, setSystemSkillsExpanded] = useState(false);
  const userSkills = skills.filter((skill) => skill.source === "user");
  const systemSkills = skills.filter((skill) => skill.source === "system");

  const load = useCallback(async () => {
    try {
      setSkills(await api.listAISkills());
    } catch (error) {
      toastApiError(error, "Failed to load agent skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setDialogMode("create");
    setSelectedSkill(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openSkill = (skill: AIAgentSkill, mode: "edit" | "view") => {
    setDialogMode(mode);
    setSelectedSkill(skill);
    setForm({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      enabled: skill.enabled,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.description.trim() || !form.instructions.trim()) return;
    setSaving(true);
    try {
      if (dialogMode === "create") {
        await api.createAISkill(form);
        toast.success("Skill created");
      } else if (selectedSkill) {
        await api.updateAISkill(selectedSkill.id, form);
        toast.success("Skill updated");
      }
      setDialogOpen(false);
      await load();
    } catch (error) {
      toastApiError(error, "Failed to save skill");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skill: AIAgentSkill) => {
    const confirmed = await confirm({
      title: "Delete Skill?",
      description: `Delete “${skill.name}”? This removes it from every AI Workspace user.`,
      confirmLabel: "Delete skill",
      variant: "destructive",
    });
    if (!confirmed) return;
    setDeletingId(skill.id);
    try {
      await api.deleteAISkill(skill.id);
      setSkills((current) => current.filter((item) => item.id !== skill.id));
      toast.success("Skill deleted");
    } catch (error) {
      toastApiError(error, "Failed to delete skill");
    } finally {
      setDeletingId(null);
    }
  };

  const toggleSystemSkillsExpanded = () => {
    setSystemSkillsExpanded((current) => !current);
  };

  const renderSkillRow = (skill: AIAgentSkill) => (
    <div key={skill.id} className="group relative border-b border-border last:border-b-0">
      {/* Transparent overlay that makes the whole row open the skill. */}
      <button
        type="button"
        aria-label={`Open ${skill.name}`}
        className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => openSkill(skill, skill.source === "user" && canManage ? "edit" : "view")}
      />
      <SettingsControlRow
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{skill.name}</span>
            {!skill.enabled ? (
              <Badge variant="secondary" size="inline" className="shrink-0">
                Disabled
              </Badge>
            ) : null}
          </span>
        }
        description={skill.description}
        className="transition-colors group-hover:bg-accent/50"
        controlsClassName="relative z-20 sm:max-w-none"
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          {skill.source === "system" ? <Badge variant="outline">System</Badge> : null}
          {skill.source === "user" && canManage ? (
            <Button
              variant="outline"
              size="icon"
              aria-label={`Delete ${skill.name}`}
              pending={deletingId === skill.id}
              onClick={(event) => {
                event.stopPropagation();
                void remove(skill);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </SettingsControlRow>
    </div>
  );

  useContentLoading(loading);
  const readOnly = dialogMode === "view";
  const title =
    dialogMode === "create"
      ? "Add Agent Skill"
      : dialogMode === "edit"
        ? "Edit Agent Skill"
        : "Agent Skill";

  return (
    <>
      <PanelShell
        title="Agent Skills"
        description="Reusable operating instructions that AI Workspace loads only when relevant"
        icon={<BookOpen className="h-4 w-4" />}
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Add Skill
            </Button>
          ) : null
        }
      >
        {loading ? null : (
          <div>
            {userSkills.length === 0 ? (
              <EmptyState
                message="No custom skills configured."
                actionLabel={canManage ? "Add one" : undefined}
                onAction={canManage ? openCreate : undefined}
                embedded
              />
            ) : null}
            {userSkills.map(renderSkillRow)}
            {systemSkills.length > 0 ? (
              <div>
                {/* Section header that expands the system skills list. */}
                <button
                  type="button"
                  className={`flex w-full items-center justify-between bg-muted/30 px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/45 ${
                    userSkills.length === 0 ? "border-t border-border" : ""
                  }`}
                  onClick={toggleSystemSkillsExpanded}
                  aria-expanded={systemSkillsExpanded}
                >
                  <span>System skills</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform duration-200 ${
                      systemSkillsExpanded ? "rotate-180" : ""
                    }`}
                  />
                </button>
                <div
                  aria-hidden={!systemSkillsExpanded}
                  inert={systemSkillsExpanded ? undefined : true}
                  className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    systemSkillsExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                  }`}
                >
                  <div
                    className={`min-h-0 overflow-hidden ${
                      systemSkillsExpanded ? "border-t border-border" : ""
                    }`}
                  >
                    {systemSkills.map(renderSkillRow)}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </PanelShell>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {selectedSkill?.source === "system"
                ? "System skills are maintained by Opfield and cannot be changed or disabled."
                : "Skills are shared across AI Workspace and cannot override Opfield security or permissions."}
            </DialogDescription>
          </DialogHeader>
          <PanelShell>
            <SettingsControlRow title="Name">
              <Input
                aria-label="Skill name"
                placeholder="Production deployment conventions"
                value={form.name}
                readOnly={readOnly}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Description"
              description="Used by the agent when choosing relevant skills."
            >
              <Input
                aria-label="Skill description"
                placeholder="When the agent should use this skill"
                value={form.description}
                readOnly={readOnly}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </SettingsControlRow>
            {dialogMode === "edit" && selectedSkill?.source === "user" ? (
              <SettingsControlRow
                title="Enabled"
                description="Allow AI Workspace to load this skill when relevant."
              >
                <Switch
                  checked={form.enabled !== false}
                  disabled={saving}
                  ariaLabel="Skill enabled"
                  onChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
                />
              </SettingsControlRow>
            ) : null}
            <div className="border-b border-border bg-muted p-4">
              <h3 className="text-sm font-semibold">Instructions</h3>
              <p className="text-xs text-muted-foreground">
                Loaded only after the agent activates this skill.
              </p>
            </div>
            <Textarea
              aria-label="Skill instructions"
              className="min-h-80 resize-y border-0"
              placeholder="Describe the workflow, rules, constraints, and examples the agent should follow."
              value={form.instructions}
              readOnly={readOnly}
              onChange={(event) =>
                setForm((current) => ({ ...current, instructions: event.target.value }))
              }
            />
          </PanelShell>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly ? (
              <Button
                onClick={() => void save()}
                pending={saving}
                disabled={
                  !form.name.trim() || !form.description.trim() || !form.instructions.trim()
                }
              >
                {dialogMode === "create" ? "Add Skill" : "Save Changes"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
