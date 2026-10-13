import type { StoreApi, UseBoundStore } from "zustand";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import { type AIState, nowIso } from "./ai.store-shared";

export function installAIStoreLifecycle(useAIStore: UseBoundStore<StoreApi<AIState>>): void {
  const DEV_APPROVAL_MESSAGE_ID = "dev-approval-preview-message";
  const DEV_APPROVAL_TOOL_CALL_ID = "dev-approval-preview-tool";
  const DEV_CHANGED_RESOURCES_MESSAGE_ID = "dev-changed-resources-preview-message";
  const DEV_PLAN_PREVIEW_ID = "dev-plan-progress-preview";

  function installAIResourcePreviewCommands(): void {
    if (typeof window === "undefined") return;

    window.opfieldDev = {
      ...(window.opfieldDev ?? {}),
      showChangedResources: () => {
        useUIStore.setState({ aiPanelOpen: true });
        useAIStore.setState((state) => ({
          messages: [
            ...state.messages.filter((message) => message.id !== DEV_CHANGED_RESOURCES_MESSAGE_ID),
            {
              id: DEV_CHANGED_RESOURCES_MESSAGE_ID,
              role: "assistant",
              content: "",
              createdAt: nowIso(),
              changedResourceReferences: [
                {
                  refId: "res_000000000000000000000001",
                  type: "node",
                  resourceId: "dev-preview-node",
                  label: "docker-src",
                  relation: "updated",
                  slug: "docker-src",
                },
                {
                  refId: "res_000000000000000000000002",
                  type: "docker_container",
                  resourceId: "dev-preview-container",
                  label: "ai-e2e-restart",
                  relation: "created",
                  nodeSlug: "docker-src",
                },
                {
                  refId: "res_000000000000000000000003",
                  type: "docker_volume",
                  resourceId: "ai-e2e-restart-data",
                  label: "ai-e2e-restart-data",
                  relation: "updated",
                  nodeSlug: "docker-src",
                },
              ],
            },
          ],
        }));
      },
      hideChangedResources: () => {
        useAIStore.setState((state) => ({
          messages: state.messages.filter(
            (message) => message.id !== DEV_CHANGED_RESOURCES_MESSAGE_ID
          ),
        }));
      },
      showPlanProgress: () => {
        const now = new Date();
        const publishedAt = new Date(now.getTime() - 60_000).toISOString();
        useUIStore.setState({ aiPanelOpen: true });
        useAIStore.setState((state) => ({
          activeConversationId:
            state.activeConversationId ?? "00000000-0000-4000-8000-000000000001",
          devPlanProgressPreview: {
            id: DEV_PLAN_PREVIEW_ID,
            conversationId: state.activeConversationId ?? "00000000-0000-4000-8000-000000000001",
            status: "executing",
            title: "Implement Opfield plan mode",
            model: state.selectedModel,
            reasoningEffort: state.selectedReasoningEffort,
            revisionId: `${DEV_PLAN_PREVIEW_ID}-revision`,
            revision: 1,
            revisionStatus: "accepted",
            publishedAt,
            timelineAnchorAt: publishedAt,
            acceptedAt: publishedAt,
            goal: "Complete and verify the requested Opfield changes.",
            scope: ["Opfield UI", "Plan execution"],
            assumptions: [],
            research: [],
            intentReview: {
              verdict: "pass",
              summary: "The plan matches the request.",
              findings: [],
            },
            securityReview: {
              verdict: "pass",
              summary: "The plan is safe to execute.",
              findings: [],
            },
            verification: [],
            changeSummary: null,
            steps: [
              {
                id: `${DEV_PLAN_PREVIEW_ID}-step-1`,
                ordinal: 0,
                title: "Inspect current behavior",
                description: "Confirm the existing Plan Mode flow.",
                verification: "The current behavior is documented.",
                status: "completed",
                evidence: [{ summary: "Current behavior inspected." }],
                skipReason: null,
                startedAt: publishedAt,
                completedAt: publishedAt,
              },
              {
                id: `${DEV_PLAN_PREVIEW_ID}-step-2`,
                ordinal: 1,
                title: "Implement the requested changes",
                description: "Update the active Plan Mode experience.",
                verification: "The updated behavior works in the UI.",
                status: "in_progress",
                evidence: [],
                skipReason: null,
                startedAt: now.toISOString(),
                completedAt: null,
              },
              {
                id: `${DEV_PLAN_PREVIEW_ID}-step-3`,
                ordinal: 2,
                title: "Verify the result",
                description: "Run targeted checks and browser verification.",
                verification: "All requested behavior is verified.",
                status: "pending",
                evidence: [],
                skipReason: null,
                startedAt: null,
                completedAt: null,
              },
            ],
            noProgressRuns: 0,
            activeTimeMs: 64_000,
            activeSince: now.toISOString(),
            pauseReason: null,
            createdAt: publishedAt,
            updatedAt: now.toISOString(),
          },
        }));
      },
      hidePlanProgress: () => {
        useAIStore.setState({ devPlanProgressPreview: null });
      },
    };
  }

  function installAIDevCommands(): void {
    if (!import.meta.env.DEV || typeof window === "undefined") return;

    window.opfieldDev = {
      ...(window.opfieldDev ?? {}),
      showApprovalBlock: () => {
        useUIStore.setState({ aiPanelOpen: true });
        useAIStore.setState((state) => ({
          messages: [
            ...state.messages.filter((message) => message.id !== DEV_APPROVAL_MESSAGE_ID),
            {
              id: DEV_APPROVAL_MESSAGE_ID,
              role: "assistant",
              content: "",
              createdAt: nowIso(),
              localOnly: true,
              isStreaming: true,
              toolCalls: [
                {
                  id: DEV_APPROVAL_TOOL_CALL_ID,
                  name: "run_process",
                  arguments: { command: "echo preview" },
                  status: "awaiting_approval",
                },
              ],
            },
          ],
          activeConversationId:
            state.activeConversationId ?? "00000000-0000-4000-8000-000000000001",
          activeRunId: state.activeRunId ?? "dev-approval-preview-run",
          isConnected: true,
          retryAfter: null,
        }));
      },
      hideApprovalBlock: () => {
        useAIStore.setState((state) => ({
          messages: state.messages.filter((message) => message.id !== DEV_APPROVAL_MESSAGE_ID),
        }));
      },
    };
  }

  installAIResourcePreviewCommands();
  installAIDevCommands();

  // Auto-manage WS lifecycle based on visible AI surfaces.
  // This runs outside React — no component mount/unmount issues.
  let prevAIActive = false;
  function syncAIWebSocketLifecycle(state: ReturnType<typeof useUIStore.getState>) {
    // The persisted UI value is only a visual preference. Wait for the
    // user-scoped preference load before opening a socket, otherwise startup
    // briefly opens AI from persisted state, closes it during hydration, then
    // opens it again with the server preference.
    const active = state.interfacePreferenceLoaded && (state.aiPanelOpen || state.aiLiteMode);
    if (active !== prevAIActive) {
      prevAIActive = active;
      if (active) {
        useAIStore.getState().connect();
      } else {
        useAIStore.getState().disconnect();
      }
    }
  }
  useUIStore.subscribe(syncAIWebSocketLifecycle);
  syncAIWebSocketLifecycle(useUIStore.getState());

  let prevAuthUserId: string | null = useAuthStore.getState().user?.id ?? null;
  let prevAuthLoading = useAuthStore.getState().isLoading;
  useAuthStore.subscribe((state) => {
    const nextUserId = state.user?.id ?? null;
    const authChanged = prevAuthUserId !== nextUserId || prevAuthLoading !== state.isLoading;
    prevAuthUserId = nextUserId;
    prevAuthLoading = state.isLoading;

    const ui = useUIStore.getState();
    const aiActive = ui.interfacePreferenceLoaded && (ui.aiPanelOpen || ui.aiLiteMode);
    if (!authChanged || !aiActive) return;
    if (state.user) {
      void useAIStore.getState().connect();
    } else if (!state.isLoading) {
      useAIStore.setState({ isConnecting: false, connectionError: "Not authenticated" });
    }
  });
}
