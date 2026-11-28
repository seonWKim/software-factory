// The context line the Chat page puts before a sent question (web/src/views/chat-page.tsx, design 09-dashboard-chat):
// one rule shared by the dashboard, which takes it off a stored message it shows, and chat.turns, which takes it off a
// session's preview.

/** `text` without the "Open page: …" or "About item: …" line (and its blank line) a sent message may start with. */
export const withoutContext = (text: string): string => text.replace(/^(?:Open page|About item): [^\n]*\n\n/, "");
