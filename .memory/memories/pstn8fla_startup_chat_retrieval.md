---
{
  "id": "pstn8fla",
  "file_name": "pstn8fla_startup_chat_retrieval",
  "tags": [
    "ai-chat",
    "conversation-retrieval",
    "opfield",
    "system-prompt"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1782520699038,
  "updated_at": 1791851836625
}
---
In the Opfield repository, the AI system prompt/retrieval contract is enterprise-grade rather than MVP: at the first substantive request in a new conversation and whenever the user explicitly asks about previous work, the assistant must search previous chats in both the current retrieval boundary and all_user_chats before answering. Project chats should inject project pointers plus lightweight tail context for up to 3 recent project chats; remaining chats are pointers/on-demand via search_chats/find_in_chat/read_chat_slice. Tail snippets are not authoritative evidence; exact claims require read_chat_slice. Prompt rules should strongly require discover_tools before claiming an Opfield tool is unavailable and internal_documentation before complex/recent/permission-sensitive workflows.
