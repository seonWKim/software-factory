## History

- **Not built: running the eval suite here** (decision changed 2026-11-27, local-task-tk_eea9af6d phase 3 of 3). Before: the eval questions were checked in and only their shape was tested; nothing sent them to the chat, judged a reply or held a pass bar. Replaced by the daily eval run and the pass bar of 8 of [04-chat-agent](../04-chat-agent.md).
- **No HTTP route, capability or dashboard page called the chat turn** (decision changed 2026-11-26, local-task-tk_eea9af6d phase 2, phase 1 of 2). Before: `chatTurn` ran only from tests; nothing reached it, and the store kept no turn's outcome or reason, only its messages and spend. Replaced by the `chat.send`, `chat.transcript` and `chat.turns` capabilities and the `controller_chat_turns` row of [04-chat-agent](../04-chat-agent.md).
