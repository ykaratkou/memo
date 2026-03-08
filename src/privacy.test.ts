import { describe, it, expect } from "bun:test";
import { stripPrivateContent, isFullyPrivate } from "./privacy.ts";

describe("stripPrivateContent", () => {
  it("removes a single private block", () => {
    const input = "Hello <private>secret</private> world";
    expect(stripPrivateContent(input)).toBe("Hello [REDACTED] world");
  });

  it("removes multiple private blocks", () => {
    const input = "<private>a</private> gap <private>b</private>";
    expect(stripPrivateContent(input)).toBe("[REDACTED] gap [REDACTED]");
  });

  it("is case-insensitive", () => {
    expect(stripPrivateContent("<PRIVATE>x</PRIVATE>")).toBe("[REDACTED]");
    expect(stripPrivateContent("<Private>x</Private>")).toBe("[REDACTED]");
  });

  it("handles multiline private content", () => {
    const input = "before\n<private>\nline1\nline2\n</private>\nafter";
    expect(stripPrivateContent(input)).toBe("before\n[REDACTED]\nafter");
  });

  it("returns content unchanged when no private tags", () => {
    const input = "just normal text";
    expect(stripPrivateContent(input)).toBe("just normal text");
  });

  it("handles empty string", () => {
    expect(stripPrivateContent("")).toBe("");
  });

  it("handles empty private tags", () => {
    expect(stripPrivateContent("<private></private>")).toBe("[REDACTED]");
  });
});

describe("isFullyPrivate", () => {
  it("returns true when content is entirely private", () => {
    expect(isFullyPrivate("<private>secret</private>")).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(isFullyPrivate("")).toBe(true);
  });

  it("returns true when only whitespace surrounds private content", () => {
    // After strip: "  [REDACTED]  ", after trim: "[REDACTED]" -> fully private
    expect(isFullyPrivate("  <private>x</private>  ")).toBe(true);
  });

  it("returns false when non-private content remains", () => {
    expect(isFullyPrivate("visible <private>hidden</private>")).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(isFullyPrivate("just normal text")).toBe(false);
  });
});
