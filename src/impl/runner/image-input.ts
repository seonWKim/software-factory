// Image input for the Claude Code harness (design 02-attachments): a run with images reads its prompt as one
// stream-json user message on stdin, the prompt text first and each image after it as a base64 image block, so no
// image is ever written to a file in the sandbox or the repository. A run without images keeps plain-text stdin.

import type { AgentRunSpec } from "../../interfaces/agent-runner.js";

/** The harness flags for the spec's stdin: stream-json input when it has images, else none. */
export function inputArgs(spec: Pick<AgentRunSpec, "images">): string[] {
  return spec.images?.length ? ["--input-format", "stream-json"] : [];
}

/** What the harness reads on stdin: the prompt as text, or with images one stream-json user message line. */
export function stdinOf(spec: Pick<AgentRunSpec, "prompt" | "images">): string {
  if (!spec.images?.length) return spec.prompt;
  const content = [
    { type: "text", text: spec.prompt },
    ...spec.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
  ];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}
