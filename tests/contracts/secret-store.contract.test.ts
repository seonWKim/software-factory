import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe } from "vitest";
import type { SecretName } from "../../src/interfaces/secret-store.js";
import { EnvFileSecretStore } from "../../src/impl/secrets/env-file-secret-store.js";
import { MemorySecretStore } from "../helpers/fakes/secrets.js";
import { type MakeSecretStore, secretStoreContract } from "./secret-store.contract.js";

// Temp files only: never the owner's secret file.
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const IMPLEMENTATIONS: { name: string; make: MakeSecretStore }[] = [
  {
    name: "EnvFileSecretStore",
    make: async ({ declared, undeclared }) => {
      const dir = await mkdtemp(join(tmpdir(), "sf-secret-contract-"));
      dirs.push(dir);
      const file = join(dir, ".env");
      const lines = Object.entries({ ...declared, ...undeclared }).map(([k, v]) => `${k}=${v}`);
      await writeFile(file, `# contract fixture\n${lines.join("\n")}\n`, { mode: 0o600 });
      return new EnvFileSecretStore(file, Object.keys(declared) as SecretName[]);
    },
  },
  {
    name: "MemorySecretStore",
    make: async ({ declared, undeclared }) => new MemorySecretStore({ ...declared, ...undeclared }, Object.keys(declared) as SecretName[]),
  },
];

describe.each(IMPLEMENTATIONS)("SecretStore contract: $name", ({ make }) => {
  secretStoreContract(make);
});
