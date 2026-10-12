import { ArrowRight, Bot, LayoutDashboard, type LucideIcon } from "lucide-react";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Choice = { label: string; description: string; icon: LucideIcon; onSelect: () => void };
type InterfaceChoiceDialogProps = {
  open: boolean;
  busy: boolean;
  onOpenChange?: (open: boolean) => void;
} & (
  | {
      choices: Choice[];
      title: string;
      description: string;
      onAIWorkspace?: never;
      onOperationsConsole?: never;
    }
  | {
      choices?: never;
      title?: never;
      description?: never;
      onAIWorkspace: () => void;
      onOperationsConsole: () => void;
    }
);

export function InterfaceChoiceDialog(props: InterfaceChoiceDialogProps) {
  const { open, busy, onOpenChange } = props;
  const choices: Choice[] = props.choices ?? [
    {
      label: "AI Workspace",
      icon: Bot,
      onSelect: props.onAIWorkspace!,
      description:
        "Start from an outcome, keep guidance and infrastructure context in one Work Session, and move into Opfield resources without losing the conversation.",
    },
    {
      label: "Operations Console",
      icon: LayoutDashboard,
      onSelect: props.onOperationsConsole!,
      description:
        "Use the complete Opfield interface directly. Every capability remains available without AI, and AI Workspace stays one click away when configured.",
    },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange ?? (() => {})} modal>
      <DialogContent
        hideCloseButton={!onOpenChange}
        className="sm:max-w-lg"
        onEscapeKeyDown={onOpenChange ? undefined : (event) => event.preventDefault()}
        onPointerDownOutside={onOpenChange ? undefined : (event) => event.preventDefault()}
        onInteractOutside={onOpenChange ? undefined : (event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{props.title ?? "Choose Your Opfield Interface"}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {props.description ??
            "AI Workspace is the recommended intent-driven interface for understanding and operating Opfield. Operations Console remains a complete interface and does not depend on AI."}
        </DialogDescription>
        <div className="grid gap-3">
          {choices.map(({ label, description, icon, onSelect }) => (
            <ChoiceCard
              key={label}
              icon={icon}
              title={label}
              description={description}
              trailing={<ArrowRight className="text-muted-foreground" />}
              disabled={busy}
              onClick={onSelect}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
