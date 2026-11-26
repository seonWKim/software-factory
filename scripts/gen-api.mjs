// `npm run gen:api`: writes docs/api/openapi.json (the OpenAPI document) and web/src/api/generated.ts (the typed
// client) from the capability declarations in src/api/index.ts (design 09-api-registry). It loads the TypeScript
// source with Node's type stripping, so it needs no build; a resolve hook maps the sources' `.js` imports to their
// `.ts` files. tests/api-openapi.test.ts and tests/api-registry.test.ts fail while either file differs from what this
// script would write.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");

const HOOK = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

const src = (p) => pathToFileURL(join(ROOT, "src", "api", p)).href;
const { REGISTRY } = await import(src("index.ts"));
const { clientText, openApiText } = await import(src("registry.ts"));

const outputs = [
  [join(ROOT, "docs", "api", "openapi.json"), openApiText(REGISTRY)],
  [join(ROOT, "web", "src", "api", "generated.ts"), clientText(REGISTRY)],
];

for (const [file, text] of outputs) {
  if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${file}`);
}
