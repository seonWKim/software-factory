// The chat's eval suite (design 04-chat-agent): tests/chat-eval/owner-questions.json holds the owner's questions,
// each with the answer a judge grades the chat's reply against. The pass bar reads it on a schedule; this test checks
// its shape only and calls no model.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatToolsOf } from "../src/core/chat-agent-tools.js";

interface Question { id: string; question: string; judged_answer: string; tools: string[] }
const SUITE = JSON.parse(readFileSync(join(import.meta.dirname, "chat-eval", "owner-questions.json"), "utf8")) as { questions: Question[] };
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

describe("the chat eval suite", () => {
  it("holds at least 10 questions", () => {
    expect(Array.isArray(SUITE.questions)).toBe(true);
    expect(SUITE.questions.length).toBeGreaterThanOrEqual(10);
  });

  it("gives each question a unique id, its text and a judged answer", () => {
    for (const q of SUITE.questions) {
      expect(nonEmpty(q.id), JSON.stringify(q)).toBe(true);
      expect(nonEmpty(q.question), q.id).toBe(true);
      expect(nonEmpty(q.judged_answer), q.id).toBe(true);
    }
    const ids = SUITE.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only the chat's tools as the ones a question expects", () => {
    const names = new Set(chatToolsOf(() => null, async () => ({ status: 404, value: {} })).map((t) => t.name));
    for (const q of SUITE.questions) {
      expect(Array.isArray(q.tools), q.id).toBe(true);
      expect(q.tools.filter((t) => !names.has(t)), q.id).toEqual([]);
    }
  });
});
