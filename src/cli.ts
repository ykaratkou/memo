#!/usr/bin/env bun

import { insertMemory, searchMemories } from "./db.ts";
import { embedForSearch, embedForStorage } from "./embed.ts";

const USAGE = `memo - persist memory between LLM agent sessions

Usage:
  memo add <text>       Store a memory
  memo search <query>   Search memories (returns top 5)

Examples:
  memo add "The user prefers dark mode and uses vim keybindings"
  memo search "editor preferences"
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const text = rest.join(" ");

  switch (command) {
    case "add": {
      if (!text) {
        console.error("Error: no text provided.\n\nUsage: memo add <text>");
        process.exit(1);
      }
      const embedding = await embedForStorage(text);
      insertMemory(text, embedding);
      console.log("Stored.");
      break;
    }

    case "search": {
      if (!text) {
        console.error(
          "Error: no query provided.\n\nUsage: memo search <query>",
        );
        process.exit(1);
      }
      const queryEmbedding = await embedForSearch(text);
      const results = searchMemories(queryEmbedding);
      if (results.length === 0) {
        console.log("No memories found.");
      } else {
        for (const r of results) {
          console.log(`[${r.score.toFixed(3)}] ${r.content}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
