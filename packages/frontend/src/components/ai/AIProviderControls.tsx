import { Bot, Brain, Check, ChevronDown, Settings } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AIInferenceModelOption } from "@/types/ai";
import {
  AI_ICON_CONTROL,
  AI_TOOLBAR_TRIGGER,
  AI_TOOLBAR_TRIGGER_MUTED,
} from "./ai-control-classes";

const PROVIDER_CONTROLS_WIDTH_RESERVE = 32;

interface AIProviderControlsProps {
  modelOptions: AIInferenceModelOption[];
  selectedModel?: string | null;
  onModelChange?: (model: string) => void | Promise<void>;
  reasoningOptions: string[];
  selectedReasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string) => void | Promise<void>;
  disabled?: boolean;
}

interface ProviderControlMeasurementsProps {
  modelLabel: string;
  reasoningLabel: string;
  showModel: boolean;
  showReasoning: boolean;
}

function ProviderControlMeasurements({
  modelLabel,
  reasoningLabel,
  showModel,
  showReasoning,
}: ProviderControlMeasurementsProps) {
  return (
    <>
      {showModel && (
        <span className="flex h-8 max-w-[13rem] items-center gap-2 px-1.5 text-sm">
          <Bot className="h-4 w-4 shrink-0" />
          <span className="truncate">{modelLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </span>
      )}
      {showReasoning && (
        <span className="flex h-8 max-w-[10rem] items-center gap-2 px-1.5 text-sm">
          <Brain className="h-4 w-4 shrink-0" />
          <span className="truncate capitalize">{reasoningLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </span>
      )}
    </>
  );
}

export function shouldCompactProviderControls(availableWidth: number, controlsWidth: number) {
  if (availableWidth <= 0 || controlsWidth <= 0) return false;
  return controlsWidth + PROVIDER_CONTROLS_WIDTH_RESERVE > availableWidth;
}

export function AIProviderControls({
  modelOptions,
  selectedModel,
  onModelChange,
  reasoningOptions,
  selectedReasoningEffort,
  onReasoningEffortChange,
  disabled = false,
}: AIProviderControlsProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const showModel = modelOptions.length > 0 && !!onModelChange;
  const showReasoning = reasoningOptions.length > 0 && !!onReasoningEffortChange;
  const selectedModelLabel =
    modelOptions.find((model) => model.id === selectedModel)?.displayName ??
    selectedModel ??
    "Default";
  const reasoningLabel = selectedReasoningEffort ?? "Default";

  const updateLayout = useCallback(() => {
    const availableWidth = slotRef.current?.getBoundingClientRect().width ?? 0;
    const controlsWidth = measurementRef.current?.getBoundingClientRect().width ?? 0;
    setCompact(shouldCompactProviderControls(availableWidth, controlsWidth));
  }, []);

  useLayoutEffect(() => {
    updateLayout();
  });

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateLayout);
    if (slotRef.current) observer.observe(slotRef.current);
    if (measurementRef.current) observer.observe(measurementRef.current);
    return () => observer.disconnect();
  }, [updateLayout]);

  if (!showModel && !showReasoning) {
    return <div ref={slotRef} className="min-w-0 flex-1" />;
  }

  return (
    <div ref={slotRef} className="relative min-w-0 flex-1">
      <div
        ref={measurementRef}
        className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1"
        aria-hidden="true"
      >
        <ProviderControlMeasurements
          modelLabel={selectedModelLabel}
          reasoningLabel={reasoningLabel}
          showModel={showModel}
          showReasoning={showReasoning}
        />
      </div>

      {compact ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(AI_ICON_CONTROL, "h-9 w-9")}
              title="Model and reasoning"
              aria-label="Model and reasoning settings"
              disabled={disabled}
            >
              <Settings className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            {showModel && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="[&>svg:last-child]:ml-0">
                  <Bot className="h-4 w-4" />
                  <span>Model</span>
                  <span className="ml-auto min-w-0 max-w-28 truncate text-right text-sm text-muted-foreground">
                    {selectedModelLabel}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64">
                  {modelOptions.map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      onSelect={() => void onModelChange?.(model.id)}
                      disabled={disabled}
                    >
                      <Bot className="h-4 w-4" />
                      <span className="truncate">{model.displayName}</span>
                      {selectedModel === model.id && <Check className="ml-auto h-4 w-4" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {showReasoning && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="[&>svg:last-child]:ml-0">
                  <Brain className="h-4 w-4" />
                  <span>Reasoning</span>
                  <span className="ml-auto min-w-0 max-w-24 truncate text-right text-sm capitalize text-muted-foreground">
                    {reasoningLabel}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                  {reasoningOptions.map((effort) => (
                    <DropdownMenuItem
                      key={effort}
                      onSelect={() => void onReasoningEffortChange?.(effort)}
                      disabled={disabled}
                    >
                      <Brain className="h-4 w-4" />
                      <span className="capitalize">{effort}</span>
                      {selectedReasoningEffort === effort && <Check className="ml-auto h-4 w-4" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          {showModel && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(AI_TOOLBAR_TRIGGER, AI_TOOLBAR_TRIGGER_MUTED, "max-w-[13rem]")}
                  title={selectedModelLabel}
                  aria-label="AI model"
                  disabled={disabled}
                >
                  <Bot className="h-4 w-4 shrink-0" />
                  <span className="truncate">{selectedModelLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-64">
                {modelOptions.map((model) => (
                  <DropdownMenuItem
                    key={model.id}
                    onSelect={() => void onModelChange?.(model.id)}
                    disabled={disabled}
                  >
                    <Bot className="h-4 w-4" />
                    <span className="truncate">{model.displayName}</span>
                    {selectedModel === model.id && <Check className="ml-auto h-4 w-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {showReasoning && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(AI_TOOLBAR_TRIGGER, AI_TOOLBAR_TRIGGER_MUTED, "max-w-[10rem]")}
                  title={`Reasoning: ${selectedReasoningEffort ?? "default"}`}
                  aria-label="Reasoning effort"
                  disabled={disabled}
                >
                  <Brain className="h-4 w-4 shrink-0" />
                  <span className="truncate capitalize">{reasoningLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-48">
                {reasoningOptions.map((effort) => (
                  <DropdownMenuItem
                    key={effort}
                    onSelect={() => void onReasoningEffortChange?.(effort)}
                    disabled={disabled}
                  >
                    <Brain className="h-4 w-4" />
                    <span className="capitalize">{effort}</span>
                    {selectedReasoningEffort === effort && <Check className="ml-auto h-4 w-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}
