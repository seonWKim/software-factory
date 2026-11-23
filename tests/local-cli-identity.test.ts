import { describe, expect, it } from "vitest";
import { cliUserConfig } from "../src/core/config.js";
import { CLI_TOP_WORDS, cliIdentity, parseLocalCliArgs } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { COMMAND_TABLE } from "../src/core/command-table.js";
import { USER, setup } from "./helpers/local-cli.js";

describe("the CLI identity", () => {
  it("is cli_user when set, else local:<git user.email>, else local:<OS user>, else local:anonymous", () => {
    expect(cliIdentity(USER, { gitEmail: "a@b.c", osUser: "kim" })).toEqual({ user: USER, from: "cli_user" });
    expect(cliIdentity(null, { gitEmail: " A@B.c\n", osUser: "kim" })).toEqual({ user: "local:a@b.c", from: "git user.email" });
    expect(cliIdentity(null, { gitEmail: null, osUser: "kim" })).toEqual({ user: "local:kim", from: "OS user" });
    expect(cliIdentity(null, { gitEmail: "", osUser: "two words" })).toEqual({ user: "local:anonymous", from: "anonymous" });
    expect(cliIdentity(null, { gitEmail: null, osUser: null })).toEqual({ user: "local:anonymous", from: "anonymous" });
  });

  it("cli_user is optional: absent is null, a factory user ID is kept, anything else throws", () => {
    expect(cliUserConfig({})).toBeNull();
    expect(cliUserConfig({ cli_user: "github:12345" })).toBe("github:12345");
    expect(() => cliUserConfig({ cli_user: "alice" })).toThrow("cli_user must be a factory user ID");
    expect(() => cliUserConfig({ cli_user: 5 })).toThrow("cli_user");
  });
});

describe("the owner", () => {
  it("the first identity to write becomes the owner; a second one does not", async () => {
    const { store, run, as } = await setup("local:me@example.com" as UserId);
    expect(await store.getOwner()).toBeNull();
    expect((await run({ action: "list" })).code).toBe(0);
    expect(await store.getOwner()).toBeNull();
    await run({ action: "create", title: "t", bodyFile: "b" });
    await as("local:dev@example.com")({ action: "create", title: "t", bodyFile: "b" });
    expect(await store.getOwner()).toBe("local:me@example.com");
  });

  it("anonymous may create, list and show but never becomes the owner", async () => {
    const { store, run } = await setup("local:anonymous" as UserId, "anonymous");
    const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    expect((await store.getWorkItem(id))!.requester_id).toBe("local:anonymous");
    expect((await run({ action: "show", id })).code).toBe(0);
    expect(await store.getOwner()).toBeNull();
  });

  it("`factory users` is gone: `users list` (and every users verb) is an unknown command", () => {
    for (const args of [["list"], ["add", "local:a@b.c", "--role", "approver"], ["remove", "local:a@b.c"]]) {
      expect(parseLocalCliArgs("users", args)).toEqual({ error: expect.stringContaining('unknown command "users"') });
    }
    expect(CLI_TOP_WORDS).not.toContain("users");
    expect(COMMAND_TABLE.filter((c) => c.name.startsWith("users"))).toEqual([]);
  });
});
