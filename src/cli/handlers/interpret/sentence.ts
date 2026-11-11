// `factory "<words>"` (design 04-gate-commands, the CLI sentence form): a command in the owner's own words, read by
// the plain-words reader (src/core/interpret.ts) over the open items. Each proposed command is printed as its typed
// line with the proposal ID and stored as a pending proposal row; `factory confirm <proposal-id>` applies them through
// the controller's confirm path. Nothing here changes an item's state.

import { CONFIRM_WORD, type CliIdentity, type CliResult } from "../../../core/local-cli.js";
import { SENTENCE_FORM } from "../../../core/command-table.js";
import { INTERPRET_MAX_CHARS, INTERPRET_MAX_ITEMS, interpret, interpretReply, interpretTexts, isProposalId, openItems, typed } from "../../../core/interpret.js";
import type { EgressScanner } from "../../../interfaces/egress-scanner.js";
import type { FactoryStore } from "../../../interfaces/factory-store.js";
import type { LLMProvider } from "../../../interfaces/llm-provider.js";

export interface SentenceDeps {
  store: Pick<FactoryStore, "listWorkItemsWhere" | "recordCommandProposals">;
  llm: LLMProvider;
  scanner: Pick<EgressScanner, "scan">;
  identity: CliIdentity;
  /** The identity's refusal of approve_spec through the local auth plugin, or null when it may (as a plain reply is checked). */
  refusal: () => Promise<string | null>;
  /** A new random ID: the proposal's. */
  newId: () => string;
}

/** The words of `factory <words...>` as one sentence, or why they are none: a sentence has at least two words. */
export function parseSentence(args: readonly string[]): { text: string } | { error: string } {
  const text = args.join(" ").replace(/\s+/g, " ").trim();
  if (text.split(" ").length < 2) {
    return { error: `unknown command ${JSON.stringify(text)}; a command in your own words takes at least two words: factory ${SENTENCE_FORM}` };
  }
  if (text.length > INTERPRET_MAX_CHARS) return { error: `a command in your own words is at most ${INTERPRET_MAX_CHARS} characters` };
  return { text };
}

/** A new proposal ID from a random ID: `prop_` and its letters and digits. */
function newProposalId(newId: () => string): string {
  const id = `prop_${newId().replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 64);
  if (!isProposalId(id)) throw new Error("no proposal ID");
  return id;
}

/**
 * Reads `text` as a message on no item: the role check, the egress scan of the words, one model call over the open
 * items, the egress scan of the answer; then a `commands` answer's proposals are stored pending under one new proposal
 * ID and printed as typed lines. Any other answer is printed as a plain reply would read; nothing is stored.
 */
export async function runSentence(d: SentenceDeps, text: string): Promise<CliResult> {
  const fail = (line: string): CliResult => ({ code: 1, lines: [line] });
  const refused = await d.refusal();
  if (refused !== null) return fail(`not read: ${refused}`);
  if (!(await d.scanner.scan("comment", text)).clean) return fail("not read: the words did not pass the egress scan, so they were not sent to the model");
  const items = openItems(await d.store.listWorkItemsWhere({ exclude_closed: true, limit: INTERPRET_MAX_ITEMS }));
  const result = await interpret(text, items, d.llm, "top_level");
  for (const t of interpretTexts(result)) if (!(await d.scanner.scan("comment", t)).clean) return fail("the model's answer did not pass the egress scan, so it is not shown");
  if (result.kind === "commands") {
    const id = newProposalId(d.newId);
    await d.store.recordCommandProposals(result.proposals.map((p, idx) => ({
      proposal_id: id, idx, work_item_id: p.item.id, command: p.command, args: p.args, author_id: d.identity.user,
    })));
    return {
      code: 0,
      lines: [
        `proposal ${id}: nothing has changed. To apply every command, run \`factory ${CONFIRM_WORD} ${id}\`; or type a line on its item.`,
        ...result.proposals.map((p) => `  ${p.item.id}\t${typed(p)}`),
      ],
    };
  }
  if (result.kind === "request") return { code: 0, lines: ["That reads as a work request, so nothing has changed: create it with `factory task create --title <t> --body-file <f>`."] };
  // A hidden marker (an unsure answer's task offer) is for a surface with buttons; the terminal shows the text only.
  const reply = interpretReply(result) ?? "The factory did not find a command in your words, so nothing changed.";
  return { code: 0, lines: reply.split("\n").filter((l) => !l.startsWith("<!--")) };
}
