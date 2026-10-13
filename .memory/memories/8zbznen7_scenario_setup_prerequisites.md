---
{
  "id": "8zbznen7",
  "file_name": "8zbznen7_scenario_setup_prerequisites",
  "tags": [
    "ai-workspace",
    "integrations",
    "onboarding",
    "scenarios"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1786577233872,
  "updated_at": 1791851314656
}
---
AI Workspace scenario prerequisite handoff contract:
- A missing connector or Opfield-managed node is a setup decision, not a terminal scenario blocker.
- After the user selects a path, the assistant must invoke the direct client action: `open_connector_setup` for `cloudflare`, `gitlab`, `github`, or generic `git`; and `open_node_enrollment` for an Opfield-managed node.
- The client action opens the exact standalone connector or enrollment dialog from AI Workspace, reusing the shared dialog animation. It must never route an in-progress scenario into the global Finalize Setup checklist.
- On configured or cancelled completion, send the outcome back to the same conversation and have the assistant re-check the prerequisite before planning.
- Finalize Setup may list GitHub and generic Git as optional connector choices alongside Cloudflare and GitLab; it remains a separate, user-owned onboarding checklist.
