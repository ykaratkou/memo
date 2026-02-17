import { findExactDuplicate } from "./db.ts";
import { findNearDuplicates } from "./search.ts";
import { CONFIG } from "./config.ts";

export interface DedupResult {
  isDuplicate: boolean;
  reason?: string;
  existingId?: string;
  similarity?: number;
}

/**
 * Check if content is a duplicate before inserting.
 * Returns info about whether to skip the insert.
 */
export function checkDuplicate(
  content: string,
  vector: Float32Array,
  containerTag: string,
): DedupResult {
  if (!CONFIG.deduplicationEnabled) {
    return { isDuplicate: false };
  }

  // 1. Exact content match
  const exactId = findExactDuplicate(content, containerTag);
  if (exactId) {
    return {
      isDuplicate: true,
      reason: "exact duplicate",
      existingId: exactId,
      similarity: 1.0,
    };
  }

  // 2. Near-duplicate via vector similarity
  const nearDups = findNearDuplicates(
    vector,
    containerTag,
    CONFIG.deduplicationSimilarityThreshold,
  );

  if (nearDups.length > 0) {
    const closest = nearDups[0]!;
    return {
      isDuplicate: true,
      reason: "near duplicate",
      existingId: closest.id,
      similarity: closest.similarity,
    };
  }

  return { isDuplicate: false };
}
