import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import { AI_SCOPE } from "@/types";

interface AIButtonProps {
  iconOnly?: boolean;
  showLabel?: boolean;
}

export function AIButton({ iconOnly = false, showLabel = false }: AIButtonProps) {
  const { toggleAIPanel, aiPanelOpen, aiLiteMode } = useUIStore();
  const isEnabled = useAIStore((state) => state.isEnabled);
  const canUseAIWorkspace = useAuthStore((state) => state.hasScope(AI_SCOPE));

  const handleClick = () => {
    if (showLabel || isEnabled === false || !canUseAIWorkspace || aiLiteMode) {
      window.dispatchEvent(new CustomEvent("gateway:open-ai-workspace"));
      return;
    }
    toggleAIPanel();
  };

  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={aiPanelOpen ? "bg-sidebar-accent text-primary" : undefined}
            onClick={handleClick}
            aria-label="AI Workspace"
          >
            <Sparkles className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">AI Workspace (⌘I)</TooltipContent>
      </Tooltip>
    );
  }

  if (showLabel) {
    return (
      <Button
        variant="ghost"
        className={`h-auto w-full justify-start gap-2 bg-sidebar-accent px-3 py-2 text-sidebar-accent-foreground/80 hover:bg-muted hover:text-sidebar-accent-foreground ${
          aiPanelOpen ? "text-primary" : ""
        }`}
        onClick={handleClick}
      >
        <Sparkles className="h-4 w-4 shrink-0" />
        <span className="truncate">AI Workspace</span>
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className={`md:h-7 md:w-7 ${aiPanelOpen ? "text-primary" : ""}`}
          onClick={handleClick}
          aria-label="AI Workspace"
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>AI Workspace (⌘I)</TooltipContent>
    </Tooltip>
  );
}
