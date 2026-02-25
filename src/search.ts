import { getDb } from "./db.ts";
import { CONFIG } from "./config.ts";
import { log } from "./log.ts";

// RRF constant - standard value used by most implementations
const RRF_K = 60;

export interface SearchResult {
  id: string;
  content: string;
  similarity: number;
  createdAt: number;
  type?: string;
  metadata?: string;
  displayName?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

/**
 * Reciprocal Rank Fusion (RRF)
 * Combines two ranked lists without needing to normalize scores.
 * Items that rank high in both lists naturally rise to the top.
 *
 * Formula: score = sum(1 / (k + rank)) for each list the item appears in
 * k is a constant that dampens the impact of low rankings (standard: 60)
 */
function reciprocalRankFusion(
  vectorRankings: Map<string, number>,
  bm25Rankings: Map<string, number>,
  k: number = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();

  // Add vector contribution
  for (const [id, rank] of vectorRankings.entries()) {
    scores.set(id, 1 / (k + rank));
  }

  // Add BM25 contribution
  for (const [id, rank] of bm25Rankings.entries()) {
    const currentScore = scores.get(id) || 0;
    scores.set(id, currentScore + 1 / (k + rank));
  }

  return scores;
}

interface VectorResult {
  rank: number;
  cosineSim: number;
}

/**
 * Hybrid search: combines vector similarity (semantic) with BM25 (keyword).
 * Uses Reciprocal Rank Fusion (RRF) to combine results without normalizing scores.
 */
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
  const minVectorSim = CONFIG.minVectorSimilarity;
  const queryBuffer = new Uint8Array(queryVector.buffer);

  // KNN vector search — returns nearest neighbors by cosine distance.
  // IMPORTANT: KNN always returns k results regardless of actual similarity.
  // We gate on minVectorSimilarity to drop results that aren't genuinely related.
  const k = maxResults * 4;
  const rawVectorResults = db
    .query(
      `SELECT memory_id, distance FROM vec_memories
       WHERE embedding MATCH ? AND k = ${k}
       ORDER BY distance`,
    )
    .all(queryBuffer) as { memory_id: string; distance: number }[];

  // Filter by minimum cosine similarity and build ranked map
  // cosineSim = 1 - cosineDistance (sqlite-vec uses distance, not similarity)
  const vectorResultMap = new Map<string, VectorResult>();
  let vectorRank = 0;
  for (const r of rawVectorResults) {
    const cosineSim = 1 - r.distance;
    if (cosineSim >= minVectorSim) {
      vectorResultMap.set(r.memory_id, { rank: vectorRank, cosineSim });
      vectorRank++;
    }
  }

  // BM25 keyword search via FTS5
  const bm25Rankings = new Map<string, number>();

  if (queryText && queryText.trim().length > 0) {
    try {
      const bm25Results = containerTag
        ? db.query(
            `SELECT memory_id, rank FROM fts_memories
             WHERE fts_memories MATCH ? AND container_tag = ?
             ORDER BY rank
             LIMIT ?`,
          ).all(queryText, containerTag, maxResults * 4) as { memory_id: string; rank: number }[]
        : db.query(
            `SELECT memory_id, rank FROM fts_memories
             WHERE fts_memories MATCH ?
             ORDER BY rank
             LIMIT ?`,
          ).all(queryText, maxResults * 4) as { memory_id: string; rank: number }[];

      bm25Results.forEach((r, index) => {
        bm25Rankings.set(r.memory_id, index);
      });
    } catch (error) {
      // FTS5 can fail on special characters — fall back to vector-only
      log("FTS5 search failed, falling back to vector only", {
        query: queryText,
        error: String(error),
      });
    }
  }

  // Build vector rankings map (rank only, for RRF)
  const vectorRankings = new Map<string, number>(
    Array.from(vectorResultMap.entries()).map(([id, v]) => [id, v.rank]),
  );

  // Combine rankings using RRF
  const rrfScores = reciprocalRankFusion(vectorRankings, bm25Rankings);

  if (rrfScores.size === 0) return [];

  // Fetch memory rows for all candidates
  const ids = Array.from(rrfScores.keys());
  const placeholders = ids.map(() => "?").join(",");
  let rows: any[];

  if (containerTag) {
    rows = db
      .query(
        `SELECT id, content, type, metadata, created_at, display_name, project_name, git_repo_url
         FROM memories WHERE id IN (${placeholders}) AND container_tag = ?`,
      )
      .all(...ids, containerTag) as any[];
  } else {
    rows = db
      .query(
        `SELECT id, content, type, metadata, created_at, display_name, project_name, git_repo_url
         FROM memories WHERE id IN (${placeholders})`,
      )
      .all(...ids) as any[];
  }

  // Max possible RRF score: rank #0 in both lists = 1/(k+0) + 1/(k+0) = 2/k
  const maxRrfScore = 2 / RRF_K;

  const results: SearchResult[] = rows.map((row: any) => {
    const rrfScore = rrfScores.get(row.id) || 0;
    const inBm25 = bm25Rankings.has(row.id);
    const vectorInfo = vectorResultMap.get(row.id);

    let similarity: number;

    if (inBm25 && vectorInfo) {
      // Appeared in both lists: full RRF score normalised to 0-1
      similarity = Math.min(rrfScore / maxRrfScore, 1.0);
    } else if (inBm25) {
      // BM25 match only: normalize RRF score (max single-list = 1/k)
      similarity = Math.min(rrfScore / (1 / RRF_K), 1.0);
    } else if (vectorInfo) {
      // Vector match only: use raw cosine similarity directly.
      // This avoids the "0.5 floor" problem where every lone KNN result
      // scores 0.5 regardless of how semantically related it actually is.
      similarity = vectorInfo.cosineSim;
    } else {
      similarity = 0;
    }

    return {
      id: row.id,
      content: row.content,
      similarity,
      createdAt: row.created_at,
      type: row.type || undefined,
      metadata: row.metadata || undefined,
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
