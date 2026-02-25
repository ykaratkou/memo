import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { stripPrivateContent } from "./privacy.ts";

export const DEFAULT_IMPORT_CHUNK_TOKENS = 400;
export const DEFAULT_IMPORT_OVERLAP_TOKENS = 80;

export interface ImportChunk {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

export interface ImportFile {
  sourceKey: string;
  sourcePath: string;
  chunks: ImportChunk[];
}

export interface ImportResult {
  inputPath: string;
  files: ImportFile[];
  totalChunks: number;
  skippedEmptyFiles: number;
}

interface ChunkingOptions {
  chunkTokens: number;
  overlapTokens: number;
}

interface CollectImportOptions extends ChunkingOptions {
  cwd: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isMarkdownFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".md" || extension === ".markdown" || extension === ".mdx";
}

function walkMarkdownFiles(directory: string, files: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, files);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!isMarkdownFile(fullPath)) continue;

    files.push(fullPath);
  }
}

export function chunkMarkdown(content: string, chunking: ChunkingOptions): ImportChunk[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, chunking.chunkTokens * 4);
  const overlapChars = Math.max(0, chunking.overlapTokens * 4);
  const chunks: ImportChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;

    const text = current.map((entry) => entry.line).join("\n");
    chunks.push({
      startLine: first.lineNo,
      endLine: last.lineNo,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }

    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];

    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) continue;

      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }

    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];

    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }

    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }

      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }

  flush();

  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

export function collectImportChunks(inputPath: string, options: CollectImportOptions): ImportResult {
  const resolvedInput = resolve(options.cwd, inputPath);

  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolvedInput);
  } catch {
    throw new Error(`Path not found: ${resolvedInput}`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Symlink paths are not supported: ${resolvedInput}`);
  }

  const markdownFiles: string[] = [];

  if (stats.isDirectory()) {
    walkMarkdownFiles(resolvedInput, markdownFiles);
  } else if (stats.isFile()) {
    if (!isMarkdownFile(resolvedInput)) {
      throw new Error(`Only markdown files are supported: ${resolvedInput}`);
    }
    markdownFiles.push(resolvedInput);
  } else {
    throw new Error(`Unsupported path type: ${resolvedInput}`);
  }

  markdownFiles.sort((a, b) => a.localeCompare(b));

  const files: ImportFile[] = [];
  let skippedEmptyFiles = 0;

  for (const filePath of markdownFiles) {
    const raw = readFileSync(filePath, "utf-8");
    const sanitized = stripPrivateContent(raw);
    const chunks = chunkMarkdown(sanitized, {
      chunkTokens: options.chunkTokens,
      overlapTokens: options.overlapTokens,
    });

    if (chunks.length === 0) {
      skippedEmptyFiles += 1;
      continue;
    }

    let sourceKey = filePath;
    try {
      sourceKey = realpathSync(filePath);
    } catch {
      // best effort only
    }

    const relPath = relative(options.cwd, filePath);
    const sourcePath = normalizePath(relPath || filePath);

    files.push({
      sourceKey: normalizePath(sourceKey),
      sourcePath,
      chunks,
    });
  }

  const totalChunks = files.reduce((sum, file) => sum + file.chunks.length, 0);

  return {
    inputPath: normalizePath(resolvedInput),
    files,
    totalChunks,
    skippedEmptyFiles,
  };
}
