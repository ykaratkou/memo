import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { stripPrivateContent } from "./privacy.ts";

// ── Chunking constants ──────────────────────────────────────────

const DEFAULT_CHUNK_TOKENS = 600;
const DEFAULT_OVERLAP_TOKENS = 90; // 15% of chunk size
const WINDOW_TOKENS = 150; // ~25% look-back window for finding break points

// Character estimates (~4 chars per token)
const CHUNK_SIZE_CHARS = DEFAULT_CHUNK_TOKENS * 4;
const OVERLAP_CHARS = DEFAULT_OVERLAP_TOKENS * 4;
const WINDOW_CHARS = WINDOW_TOKENS * 4;

// ── Types ───────────────────────────────────────────────────────

export interface ImportChunk {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

export interface ImportFile {
  sourceKey: string;
  sourcePath: string;
  contentHash: string;
  chunks: ImportChunk[];
}

export interface ImportResult {
  inputPath: string;
  files: ImportFile[];
  totalChunks: number;
  skippedEmptyFiles: number;
}

interface BreakPoint {
  pos: number;   // character position in text
  score: number; // higher = better break point
}

interface CodeFenceRegion {
  start: number; // position of opening ```
  end: number;   // position after closing ```
}

// ── Break point scoring ─────────────────────────────────────────
//
// Patterns and scores for natural markdown break points.
// Higher score = stronger break signal. Matched against the
// normalized text (LF only, no CRLF).

const BREAK_PATTERNS: [RegExp, number][] = [
  [/\n#{1}(?!#)/g, 100],                  // # H1
  [/\n#{2}(?!#)/g, 90],                   // ## H2
  [/\n#{3}(?!#)/g, 80],                   // ### H3
  [/\n#{4}(?!#)/g, 70],                   // #### H4
  [/\n#{5}(?!#)/g, 60],                   // ##### H5
  [/\n#{6}(?!#)/g, 50],                   // ###### H6
  [/\n```/g, 80],                         // code fence boundary
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60],     // horizontal rule
  [/\n\n+/g, 20],                         // blank line (paragraph boundary)
  [/\n[-*]\s/g, 5],                       // unordered list item
  [/\n\d+\.\s/g, 5],                      // ordered list item
  [/\n/g, 1],                             // plain newline (minimal break)
];

/**
 * Pre-scan the full document for all break points.
 * When multiple patterns match the same position, keep the highest score.
 * Returns break points sorted by position.
 */
function scanBreakPoints(text: string): BreakPoint[] {
  const best = new Map<number, number>(); // pos -> highest score

  for (const [pattern, score] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index!;
      const existing = best.get(pos);
      if (existing === undefined || score > existing) {
        best.set(pos, score);
      }
    }
  }

  const points: BreakPoint[] = [];
  for (const [pos, score] of best) {
    points.push({ pos, score });
  }
  return points.sort((a, b) => a.pos - b.pos);
}

/**
 * Find paired code fence regions (``` ... ```).
 * Break points inside these regions will be skipped so code blocks
 * are not split across chunks.
 */
function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const fencePattern = /\n```/g;
  let inFence = false;
  let fenceStart = 0;

  for (const match of text.matchAll(fencePattern)) {
    if (!inFence) {
      fenceStart = match.index!;
      inFence = true;
    } else {
      regions.push({ start: fenceStart, end: match.index! + match[0].length });
      inFence = false;
    }
  }

  // Unclosed fence extends to end of document
  if (inFence) {
    regions.push({ start: fenceStart, end: text.length });
  }

  return regions;
}

function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some((f) => pos > f.start && pos < f.end);
}

/**
 * Search a window before `targetPos` for the best markdown break point.
 *
 * Each candidate is scored with squared distance decay:
 *   finalScore = baseScore * (1 - (distance / window)^2 * 0.7)
 *
 * This means a heading 150 tokens back (score ~30) still beats a plain
 * newline at the exact target (score 1), but a closer heading always
 * beats a farther one of the same level.
 */
function findBestCutoff(
  breakPoints: BreakPoint[],
  targetPos: number,
  windowChars: number,
  codeFences: CodeFenceRegion[],
): number {
  const windowStart = targetPos - windowChars;
  let bestScore = -1;
  let bestPos = targetPos;

  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue;
    if (bp.pos > targetPos) break; // sorted, so we can stop

    // Skip break points inside code fences
    if (isInsideCodeFence(bp.pos, codeFences)) continue;

    const distance = targetPos - bp.pos;
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - normalizedDist * normalizedDist * 0.7;
    const finalScore = bp.score * multiplier;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPos = bp.pos;
    }
  }

  return bestPos;
}

/**
 * Map a character position to a 1-based line number.
 */
function charPosToLine(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

// ── Helpers ─────────────────────────────────────────────────────

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

// ── Public API ──────────────────────────────────────────────────

/**
 * Smart markdown-aware chunking.
 *
 * Instead of cutting at hard token boundaries, uses a scoring system
 * to find natural break points (headings, code fences, blank lines, etc.)
 * within a look-back window. Code blocks are protected from splitting.
 *
 * Returns chunks with start/end line numbers and SHA-256 hashes.
 */
export function chunkMarkdown(content: string): ImportChunk[] {
  const text = content.replace(/\r\n/g, "\n");
  if (text.length === 0) return [];

  // Small documents: single chunk
  if (text.length <= CHUNK_SIZE_CHARS) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];
    const endLine = charPosToLine(text, text.length - 1);
    return [{ startLine: 1, endLine, text: trimmed, hash: hashText(trimmed) }];
  }

  // Pre-scan the entire document once
  const breakPoints = scanBreakPoints(text);
  const codeFences = findCodeFences(text);

  const chunks: ImportChunk[] = [];
  let charPos = 0;

  while (charPos < text.length) {
    const targetEnd = Math.min(charPos + CHUNK_SIZE_CHARS, text.length);
    let endPos = targetEnd;

    // If not at the end, find the best break point in the window
    if (endPos < text.length) {
      const bestCutoff = findBestCutoff(breakPoints, targetEnd, WINDOW_CHARS, codeFences);

      if (bestCutoff > charPos && bestCutoff <= targetEnd) {
        endPos = bestCutoff;
      }
    }

    // Ensure we make progress
    if (endPos <= charPos) {
      endPos = Math.min(charPos + CHUNK_SIZE_CHARS, text.length);
    }

    const chunkText = text.slice(charPos, endPos).trim();
    if (chunkText.length > 0) {
      const startLine = charPosToLine(text, charPos);
      const endLine = charPosToLine(text, endPos - 1);
      chunks.push({
        startLine,
        endLine,
        text: chunkText,
        hash: hashText(chunkText),
      });
    }

    if (endPos >= text.length) break;

    // Move forward with overlap
    const nextPos = endPos - OVERLAP_CHARS;
    charPos = nextPos <= charPos ? endPos : nextPos;
  }

  return chunks;
}

export function collectImportChunks(inputPath: string, cwd: string): ImportResult {
  const resolvedInput = resolve(cwd, inputPath);

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
    const chunks = chunkMarkdown(sanitized);

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

    const relPath = relative(cwd, filePath);
    const sourcePath = normalizePath(relPath || filePath);

    files.push({
      sourceKey: normalizePath(sourceKey),
      sourcePath,
      contentHash: hashText(sanitized),
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
