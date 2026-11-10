import { describe, expect, it } from "vitest";
import { errorText } from "../src/core/log.js";

describe("errorText", () => {
  it("gives an Error's message", () => {
    expect(errorText(new Error("store busy"))).toBe("store busy");
  });

  it("gives unknown for a non-Error string", () => {
    expect(errorText("store busy")).toBe("unknown");
  });

  it("gives unknown for a non-Error object", () => {
    expect(errorText({ message: "store busy" })).toBe("unknown");
  });

  it("cuts a long message to 300 characters", () => {
    expect(errorText(new Error("x".repeat(400)))).toBe("x".repeat(300));
  });
});
