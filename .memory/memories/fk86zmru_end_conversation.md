---
{
  "id": "fk86zmru",
  "file_name": "fk86zmru_end_conversation",
  "tags": [
    "ai-chat",
    "backend",
    "conversation-status",
    "frontend",
    "opfield",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.88,
  "created_at": 1782909966338,
  "updated_at": 1791851549509
}
---
In the Opfield repository, AI chat terminal state is represented by hidden assistant messages with conversationStatus "ended" or "context_blocked" plus blockReason, not by ai_conversations columns. end_conversation/context_blocked runtime events must persist that marker, snapshots must derive status from the UI messages themselves, frontend normalization must preserve conversationStatus/blockReason or synthesize a marker from conversation.status, and startUserRun should reject new user turns when a recent marker says the conversation is ended or context-blocked. Useful regression checks: backend ai-run-executor and ai-run.service tests, backend ai.ws test, frontend ai-conversation-persistence store test, frontend/backend tsc, biome on touched files, git diff --check.
