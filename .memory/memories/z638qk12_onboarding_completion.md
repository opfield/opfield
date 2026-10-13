---
{
  "id": "z638qk12",
  "file_name": "z638qk12_onboarding_completion",
  "tags": [
    "ai-workspace",
    "inference",
    "navigation",
    "onboarding",
    "opfield",
    "rbac"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1786048875275,
  "updated_at": 1791852012087
}
---
# Opfield Onboarding, AI Workspace, and Interface Contract

## Finalize Setup and Browser Setup

- Finalize Setup is a terminal per-step checklist, not a dismissible dashboard notice.
- Version 3 raw steps are `nodes`, `ai_workspace`, `cloudflare`, `gitlab`, `mfa`, and `invite_users`.
- Opfield Inference is nested in the shared AI Workspace flow and is not a root checklist step. Normalize legacy `ai_assistant` to `ai_workspace`; legacy `inference` does not gate completion.
- The Integrations row is complete only when both Cloudflare and GitLab have outcomes. `Skip for now` closes without changing outcomes; `Finish` is available only after all raw steps have outcomes.
- Browser Setup applies core configuration first, persists phase `ai_workspace`, and remains incomplete until AI Workspace is configured or explicitly skipped.
- Reuse `ConfigureAIWorkspaceWizard` in Browser Setup, Finalize Setup, and the installation-owner interface chooser. Do not create a separate persistent sidebar CTA.
- The wizard supports an OpenAI-compatible provider or Opfield Inference. Show Inference only when the caller has every required management scope.
- Setup-purpose sessions are bounded to the active setup session, are never refreshed, are omitted from public session lists, are restricted to required setup endpoints, and are revoked on completion.
- `/api/ai/status` remains in the setup-purpose allowlist because setup refreshes provider state after saving.

## AI Workspace and Opfield Inference Scopes

- `ai:workspace:use` is the dedicated AI Workspace access scope.
- The built-in `viewer`, `operator`, `admin`, and `system-admin` groups receive `ai:workspace:use` by default. `guest` does not.
- `feat:ai:use` remains the separate Opfield Inference and personal inference-usage scope. It must never substitute for AI Workspace access.
- Existing groups and user-specific grants that had `feat:ai:use` before the split are migrated to also receive `ai:workspace:use`, preserving prior AI Workspace access without granting the new scope to programmatic tokens.
- AI Workspace browser routes, WebSocket authorization, embedded AI tools, provider shell state, connector handoffs, command palette actions, sidebar AI controls, and personal AI approval controls use `ai:workspace:use`.
- Opfield Inference management/data-plane access, inference tokens, model access, personal usage, usage cards, and inference endpoint preferences remain on `feat:ai:use` and their operation-specific inference scopes.

## Interface Choice and Navigation

- Persist each user's `preferredInterface` as `ai_workspace` or `operations_console`, with a server timestamp. Clear local preference state while another user's preference is loading.
- Users without `ai:workspace:use` never see the first-run interface chooser. Opfield immediately applies and persists `operations_console`, including when a stale stored preference says `ai_workspace`.
- Users without the Workspace scope do not see Workspace actions in Sidebar, Command Palette, or Profile. Direct `/ai/chats/:conversationId` access redirects to `/profile`.
- Users with `ai:workspace:use` see the non-dismissible chooser when AI Workspace is configured. The installation owner may configure Workspace through the same chooser.
- Choosing AI Workspace opens the shared setup flow and saves the preference only after successful setup.
- Sidebar may show the existing scoped `AIButton`, but must not contain a separate full-width or expand `Open AI Workspace` CTA.
- Product terms are AI Workspace, Operations Console, and Work Session. AI Workspace is recommended and intent-driven; Operations Console remains complete without AI.

## AI Side Panel Transition

- When switching from AI Workspace to Operations Console, automatically open the AI side panel only if the active persisted Work Session has content and at least one user-authored message or attachment.
- An empty chat, an assistant-only welcome state, a draft without a persisted conversation, or a session that was merely opened and closed must not auto-open the side panel.
- Manual AI panel opening and an already active meaningful Work Session remain unchanged.

## Dashboard Fallback

- Dashboard availability and routing must use the same `hasDashboardContent` contract as Sidebar visibility.
- If Dashboard is absent from Sidebar, both `/` in Operations Console and `/dashboard` redirect to `/profile`.
- Profile remains universally available for authenticated users.
- Dashboard and Sidebar keep sharing the deduplicated bootstrap snapshot (Dashboard bootstrap memory); do not create a parallel dashboard authorization model.

## Handoffs and resource links

- AI resource links use backend-issued canonical `uiHref` and `workspaceEmbeddable`; never derive Opfield routes from model text.
- Scenario prerequisite handoffs (`open_connector_setup`, `open_node_enrollment`) and terminal Work Session markers are specified in their own memories (scenario prerequisites; AI chat terminal state).

## Opfield Inference Boundary

- Opfield Inference administration is under Settings > Inference; personal usage and inference-token management are under Profile. The bounded-context contract lives in the inference product memory.
- The embedded Assistant may expose permission-aware inference management tools, but Opfield Inference remains excluded from remote Opfield MCP.

## Verification

- Keep backend scope definitions, built-in group defaults, migration compatibility, frontend scope metadata, AI route guards, chooser behavior, Sidebar/Profile visibility, Dashboard routing, internal docs, and tests synchronized.
