import { getDb } from "./db.ts";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";

export interface SearchResult {
  id: string;
  content: string;
  similarity: number;
  tags: string[];
  createdAt: number;
  displayName?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

export function searchMemories(
  queryVector: Float32Array,
  containerTag: string | null,
  queryText?: string,
  limit?: number,
  threshold?: number,
): SearchResult[] {
  const db = getDb();
  const maxResults = limit ?? CONFIG.maxMemories;
  const minSimilarity = threshold ?? CONFIG.similarityThreshold;
  const queryBuffer = new Uint8Array(queryVector.buffer);

  // KNN search on content vectors
  const k = maxResults * 4;
  const contentResults = db
    .query(
      `SELECT memory_id, distance FROM vec_memories
       WHERE embedding MATCH ? AND k = ${k}
       ORDER BY distance`,
    )
    .all(queryBuffer) as {
    memory_id: string;
    distance: number;
  }[];

  // KNN search on tag vectors
  const tagsResults = db
    .query(
      `SELECT memory_id, distance FROM vec_tags
       WHERE embedding MATCH ? AND k = ${k}
       ORDER BY distance`,
    )
    .all(queryBuffer) as {
    memory_id: string;
    distance: number;
  }[];

  // Combine scores: tag similarity weighted higher
  const scoreMap = new Map<
    string,
    { contentSim: number; tagsSim: number }
  >();

  for (const r of contentResults) {
    scoreMap.set(r.memory_id, { contentSim: 1 - r.distance, tagsSim: 0 });
  }

  for (const r of tagsResults) {
    const entry = scoreMap.get(r.memory_id) || {
      contentSim: 0,
      tagsSim: 0,
    };
    entry.tagsSim = 1 - r.distance;
    scoreMap.set(r.memory_id, entry);
  }

  const ids = Array.from(scoreMap.keys());
  if (ids.length === 0) return [];

  // Fetch memory rows
  const placeholders = ids.map(() => "?").join(",");
  let rows: any[];

  if (containerTag) {
    rows = db
      .query(
        `SELECT id, content, tags, created_at, display_name, project_name, git_repo_url
         FROM memories WHERE id IN (${placeholders}) AND container_tag = ?`,
      )
      .all(...ids, containerTag) as any[];
  } else {
    rows = db
      .query(
        `SELECT id, content, tags, created_at, display_name, project_name, git_repo_url
         FROM memories WHERE id IN (${placeholders})`,
      )
      .all(...ids) as any[];
  }

  // Parse query words for exact tag match boosting
  const queryWords = queryText
    ? queryText
        .toLowerCase()
        .split(/[\s,]+/)
        .filter((w) => w.length > 1)
    : [];

  const results: SearchResult[] = rows.map((row: any) => {
    const scores = scoreMap.get(row.id)!;
    const memoryTags = row.tags
      ? row.tags.split(",").map((t: string) => t.trim().toLowerCase())
      : [];

    // Boost for exact query word <-> tag matches
    let exactMatchBoost = 0;
    if (queryWords.length > 0 && memoryTags.length > 0) {
      const matches = queryWords.filter((w) =>
        memoryTags.some((t: string) => t.includes(w) || w.includes(t)),
      ).length;
      exactMatchBoost = matches / Math.max(queryWords.length, 1);
    }

    const tagSim = Math.max(scores.tagsSim, exactMatchBoost);
    // Content similarity is the base; tags provide a boost
    const similarity = scores.contentSim * 0.7 + tagSim * 0.3;

    return {
      id: row.id,
      content: row.content,
      similarity,
      tags: row.tags ? row.tags.split(",") : [],
      createdAt: row.created_at,
      displayName: row.display_name,
      projectName: row.project_name,
      gitRepoUrl: row.git_repo_url,
    };
  });

  results.sort((a, b) => b.similarity - a.similarity);
  return results
    .filter((r) => r.similarity >= minSimilarity)
    .slice(0, maxResults);
}

/**
 * Find near-duplicates of given text vector within a container.
 * Returns memory IDs with similarity above the dedup threshold.
 */
export function findNearDuplicates(
  queryVector: Float32Array,
  containerTag: string,
  threshold: number,
): { id: string; similarity: number }[] {
  const db = getDb();
  const queryBuffer = new Uint8Array(queryVector.buffer);

  const results = db
    .query(
      `SELECT memory_id, distance FROM vec_memories
       WHERE embedding MATCH ? AND k = 5
       ORDER BY distance`,
    )
    .all(queryBuffer) as { memory_id: string; distance: number }[];

  const candidates: { id: string; similarity: number }[] = [];

  for (const r of results) {
    const sim = 1 - r.distance;
    if (sim >= threshold) {
      // Verify it belongs to the same container
      const row = db
        .query(
          "SELECT id FROM memories WHERE id = ? AND container_tag = ?",
        )
        .get(r.memory_id, containerTag) as any;
      if (row) {
        candidates.push({ id: r.memory_id, similarity: sim });
      }
    }
  }

  return candidates;
}
