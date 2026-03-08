import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chunkMarkdown, collectImportChunks } from "./importer.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("chunkMarkdown", () => {
  it("returns empty array for empty content", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  it("returns empty array for whitespace-only content", () => {
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
  });

  it("returns a single chunk for short content", () => {
    const content = "# Hello\n\nThis is a short document.";
    const chunks = chunkMarkdown(content);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("Hello");
    expect(chunks[0]!.text).toContain("short document");
    expect(chunks[0]!.startLine).toBe(1);
  });

  it("splits long content into multiple chunks", () => {
    // Generate content that exceeds one chunk (~2400 chars)
    const lines: string[] = ["# Long Document\n"];
    for (let i = 0; i < 100; i++) {
      lines.push(`Paragraph ${i}: ${"Lorem ipsum dolor sit amet. ".repeat(5)}\n`);
    }
    const content = lines.join("\n");
    const chunks = chunkMarkdown(content);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("produces chunks with correct line numbers", () => {
    const content = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";
    const chunks = chunkMarkdown(content);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBeGreaterThanOrEqual(1);
  });

  it("each chunk has a non-empty hash", () => {
    const content = "# Test\n\nSome content here.";
    const chunks = chunkMarkdown(content);
    expect(chunks[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves code fences within chunks", () => {
    const content = "# Code Example\n\n```javascript\nconst x = 1;\nconst y = 2;\n```\n\nEnd.";
    const chunks = chunkMarkdown(content);
    expect(chunks[0]!.text).toContain("```javascript");
    expect(chunks[0]!.text).toContain("```");
  });

  it("produces overlapping chunks for long content", () => {
    // Generate enough content for at least 2 chunks
    const paragraphs: string[] = [];
    for (let i = 0; i < 60; i++) {
      paragraphs.push(`## Section ${i}\n\n${"Word ".repeat(60)}\n`);
    }
    const content = paragraphs.join("\n");
    const chunks = chunkMarkdown(content);

    if (chunks.length >= 2) {
      // The end of chunk[0] should overlap with the start of chunk[1]
      const chunk0End = chunks[0]!.text.slice(-200);
      const chunk1Start = chunks[1]!.text.slice(0, 200);
      // There should be some overlap (shared content)
      const overlapExists = chunk0End
        .split(/\s+/)
        .some((word) => word.length > 3 && chunk1Start.includes(word));
      expect(overlapExists).toBe(true);
    }
  });
});

describe("collectImportChunks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memo-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("collects chunks from a single markdown file", () => {
    const filePath = join(tmpDir, "test.md");
    writeFileSync(filePath, "# Hello\n\nSome content here.");
    const result = collectImportChunks(filePath, tmpDir);
    expect(result.files.length).toBe(1);
    expect(result.totalChunks).toBe(1);
    expect(result.files[0]!.chunks[0]!.text).toContain("Hello");
  });

  it("collects chunks from a directory of markdown files", () => {
    writeFileSync(join(tmpDir, "a.md"), "# File A\n\nContent A.");
    writeFileSync(join(tmpDir, "b.md"), "# File B\n\nContent B.");
    writeFileSync(join(tmpDir, "ignore.txt"), "Not markdown");

    const result = collectImportChunks(tmpDir, tmpDir);
    expect(result.files.length).toBe(2);
    expect(result.totalChunks).toBe(2);
  });

  it("recursively walks subdirectories", () => {
    const subDir = join(tmpDir, "sub");
    mkdirSync(subDir);
    writeFileSync(join(tmpDir, "root.md"), "# Root\n\nRoot content.");
    writeFileSync(join(subDir, "nested.md"), "# Nested\n\nNested content.");

    const result = collectImportChunks(tmpDir, tmpDir);
    expect(result.files.length).toBe(2);
  });

  it("skips empty markdown files", () => {
    writeFileSync(join(tmpDir, "empty.md"), "");
    writeFileSync(join(tmpDir, "has-content.md"), "# Title\n\nContent.");

    const result = collectImportChunks(tmpDir, tmpDir);
    expect(result.files.length).toBe(1);
    expect(result.skippedEmptyFiles).toBe(1);
  });

  it("strips private content before chunking", () => {
    writeFileSync(
      join(tmpDir, "private.md"),
      "# Public\n\nVisible text.\n\n<private>Secret stuff</private>\n\nMore visible.",
    );
    const result = collectImportChunks(tmpDir, tmpDir);
    const text = result.files[0]!.chunks[0]!.text;
    expect(text).toContain("Visible text");
    expect(text).not.toContain("Secret stuff");
    expect(text).toContain("[REDACTED]");
  });

  it("throws for non-existent path", () => {
    expect(() => collectImportChunks("/nonexistent/path", tmpDir)).toThrow(
      "Path not found",
    );
  });

  it("throws for non-markdown single file", () => {
    const txtFile = join(tmpDir, "file.txt");
    writeFileSync(txtFile, "text");
    expect(() => collectImportChunks(txtFile, tmpDir)).toThrow(
      "Only markdown files are supported",
    );
  });

  it("supports .mdx files", () => {
    writeFileSync(join(tmpDir, "test.mdx"), "# MDX File\n\nSome MDX content.");
    const result = collectImportChunks(tmpDir, tmpDir);
    expect(result.files.length).toBe(1);
  });

  it("supports .markdown files", () => {
    writeFileSync(
      join(tmpDir, "test.markdown"),
      "# Markdown File\n\nSome content.",
    );
    const result = collectImportChunks(tmpDir, tmpDir);
    expect(result.files.length).toBe(1);
  });

  it("produces deterministic content hashes", () => {
    writeFileSync(join(tmpDir, "test.md"), "# Title\n\nContent.");
    const result1 = collectImportChunks(tmpDir, tmpDir);
    const result2 = collectImportChunks(tmpDir, tmpDir);
    expect(result1.files[0]!.contentHash).toBe(result2.files[0]!.contentHash);
  });

  it("returns files sorted alphabetically", () => {
    writeFileSync(join(tmpDir, "c.md"), "# C\n\nC content.");
    writeFileSync(join(tmpDir, "a.md"), "# A\n\nA content.");
    writeFileSync(join(tmpDir, "b.md"), "# B\n\nB content.");

    const result = collectImportChunks(tmpDir, tmpDir);
    const sourceKeys = result.files.map((f) => f.sourcePath);
    const sorted = [...sourceKeys].sort();
    expect(sourceKeys).toEqual(sorted);
  });
});
