import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Db } from "../db/open.js";
import { ensureVectorTable, hasTable, setMeta } from "../db/schema.js";
import { log } from "../logger.js";
import { depthOf, folderOf, baseNameWithoutMd } from "../paths.js";
import { asStringArray, inferTitle, parsePage } from "../wiki/frontmatter.js";
import { extractLinks, resolveAllLinks } from "../wiki/links.js";
import { chunkMarkdown, type Chunk } from "./chunk.js";
import type { Embedder } from "./embed.js";
import { hashString, scanMarkdown } from "./scan.js";

export type Layer = "wiki" | "raw";

export interface IndexResult {
  mode: "full" | "incremental" | "paths";
  scanned: number;
  indexed: number;
  removed: number;
  unchanged: number;
  chunks: number;
  linksResolved: number;
  durationMs: number;
}

interface PreparedFile {
  layer: Layer;
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  title: string;
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  chunks: Chunk[];
  embeddings: Float32Array[];
}

export class Indexer {
  private running: Promise<IndexResult> | undefined;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly embedder: Embedder,
  ) {}

  /** Serialise reindex runs - concurrent writers would fight over the same rows. */
  async reindex(options: { mode?: "full" | "incremental"; paths?: string[] } = {}): Promise<IndexResult> {
    while (this.running) {
      try {
        await this.running;
      } catch {
        /* previous run failed; continue with this one */
      }
    }
    const run = this.doReindex(options).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async doReindex(options: { mode?: "full" | "incremental"; paths?: string[] }): Promise<IndexResult> {
    const started = Date.now();
    const explicitPaths = options.paths?.filter((p) => p.trim().length > 0) ?? [];
    const mode = explicitPaths.length > 0 ? "paths" : (options.mode ?? "incremental");

    // The vec0 table fixes its dimension at CREATE time, so the model has to be
    // loaded first. A model/dimension change wipes chunks before anything new
    // is written, forcing a full rebuild on the next pass.
    await this.embedder.load();
    const dim = this.embedder.dim ?? (await this.probeDimension());
    ensureVectorTable(this.db, this.embedder.modelId, dim);

    const targets = this.collectTargets(mode, explicitPaths);
    const known = this.loadKnownFiles();

    let indexed = 0;
    let unchanged = 0;
    let chunkCount = 0;

    for (const target of targets.files) {
      const previous = known.get(`${target.layer}\u0000${target.relPath}`);
      if (mode !== "full" && previous && previous.sha256 === target.sha256) {
        unchanged++;
        continue;
      }
      try {
        const prepared = await this.prepareFile(target.layer, target.relPath, target.absPath);
        this.writeFile(prepared);
        indexed++;
        chunkCount += prepared.chunks.length;
      } catch (error) {
        log.error("failed to index file", { relPath: target.relPath, error: String(error) });
      }
    }

    let removed = 0;
    if (mode !== "paths") {
      const present = new Set(targets.files.map((f) => `${f.layer}\u0000${f.relPath}`));
      const scannedLayers = new Set(targets.layers);
      for (const [key, file] of known) {
        if (present.has(key)) continue;
        if (!scannedLayers.has(file.layer)) continue;
        this.db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
        this.deleteChunkArtifacts(file.id);
        removed++;
      }
    }

    const linksResolved = resolveAllLinks(this.db);
    if (mode === "full") setMeta(this.db, "last_full_index", String(Date.now()));
    setMeta(this.db, "last_index", String(Date.now()));

    const result: IndexResult = {
      mode,
      scanned: targets.files.length,
      indexed,
      removed,
      unchanged,
      chunks: chunkCount,
      linksResolved,
      durationMs: Date.now() - started,
    };
    log.info("reindex finished", result);
    return result;
  }

  private async probeDimension(): Promise<number> {
    await this.embedder.embedQuery("dimension probe");
    const dim = this.embedder.dim;
    if (dim === undefined) throw new Error("Could not determine the embedding dimension.");
    return dim;
  }

  private collectTargets(
    mode: "full" | "incremental" | "paths",
    explicitPaths: string[],
  ): { files: { layer: Layer; relPath: string; absPath: string; sha256: string }[]; layers: Layer[] } {
    if (mode === "paths") {
      const files: { layer: Layer; relPath: string; absPath: string; sha256: string }[] = [];
      for (const relPath of explicitPaths) {
        for (const layer of ["wiki", "raw"] as Layer[]) {
          const absPath = path.join(this.rootFor(layer), relPath);
          if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
          files.push({ layer, relPath, absPath, sha256: hashString(fs.readFileSync(absPath, "utf8")) });
          break;
        }
      }
      return { files, layers: [] };
    }

    const layers: Layer[] = ["wiki"];
    const files = scanMarkdown(this.config.wikiRoot, { ignoreGlobs: this.config.ignoreGlobs }).map((file) => ({
      layer: "wiki" as Layer,
      relPath: file.relPath,
      absPath: file.absPath,
      sha256: file.sha256,
    }));

    if (fs.existsSync(this.config.rawRoot)) {
      layers.push("raw");
      for (const file of scanMarkdown(this.config.rawRoot, { ignoreGlobs: this.config.ignoreGlobs })) {
        files.push({ layer: "raw", relPath: file.relPath, absPath: file.absPath, sha256: file.sha256 });
      }
    }

    return { files, layers };
  }

  private rootFor(layer: Layer): string {
    return layer === "wiki" ? this.config.wikiRoot : this.config.rawRoot;
  }

  private loadKnownFiles(): Map<string, { id: number; layer: Layer; relPath: string; sha256: string }> {
    const rows = this.db.prepare("SELECT id, layer, rel_path, sha256 FROM files").all() as {
      id: number;
      layer: Layer;
      rel_path: string;
      sha256: string;
    }[];
    const map = new Map<string, { id: number; layer: Layer; relPath: string; sha256: string }>();
    for (const row of rows) {
      map.set(`${row.layer}\u0000${row.rel_path}`, {
        id: row.id,
        layer: row.layer,
        relPath: row.rel_path,
        sha256: row.sha256,
      });
    }
    return map;
  }

  private async prepareFile(layer: Layer, relPath: string, absPath: string): Promise<PreparedFile> {
    const stat = fs.statSync(absPath);
    const content = fs.readFileSync(absPath, "utf8");
    const parsed = parsePage(content);
    const fallbackTitle = baseNameWithoutMd(relPath);
    const title =
      typeof parsed.data.title === "string" && parsed.data.title.trim().length > 0
        ? parsed.data.title.trim()
        : inferTitle(parsed.body, fallbackTitle);

    const chunks = chunkMarkdown(parsed.body, {
      maxChars: this.config.chunkChars,
      overlap: this.config.chunkOverlap,
      bodyStartLine: parsed.bodyStartLine,
    });

    const summary = typeof parsed.data.summary === "string" ? parsed.data.summary : "";
    const tags = asStringArray(parsed.data.tags);
    const embedInputs = chunks.map((chunk, index) => buildEmbedText(chunk, title, index === 0 ? summary : "", tags));
    const embeddings = await this.embedder.embedPassages(embedInputs);

    return {
      layer,
      relPath,
      absPath,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      sha256: hashString(content),
      title,
      hasFrontmatter: parsed.hasFrontmatter,
      frontmatter: parsed.data,
      chunks,
      embeddings,
    };
  }

  /** Everything below runs inside one synchronous transaction per file. */
  private writeFile(file: PreparedFile): void {
    const fm = file.frontmatter;
    const summary = typeof fm.summary === "string" ? fm.summary : null;
    const tags = asStringArray(fm.tags);
    const aliases = asStringArray(fm.aliases);
    const links = extractLinks(readBodyForLinks(file), fm);

    const run = this.db.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO files (rel_path, layer, folder, depth, sha256, size, mtime_ms, title, doc_id, type, status,
                            summary, created, updated, confidence, has_frontmatter, frontmatter, indexed_at)
         VALUES (@rel_path, @layer, @folder, @depth, @sha256, @size, @mtime_ms, @title, @doc_id, @type, @status,
                 @summary, @created, @updated, @confidence, @has_frontmatter, @frontmatter, @indexed_at)
         ON CONFLICT(layer, rel_path) DO UPDATE SET
           folder = excluded.folder, depth = excluded.depth, sha256 = excluded.sha256, size = excluded.size,
           mtime_ms = excluded.mtime_ms, title = excluded.title, doc_id = excluded.doc_id, type = excluded.type,
           status = excluded.status, summary = excluded.summary, created = excluded.created,
           updated = excluded.updated, confidence = excluded.confidence,
           has_frontmatter = excluded.has_frontmatter, frontmatter = excluded.frontmatter,
           indexed_at = excluded.indexed_at
         RETURNING id`,
      );
      const row = upsert.get({
        rel_path: file.relPath,
        layer: file.layer,
        folder: folderOf(file.relPath),
        depth: depthOf(file.relPath),
        sha256: file.sha256,
        size: file.size,
        mtime_ms: file.mtimeMs,
        title: file.title,
        doc_id: stringOrNull(fm.id),
        type: stringOrNull(fm.type),
        status: stringOrNull(fm.status),
        summary,
        created: stringOrNull(fm.created),
        updated: stringOrNull(fm.updated),
        confidence: stringOrNull(fm.confidence),
        has_frontmatter: file.hasFrontmatter ? 1 : 0,
        frontmatter: file.hasFrontmatter ? JSON.stringify(fm) : null,
        indexed_at: Date.now(),
      }) as { id: number };

      const fileId = row.id;
      this.deleteChunkArtifacts(fileId);
      this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
      this.db.prepare("DELETE FROM tags WHERE file_id = ?").run(fileId);
      this.db.prepare("DELETE FROM aliases WHERE file_id = ?").run(fileId);
      this.db.prepare("DELETE FROM links WHERE src_file_id = ?").run(fileId);

      const insertTag = this.db.prepare("INSERT INTO tags (file_id, tag) VALUES (?, ?)");
      for (const tag of new Set(tags.map((t) => t.toLowerCase()))) insertTag.run(fileId, tag);

      const insertAlias = this.db.prepare("INSERT INTO aliases (file_id, alias) VALUES (?, ?)");
      for (const alias of new Set(aliases)) insertAlias.run(fileId, alias);

      const insertLink = this.db.prepare(
        "INSERT INTO links (src_file_id, raw_target, target_rel_path, kind, field) VALUES (?, ?, NULL, ?, ?)",
      );
      for (const link of links) insertLink.run(fileId, link.rawTarget, link.kind, link.field ?? null);

      const insertChunk = this.db.prepare(
        "INSERT INTO chunks (file_id, ord, heading_path, start_line, end_line, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertFts = this.db.prepare(
        "INSERT INTO chunks_fts (rowid, text, heading_path, title, summary, tags) VALUES (?, ?, ?, ?, ?, ?)",
      );
      // better-sqlite3 binds JS numbers as REAL, and vec0 refuses a non-INTEGER
      // primary key - so the id has to be cast inside the statement.
      const insertVec = this.db.prepare(
        "INSERT INTO chunk_vec (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)",
      );
      const tagText = tags.join(" ");

      file.chunks.forEach((chunk, index) => {
        const info = insertChunk.run(
          fileId,
          chunk.ord,
          chunk.headingPath,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
        );
        const chunkId = Number(info.lastInsertRowid);
        insertFts.run(chunkId, chunk.text, chunk.headingPath, file.title, summary ?? "", tagText);
        const embedding = file.embeddings[index];
        if (embedding) insertVec.run(chunkId, embedding);
      });
    });

    run();
  }

  /** FTS5 and vec0 rows are not covered by foreign keys, so remove them explicitly. */
  private deleteChunkArtifacts(fileId: number): void {
    const ids = this.db.prepare("SELECT id FROM chunks WHERE file_id = ?").all(fileId) as { id: number }[];
    if (ids.length === 0) return;
    const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
    const hasVec = hasTable(this.db, "chunk_vec");
    const deleteVec = hasVec ? this.db.prepare("DELETE FROM chunk_vec WHERE chunk_id = ?") : undefined;
    for (const { id } of ids) {
      deleteFts.run(id);
      deleteVec?.run(id);
    }
  }

  /** Remove a single file from the index (used by the watcher and delete tool). */
  removeFile(layer: Layer, relPath: string): boolean {
    const row = this.db.prepare("SELECT id FROM files WHERE layer = ? AND rel_path = ?").get(layer, relPath) as
      | { id: number }
      | undefined;
    if (!row) return false;
    this.deleteChunkArtifacts(row.id);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
    return true;
  }

  /** Index (or refresh) exactly one file. */
  async indexSingle(layer: Layer, relPath: string): Promise<boolean> {
    const absPath = path.join(this.rootFor(layer), relPath);
    if (!fs.existsSync(absPath)) {
      return this.removeFile(layer, relPath);
    }
    await this.embedder.load();
    const dim = this.embedder.dim ?? (await this.probeDimension());
    ensureVectorTable(this.db, this.embedder.modelId, dim);
    const prepared = await this.prepareFile(layer, relPath, absPath);
    this.writeFile(prepared);
    resolveAllLinks(this.db);
    return true;
  }
}

/** Give the model the page and section context along with the chunk itself. */
function buildEmbedText(chunk: Chunk, title: string, summary: string, tags: string[]): string {
  const header = [title, chunk.headingPath, summary, tags.length > 0 ? tags.join(", ") : ""]
    .filter((part) => part && part.trim().length > 0)
    .join(" | ");
  return header.length > 0 ? `${header}\n${chunk.text}` : chunk.text;
}

function readBodyForLinks(file: PreparedFile): string {
  return file.chunks.map((chunk) => chunk.text).join("\n\n");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
