import { describe, it, expect } from "bun:test";
import { stripJsoncComments } from "./jsonc.ts";

describe("stripJsoncComments", () => {
  it("strips single-line comments", () => {
    const input = '{\n  "key": "value" // this is a comment\n}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ key: "value" });
  });

  it("strips multi-line comments", () => {
    const input = '{\n  /* comment */\n  "key": "value"\n}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ key: "value" });
  });

  it("strips multi-line comments spanning lines", () => {
    const input = '{\n  /*\n   * block\n   */\n  "key": "value"\n}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ key: "value" });
  });

  it("preserves URLs inside strings", () => {
    const input = '{"url": "https://example.com"}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ url: "https://example.com" });
  });

  it("preserves // inside strings", () => {
    const input = '{"path": "C://foo//bar"}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ path: "C://foo//bar" });
  });

  it("handles escaped quotes in strings", () => {
    const input = '{"key": "value with \\"quotes\\""}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ key: 'value with "quotes"' });
  });

  it("removes trailing commas", () => {
    const input = '{"a": 1, "b": 2,}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing commas in arrays", () => {
    const input = '{"arr": [1, 2, 3,]}';
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ arr: [1, 2, 3] });
  });

  it("handles empty input", () => {
    expect(stripJsoncComments("")).toBe("");
  });

  it("handles content with only comments", () => {
    const input = "// just a comment\n/* another */";
    const stripped = stripJsoncComments(input).trim();
    expect(stripped).toBe("");
  });

  it("handles mixed comments and trailing commas", () => {
    const input = `{
  // database settings
  "host": "localhost", // server host
  "port": 5432, /* default port */
  "options": {
    "ssl": true,
  },
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({
      host: "localhost",
      port: 5432,
      options: { ssl: true },
    });
  });
});
