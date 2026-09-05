import type { Db } from "../db/open.js";

/**
 * BM25 retrieval over FTS5.
 *
 * `bm25()` returns *negative* scores (lower is better), which is why results are
 * ordered ascending and the raw value is passed through unchanged - the fusion
 * step only cares about rank, not magnitude.
 */

export interface SearchFilters {
  layer?: "wiki" | "raw";
  folder?: string;
  recursive?: boolean;
  pathPrefix?: string;
  type?: string;
  status?: string;
  tags?: string[];
}

export interface Bm25Hit {
  chunkId: number;
  score: number;
}

/**
 * Turn free text into a safe FTS5 MATCH expression.
 *
 * Every term is wrapped in double quotes (with internal quotes doubled), which
 * neutralises FTS5 operators such as `NEAR`, `*`, `^`, `:` and `-` so a user
 * query can never change the query structure.
 */
export function buildMatchExpression(query: string, mode: "and" | "or"): string | undefined {
  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 32)
    .map((term) => `"${term.replace(/"/g, '""')}"`);

  if (terms.length === 0) return undefined;
  return terms.join(mode === "and" ? " AND " : " OR ");
}

interface FilterSql {
  sql: string;
  params: unknown[];
}

export function buildFilterSql(filters: SearchFilters, alias = "f"): FilterSql {
  const clauses: string[] = [];
  const params: unknown[] = [];

  clauses.push(`${alias}.layer = ?`);
  params.push(filters.layer ?? "wiki");

  if (filters.folder !== undefined) {
    if (filters.recursive === false) {
      clauses.push(`${alias}.folder = ?`);
      params.push(filters.folder);
    } else if (filters.folder === "") {
      /* whole tree */
    } else {
      clauses.push(`(${alias}.folder = ? OR ${alias}.folder LIKE ? ESCAPE '\\')`);
      params.push(filters.folder, `${escapeLike(filters.folder)}/%`);
    }
  }
  if (filters.pathPrefix) {
    clauses.push(`${alias}.rel_path LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLike(filters.pathPrefix)}%`);
  }
  if (filters.type) {
    clauses.push(`${alias}.type = ?`);
    params.push(filters.type);
  }
  if (filters.status) {
    clauses.push(`${alias}.status = ?`);
    params.push(filters.status);
  }
  for (const tag of filters.tags ?? []) {
    clauses.push(`EXISTS (SELECT 1 FROM tags t WHERE t.file_id = ${alias}.id AND t.tag = ?)`);
    params.push(tag.toLowerCase());
  }

  return { sql: clauses.join(" AND "), params };
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Column weights: body text dominates, title/summary/tags nudge. */
const BM25_WEIGHTS = [1.0, 0.6, 1.6, 1.2, 1.0];

export function searchBm25(db: Db, query: string, limit: number, filters: SearchFilters): Bm25Hit[] {
  const run = (mode: "and" | "or"): Bm25Hit[] => {
    const match = buildMatchExpression(query, mode);
    if (!match) return [];
    const filter = buildFilterSql(filters);
    const rows = db
      .prepare(
        `SELECT c.id AS chunkId, bm25(chunks_fts, ?, ?, ?, ?, ?) AS score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN files  f ON f.id = c.file_id
          WHERE chunks_fts MATCH ? AND ${filter.sql}
          ORDER BY score
          LIMIT ?`,
      )
      .all(...BM25_WEIGHTS, match, ...filter.params, limit) as Bm25Hit[];
    return rows;
  };

  // AND is precise; fall back to OR so a query with one unusual word still recalls.
  const strict = run("and");
  return strict.length > 0 ? strict : run("or");
}
