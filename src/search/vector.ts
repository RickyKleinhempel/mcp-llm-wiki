import type { Db } from "../db/open.js";
import { hasTable } from "../db/schema.js";
import { buildFilterSql, type SearchFilters } from "./bm25.js";

export interface VectorHit {
  chunkId: number;
  distance: number;
}

/**
 * Cosine KNN over the vec0 table.
 *
 * vec0 cannot apply arbitrary joins inside its KNN scan, so the query
 * over-fetches and the metadata filter is applied afterwards.
 */
export function searchVector(db: Db, embedding: Float32Array, limit: number, filters: SearchFilters): VectorHit[] {
  if (!hasTable(db, "chunk_vec")) return [];

  const overfetch = Math.min(Math.max(limit * 8, limit + 20), 2000);
  const candidates = db
    .prepare(
      `SELECT chunk_id AS chunkId, distance
         FROM chunk_vec
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance`,
    )
    .all(embedding, overfetch) as VectorHit[];

  if (candidates.length === 0) return [];

  const filter = buildFilterSql(filters);
  const placeholders = candidates.map(() => "?").join(",");
  const allowed = new Set(
    (
      db
        .prepare(
          `SELECT c.id AS id
             FROM chunks c
             JOIN files f ON f.id = c.file_id
            WHERE c.id IN (${placeholders}) AND ${filter.sql}`,
        )
        .all(...candidates.map((c) => c.chunkId), ...filter.params) as { id: number }[]
    ).map((row) => row.id),
  );

  return candidates.filter((candidate) => allowed.has(candidate.chunkId)).slice(0, limit);
}
