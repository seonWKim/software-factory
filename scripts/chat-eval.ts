// `npm run eval:chat` (design 04-chat-agent): runs the chat's eval suite once against this checkout. It reads
// tests/chat-eval/owner-questions.json, sends each question through chatTurn in a new session on a throwaway store,
// with the four feature-map tools and the Ask model (settings.ask.llm: the configured Model plugin, as chat.send
// uses), and has the judge (the same LLMProvider, model_class "standard") grade each reply against its
// judged_answer (src/core/chat-eval.ts). It prints one line per question and the passed count, and exits 1 below
// CHAT_EVAL_PASS_BAR, 0 at it or more. Model calls go only through the LLMProvider plugin; this file holds no
// credential. Kept out of `npm test` (heavy tests run on a schedule): the controller's chat-eval unit runs it daily.
// Started by scripts/chat-eval.mjs, which lets Node load the TypeScript sources.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHAT_EVAL_QUESTIONS, type ChatEvalDeps, chatEvalExitCode, chatEvalLines, parseChatEvalQuestions, runChatEval } from "../src/core/chat-eval.js";

/** What the run needs: the eval's deps and the questions file's text. */
export interface ChatEvalWiring { deps: ChatEvalDeps; questions: string }

/** The configured Model plugin, egress scanner and Clock, the API registry's feature map, and the checked-in questions. */
export async function wireFromConfig(root = process.cwd()): Promise<ChatEvalWiring> {
  const [{ loadConfig }, { Plugins }, { readFeatureMap }, { REGISTRY }] = await Promise.all([
    import("../src/load-config.js"), import("../src/plugin-set.js"), import("../src/api/feature-map.js"), import("../src/api/index.js"),
  ]);
  const p = new Plugins(await loadConfig(root));
  const secrets = await p.secrets();
  const llm = await p.llm(secrets);
  const deps: ChatEvalDeps = {
    llm, judge: llm, read: (path) => readFeatureMap(REGISTRY, path), scanner: await p.scanner(secrets), clock: await p.clock(), newId: randomUUID,
  };
  return { deps, questions: await readFile(join(root, CHAT_EVAL_QUESTIONS), "utf8") };
}

/** Runs the suite, prints its lines, and answers the exit code: 0 at the pass bar or more, 1 below it. */
export async function main(wire: () => Promise<ChatEvalWiring> = wireFromConfig, print: (line: string) => void = console.log): Promise<number> {
  const { deps, questions } = await wire();
  const report = await runChatEval(deps, parseChatEvalQuestions(questions));
  for (const line of chatEvalLines(report)) print(line);
  return chatEvalExitCode(report.passed);
}
