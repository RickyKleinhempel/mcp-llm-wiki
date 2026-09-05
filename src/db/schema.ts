import type { Db } from "./open.js";
import { log } from "../logger.js";

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id              INTEGER PRIMARY KEY,
  rel_path        TEXT    NOT NULL,
  layer           TEXT    NOT NULL CHECK (layer IN ('wiki','raw')),
  folder          TEXT    NOT NULL DEFAULT '',
  depth           INTEGER NOT NULL DEFAULT 0,
  sha256          TEXT    NOT NULL,
  size            INTEGER NOT NULL,
  mtime_ms        INTEGER NOT NULL,
  title           TEXT,
  doc_id          TEXT,
  type            TEXT,
  status          TEXT,
  summary         TEXT,
  created         TEXT,
  updated         TEXT,
  confidence      TEXT,
  has_frontmatter INTEGER NOT NULL DEFAULT 0,
  frontmatter     TEXT,
  indexed_at      INTEGER NOT NULL,
  UNIQUE (layer, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS idx_files_doc_id ON files(doc_id);
CREATE INDEX IF NOT EXISTS idx_files_layer  ON files(layer);
CREATE INDEX IF NOT EXISTS idx_files_type   ON files(type);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);

CREATE TABLE IF NOT EXISTS tags (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tags_tag  ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_file ON tags(file_id);

CREATE TABLE IF NOT EXISTS aliases (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  alias   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_file  ON aliases(file_id);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  heading_path TEXT    NOT NULL DEFAULT '',
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  text         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  heading_path,
  title,
  summary,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS links (
  src_file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_target      TEXT    NOT NULL,
  target_rel_path TEXT,
  kind            TEXT    NOT NULL CHECK (kind IN ('wikilink','markdown','frontmatter')),
  field           TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_src    ON links(src_file_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_rel_path);
`;

export function initSchema(db: Db): void {
  db.exec(DDL);
  const version = getMetaNumber(db, "schema_version");
  if (version === undefined) {
    setMeta(db, "schema_version", String(SCHEMA_VERSION));
  } else if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Index database has schema version ${version}, this server expects ${SCHEMA_VERSION}. ` +
        `Delete the index file and run wiki_reindex to rebuild it.`,
    );
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function getMetaNumber(db: Db, key: string): number | undefined {
  const value = getMeta(db, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

/**
 * The vec0 virtual table fixes its dimension at CREATE time, so it can only be
 * created once the embedding model has produced its first vector. Model or
 * dimension changes invalidate every stored embedding - the table and all
 * chunks are dropped so the next reindex rebuilds them.
 */
export function ensureVectorTable(db: Db, modelId: string, dim: number): void {
  const storedModel = getMeta(db, "model_id");
  const storedDim = getMetaNumber(db, "dim");
  const tableExists = hasTable(db, "chunk_vec");

  if (tableExists && storedModel === modelId && storedDim === dim) return;

  if (tableExists) {
    log.warn("embedding model or dimension changed - rebuilding vector index", {
      from: { model: storedModel, dim: storedDim },
      to: { model: modelId, dim },
    });
    db.exec("DROP TABLE IF EXISTS chunk_vec");
    db.exec("DELETE FROM chunks");
    db.exec("DELETE FROM chunks_fts");
    db.prepare("UPDATE files SET sha256 = ''").run();
  }

  db.exec(
    `CREATE VIRTUAL TABLE chunk_vec USING vec0(
       chunk_id INTEGER PRIMARY KEY,
       embedding FLOAT[${dim}] distance_metric=cosine
     )`,
  );
  setMeta(db, "model_id", modelId);
  setMeta(db, "dim", String(dim));
}

export function hasTable(db: Db, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name) as { name: string } | undefined;
  return row !== undefined;
}
