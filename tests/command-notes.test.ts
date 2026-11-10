import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answersDetail, autoApprovalDetail, decisionsSection, splitAnswers, storedAnswers } from "../src/shared/command-notes.js";

// Answers to a spec's decisions in an approval note (issue #526): one parser for every approval source.

const DECISIONS = [
  { text: "Fail the job, or only warn?", default: "Fail the job" },
  { text: "Name the step?", default: "scope" },
  { text: "Who owns the gate?", default: null },
];

const fence = (t: string) => `\`\`\`\n${t}\n\`\`\``;

describe("splitAnswers", () => {
  it("splits N: lines off the note; the other lines remain the note", () => {
    const r = splitAnswers("keep it small\n1: Only warn\n 2 :  check \nand tested", DECISIONS);
    expect(r).toEqual({
      note: "keep it small\nand tested",
      answers: [
        { question: "Fail the job, or only warn?", answer: "Only warn", accepted_default: false },
        { question: "Name the step?", answer: "check", accepted_default: false },
        { question: "Who owns the gate?", answer: null, accepted_default: false },
      ],
    });
  });

  it("a decision with no line takes its default as accepted; an answer equal to the default is accepted too", () => {
    const r = splitAnswers("2: scope", DECISIONS);
    expect(r).toEqual({
      note: null,
      answers: [
        { question: "Fail the job, or only warn?", answer: "Fail the job", accepted_default: true },
        { question: "Name the step?", answer: "scope", accepted_default: true },
        { question: "Who owns the gate?", answer: null, accepted_default: false },
      ],
    });
  });

  it("an answer to a decision with no default is stored, not accepted as a default", () => {
    const r = splitAnswers("3: the platform team", DECISIONS);
    expect("answers" in r && r.answers[2]).toEqual({ question: "Who owns the gate?", answer: "the platform team", accepted_default: false });
  });

  it("refuses a line whose N is not a decision, a repeated N, and an empty answer, naming it", () => {
    expect(splitAnswers("4: x", DECISIONS)).toEqual({ refuse: expect.stringContaining("`4:` names no decision") });
    expect(splitAnswers("0: x", DECISIONS)).toEqual({ refuse: expect.stringContaining("`0:` names no decision") });
    expect(splitAnswers("1: a\n1: b", DECISIONS)).toEqual({ refuse: expect.stringContaining("decision 1 is answered twice") });
    expect(splitAnswers("2:   ", DECISIONS)).toEqual({ refuse: expect.stringContaining("decision 2 is empty") });
  });

  it("a spec with no decisions keeps the whole note, N: lines too, and stores no answers", () => {
    expect(splitAnswers("1: not an answer", [])).toEqual({ note: "1: not an answer", answers: [] });
    expect(splitAnswers(null, [])).toEqual({ note: null, answers: [] });
    expect(answersDetail([])).toEqual({});
  });
});

describe("autoApprovalDetail", () => {
  it("keeps the base and the numeric decisions count, and stores each default as an accepted answer", () => {
    const d = autoApprovalDetail({ approved_by: "system:auto", mode_change: 7 }, DECISIONS.slice(0, 2));
    expect(d).toMatchObject({ approved_by: "system:auto", mode_change: 7, decisions: 2 });
    expect(storedAnswers(d)).toEqual([
      { question: "Fail the job, or only warn?", answer: "Fail the job", accepted_default: true },
      { question: "Name the step?", answer: "scope", accepted_default: true },
    ]);
  });

  it("with no decisions: a count of 0 and no answers", () => {
    expect(autoApprovalDetail({ approved_by: "system:auto", mode_change: 7 }, [])).toEqual({ approved_by: "system:auto", mode_change: 7, decisions: 0 });
  });
});

describe("decisionsSection", () => {
  const approved = (detail: Record<string, unknown> | null) => ({ reason: "spec_approved", detail });

  it("lists each question, its answer and whether the default was accepted, labelled untrusted and fenced", () => {
    const r = splitAnswers("1: Only warn", DECISIONS);
    if (!("answers" in r)) throw new Error("refused");
    const s = decisionsSection([{ reason: "triaged", detail: null }, approved(answersDetail(r.answers))], fence);
    expect(s.startsWith("## Decisions for the spec\n")).toBe(true);
    expect(s).toContain("Untrusted text");
    const body = s.slice(s.indexOf("```"));
    expect(body).toContain("1. Fail the job, or only warn?\n   Answer: Only warn (not the default)");
    expect(body).toContain("2. Name the step?\n   Answer: scope (the default, accepted)");
    expect(body).toContain("3. Who owns the gate?\n   Answer: (none) (no answer and no default)");
  });

  it("is empty when the latest approval has no answers, or there is none", () => {
    expect(decisionsSection([], fence)).toBe("");
    expect(decisionsSection([approved({ note: "x" })], fence)).toBe("");
    expect(decisionsSection([approved({ answers: "not json" })], fence)).toBe("");
  });

  it("imports nothing outside src/shared/", () => {
    const text = readFileSync(new URL("../src/shared/command-notes.ts", import.meta.url), "utf8");
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(imports.filter((s) => !s.startsWith("./"))).toEqual([]);
  });
});
