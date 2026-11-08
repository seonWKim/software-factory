// How setup asks: every question shows its default, and Enter takes it. `--yes` takes every default without
// asking (scripts, tests). Secrets are never asked here: they have no default and use the hidden prompt.

import { createInterface } from "node:readline/promises";

export interface Ask {
  /** False under `--yes`: steps that need a typed value with no default (a secret) are skipped. */
  readonly interactive: boolean;
  /** One of `options`; the default is marked. */
  choose<T extends string>(question: string, options: readonly T[], dflt: T): Promise<T>;
  yesNo(question: string, dflt: boolean): Promise<boolean>;
  /** Free text; `check` returns why an answer is refused, and the question is asked again. */
  text(question: string, dflt: string, check?: (answer: string) => string | null): Promise<string>;
}

/** `--yes`: every answer is the default, printed so the log shows what was taken. */
export function defaultsAsk(print: (line: string) => void = console.log): Ask {
  return {
    interactive: false,
    async choose(question, _options, dflt) {
      print(`${question} ${dflt}`);
      return dflt;
    },
    async yesNo(question, dflt) {
      print(`${question} ${dflt ? "yes" : "no"}`);
      return dflt;
    },
    async text(question, dflt) {
      print(`${question} ${dflt}`);
      return dflt;
    },
  };
}

/** Questions on a terminal; each line read through `readLine` (one readline per question, so hidden input still works). */
export function terminalAsk(readLine: (prompt: string) => Promise<string> = readTerminalLine, print: (line: string) => void = console.log): Ask {
  return {
    interactive: true,
    async choose(question, options, dflt) {
      const shown = options.map((o) => (o === dflt ? `[${o}]` : o)).join(" / ");
      for (;;) {
        const a = (await readLine(`${question} ${shown}: `)).trim().toLowerCase();
        if (a === "") return dflt;
        const exact = options.find((o) => o.toLowerCase() === a);
        const prefixed = options.filter((o) => o.toLowerCase().startsWith(a));
        if (exact !== undefined) return exact;
        if (prefixed.length === 1) return prefixed[0]!;
        print(`   answer one of: ${options.join(", ")}`);
      }
    },
    async yesNo(question, dflt) {
      for (;;) {
        const a = (await readLine(`${question} ${dflt ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        if (a === "") return dflt;
        if (a === "y" || a === "yes") return true;
        if (a === "n" || a === "no") return false;
        print("   answer y or n");
      }
    },
    async text(question, dflt, check) {
      for (;;) {
        const a = (await readLine(`${question}${dflt ? ` [${dflt}]` : ""}: `)).trim();
        const answer = a === "" ? dflt : a;
        const refused = check?.(answer) ?? null;
        if (refused === null) return answer;
        print(`   ${refused}`);
      }
    },
  };
}

async function readTerminalLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
