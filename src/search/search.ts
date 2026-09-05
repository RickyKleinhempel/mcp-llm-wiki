import type { Db } from "../db/open.js";
import type { Embedder } from "../indexing/embed.js";
import { searchBm25, type SearchFilters } from "./bm25.js";
import { reciprocalRankFusion } from "./fusion.js";
import { searchVector } from "./vector.js";

export type SearchMode = "hybrid" | "bm25" | "vector";

export interface SearchParams extends SearchFilters {
  query: string;
  mode?: SearchMode;
  k?: number;
  includeText?: boolean;
  snippetChars?: number;
}

export interface SearchHit {
  relPath: string;
  layer: string;
  title: string | null;
  id: string | null;
  type: string | null;
  status: string | null;
  summary: string | null;
  tags: string[];
  updated: string | null;
  headingPath: string;
  startLine: number;
  endLine: number;
  score: number;
  ranks: Record<string, number>;
  snippet: string;
  text?: string;
}

export interface SearchOutcome {
  mode: SearchMode;
  bm25Candidates: number;
  vectorCandidates: number;
  hits: SearchHit[];
}

interface ChunkRow {
  chunkId: number;
  relPath: string;
  layer: string;
  title: string | null;
  docId: string | null;
  type: string | null;
  status: string | null;
  summary: string | null;
  updated: string | null;
  headingPath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export async function runSearch(
  db: Db,
  embedder: Embedder,
  rrfK: number,
  params: SearchParams,
): Promise<SearchOutcome> {
  const mode = params.mode ?? "hybrid";
  const k = Math.min(Math.max(params.k ?? 10, 1), 50);
  const candidateCount = Math.max(k * 5, 50);
  const filters: SearchFilters = {
    layer: params.layer ?? "wiki",
    folder: params.folder,
    recursive: params.recursive,
    pathPrefix: params.pathPrefix,
    type: params.type,
    status: params.status,
    tags: params.tags,
  };

  const bm25Hits = mode === "vector" ? [] : searchBm25(db, params.query, candidateCount, filters);

  let vectorHits: { chunkId: number; distance: number }[] = [];
  if (mode !== "bm25") {
    const embedding = await embedder.embedQuery(params.query);
    vectorHits = searchVector(db, embedding, candidateCount, filters);
  }

  const fused = reciprocalRankFusion(
    {
      bm25: { ids: bm25Hits.map((hit) => hit.chunkId) },
      vector: { ids: vectorHits.map((hit) => hit.chunkId) },
    },
    rrfK,
    k * 3,
  );

  const rows = loadChunkRows(
    db,
    fused.map((hit) => hit.id),
  );

  // Collapse to the best chunk per page so one long article cannot fill the result list.
  const seenPages = new Set<string>();
  const hits: SearchHit[] = [];
  for (const entry of fused) {
    const row = rows.get(entry.id);
    if (!row) continue;
    if (seenPages.has(row.relPath)) continue;
    seenPages.add(row.relPath);
    hits.push({
      relPath: row.relPath,
      layer: row.layer,
      title: row.title,
      id: row.docId,
      type: row.type,
      status: row.status,
      summary: row.summary,
      tags: loadTags(db, row.relPath, row.layer),
      updated: row.updated,
      headingPath: row.headingPath,
      startLine: row.startLine,
      endLine: row.endLine,
      score: Number(entry.score.toFixed(6)),
      ranks: entry.ranks,
      snippet: buildSnippet(row.text, params.query, params.snippetChars ?? 320),
      ...(params.includeText ? { text: row.text } : {}),
    });
    if (hits.length >= k) break;
  }

  return { mode, bm25Candidates: bm25Hits.length, vectorCandidates: vectorHits.length, hits };
}

function loadChunkRows(db: Db, chunkIds: number[]): Map<number, ChunkRow> {
  const map = new Map<number, ChunkRow>();
  if (chunkIds.length === 0) return map;
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.id AS chunkId, f.rel_path AS relPath, f.layer AS layer, f.title AS title, f.doc_id AS docId,
              f.type AS type, f.status AS status, f.summary AS summary, f.updated AS updated,
              c.heading_path AS headingPath, c.start_line AS startLine, c.end_line AS endLine, c.text AS text
         FROM chunks c JOIN files f ON f.id = c.file_id
        WHERE c.id IN (${placeholders})`,
    )
    .all(...chunkIds) as ChunkRow[];
  for (const row of rows) map.set(row.chunkId, row);
  return map;
}

function loadTags(db: Db, relPath: string, layer: string): string[] {
  const rows = db
    .prepare(
      `SELECT t.tag AS tag FROM tags t JOIN files f ON f.id = t.file_id
        WHERE f.rel_path = ? AND f.layer = ? ORDER BY t.tag`,
    )
    .all(relPath, layer) as { tag: string }[];
  return rows.map((row) => row.tag);
}

/** Excerpt centred on the first query term, falling back to the chunk head. */
function buildSnippet(text: string, query: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;

  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 2)
    .map((term) => term.toLowerCase());
  const haystack = collapsed.toLowerCase();

  let index = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return `${collapsed.slice(0, maxChars)}...`;

  const start = Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(collapsed.length, start + maxChars);
  return `${start > 0 ? "..." : ""}${collapsed.slice(start, end)}${end < collapsed.length ? "..." : ""}`;
}
