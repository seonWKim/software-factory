import { randomBytes } from "node:crypto";
import type { UserId } from "../../core/types.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";

// One-time link codes (design 2026-11-01, issue #107). `factory link-code <user_id>` prints one; the other
// account sends `/link <code>`. The store keeps only a hash.

/** 32 letters and digits without I, O, 0 and 1, so a code read aloud or retyped is not misread. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 10;

/** What a code looks like: 10 characters, 50 random bits. */
export const LINK_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;

/** A fresh random code. 256 is a multiple of 32, so every character is equally likely. */
export function newLinkCode(): string {
  return [...randomBytes(LENGTH)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** A factory user ID: `<provider>:<subject>`, e.g. `github:12345`. */
const USER_ID = /^[a-z]+:\S+$/;

/** `factory link-code <user_id>`: stores a new code for the user and returns the text to print. */
export async function linkCodeCommand(store: Pick<FactoryStore, "createLinkCode">, args: readonly string[]): Promise<string> {
  const [user] = args;
  if (!user) throw new Error("usage: factory link-code <user_id>   (a factory user ID such as github:12345)");
  if (!USER_ID.test(user)) throw new Error(`not a factory user_id: ${JSON.stringify(user)} (expected <provider>:<id>, e.g. github:12345)`);
  const code = newLinkCode();
  const { expires_at } = await store.createLinkCode(user as UserId, code);
  return [
    `Link code for ${user}. From the account to link, post this as a comment on any issue of the repository:`,
    "",
    `  /link ${code}`,
    "",
    `It works once and expires in 10 minutes (at ${expires_at}); 5 wrong codes lock it. It is not shown again.`,
  ].join("\n");
}
