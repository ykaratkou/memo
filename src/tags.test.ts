import { describe, it, expect } from "bun:test";
import { getProjectInfo } from "./tags.ts";

describe("getProjectInfo", () => {
  it("returns project info for the current git repo", () => {
    const info = getProjectInfo(process.cwd());
    expect(info.tag).toMatch(/^memo_project_[0-9a-f]{16}$/);
    expect(info.projectName).toBe("memo");
    expect(info.projectPath).toBe(process.cwd());
    expect(info.gitRepoUrl).toBeDefined();
  });

  it("produces a deterministic tag for the same directory", () => {
    const info1 = getProjectInfo(process.cwd());
    const info2 = getProjectInfo(process.cwd());
    expect(info1.tag).toBe(info2.tag);
  });

  it("handles non-git directory gracefully", () => {
    const tmpDir = require("node:os").tmpdir();
    const info = getProjectInfo(tmpDir);
    expect(info.tag).toMatch(/^memo_project_[0-9a-f]{16}$/);
    expect(info.projectPath).toBe(tmpDir);
    expect(info.gitRepoUrl).toBeUndefined();
  });

  it("extracts project name from path", () => {
    const info = getProjectInfo("/some/path/my-project");
    expect(info.projectName).toBe("my-project");
  });
});
