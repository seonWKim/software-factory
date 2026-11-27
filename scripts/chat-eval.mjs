// `npm run eval:chat`: starts scripts/chat-eval.ts (design 04-chat-agent) straight from the TypeScript sources, so the
// run needs no build. A module hook maps each relative `.js` import whose file is not there to its `.ts` source and
// compiles that source with the installed TypeScript (types removed, nothing checked). The exit code is the run's: 1
// below the pass bar of 8, 0 at it or more.

import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const ts_url = new URL(specifier.slice(0, -".js".length) + ".ts", context.parentURL);
      if (!existsSync(fileURLToPath(new URL(specifier, context.parentURL))) && existsSync(fileURLToPath(ts_url))) {
        return { url: ts_url.href, format: "module", shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const { main } = await import(new URL("./chat-eval.ts", import.meta.url).href);
process.exitCode = await main();
