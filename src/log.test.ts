import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// log.ts uses hardcoded ~/.config/memo paths and module-level state,
// so we test the exported `log` function's behavior end-to-end.
// We can't easily redirect the log file, but we can verify it doesn't throw.

describe("log", () => {
  it("does not throw on a simple message", async () => {
    // Dynamic import to avoid side-effects contaminating other tests
    const { log } = await import("./log.ts");
    expect(() => log("test message")).not.toThrow();
  });

  it("does not throw with data parameter", async () => {
    const { log } = await import("./log.ts");
    expect(() => log("test with data", { key: "value", count: 42 })).not.toThrow();
  });

  it("does not throw with undefined data", async () => {
    const { log } = await import("./log.ts");
    expect(() => log("test no data", undefined)).not.toThrow();
  });
});
