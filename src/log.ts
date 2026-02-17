import {
  appendFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".config", "memo");
const LOG_FILE = join(LOG_DIR, "memo.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let initialized = false;

function rotateLog(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const stats = statSync(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) return;
    const oldLog = LOG_FILE + ".old";
    if (existsSync(oldLog)) unlinkSync(oldLog);
    renameSync(LOG_FILE, oldLog);
  } catch {
    // ignore rotation errors
  }
}

function ensureInitialized(): void {
  if (initialized) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  rotateLog();
  writeFileSync(LOG_FILE, `\n--- Session started: ${new Date().toISOString()} ---\n`, {
    flag: "a",
  });
  initialized = true;
}

export function log(message: string, data?: unknown): void {
  ensureInitialized();
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  appendFileSync(LOG_FILE, line);
}
