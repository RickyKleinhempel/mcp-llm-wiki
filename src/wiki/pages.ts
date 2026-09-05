import fs from "node:fs";
import path from "node:path";
import { ToolError, type ServerContext } from "../context.js";
import { log } from "../logger.js";
import {
  baseNameWithoutMd,
  depthOf,
  folderOf,
  normalizeMarkdownRelPath,
  normalizeRelPath,
  resolveInRoot,
  toRelPath,
} from "../paths.js";
import {
  completeFrontmatter,
  composePage,
  mergeFrontmatter,
  parsePage,
  type FrontmatterInput,
} from "./frontmatter.js";
import { isExternalTarget } from "./links.js";

/**
 * Page CRUD.
 *
 * The model chooses where a page lives; this layer only enforces the
 * boundaries (see `paths.ts`), keeps the frontmatter valid, and refreshes the
 * index after every write.
 */

export interface PageContent {
  relPath: string;
  absPath: string;
  content: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  body: string;
  bodyStartLine: number;
  parseErrors: string[];
}

function limitsOf(ctx: ServerContext) {
  return { maxDepth: ctx.config.maxDepth, maxRelPathLength: ctx.config.maxRelPathLength };
}

function assertWritable(ctx: ServerContext): void {
  if (!ctx.config.allowWrite) {
    throw new ToolError("read-only", "This server is running with ALLOW_WRITE=false.");
  }
}

export function wikiPath(ctx: ServerContext, relPathInput: string): { relPath: string; absPath: string } {
  const relPath = normalizeMarkdownRelPath(relPathInput, limitsOf(ctx));
  return { relPath, absPath: resolveInRoot(ctx.config.wikiRoot, relPath) };
}

export function loadPage(ctx: ServerContext, relPathInput: string): PageContent {
  const { relPath, absPath } = wikiPath(ctx, relPathInput);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new ToolError("not-found", `Page not found: ${relPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size > ctx.config.maxReadBytes) {
    throw new ToolError(
      "too-large",
      `Page is ${stat.size} bytes, the read limit is ${ctx.config.maxReadBytes}. Use startLine/endLine.`,
    );
  }
  const content = fs.readFileSync(absPath, "utf8");
  const parsed = parsePage(content);
  return {
    relPath,
    absPath,
    content,
    frontmatter: parsed.data,
    hasFrontmatter: parsed.hasFrontmatter,
    body: parsed.body,
    bodyStartLine: parsed.bodyStartLine,
    parseErrors: parsed.errors,
  };
}

export interface ReadOptions {
  startLine?: number;
  endLine?: number;
  section?: string;
  includeFrontmatter?: boolean;
}

export interface ReadResult {
  relPath: string;
  title: string | null;
  frontmatter: Record<string, unknown> | null;
  hasFrontmatter: boolean;
  parseErrors: string[];
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export function readPage(ctx: ServerContext, relPathInput: string, options: ReadOptions = {}): ReadResult {
  const page = loadPage(ctx, relPathInput);
  const allLines = page.content.split(/\r?\n/);

  let startLine = 1;
  let endLine = allLines.length;

  if (options.section) {
    const range = findSection(allLines, options.section);
    if (!range) throw new ToolError("section-not-found", `No heading matching "${options.section}" in ${page.relPath}.`);
    startLine = range.startLine;
    endLine = range.endLine;
  } else if (options.startLine !== undefined || options.endLine !== undefined) {
    startLine = Math.max(1, options.startLine ?? 1);
    endLine = Math.min(allLines.length, options.endLine ?? allLines.length);
    if (endLine < startLine) throw new ToolError("invalid-range", "endLine must be greater than or equal to startLine.");
  } else if (options.includeFrontmatter === false) {
    startLine = page.bodyStartLine;
  }

  return {
    relPath: page.relPath,
    title: typeof page.frontmatter.title === "string" ? page.frontmatter.title : null,
    frontmatter: page.hasFrontmatter ? page.frontmatter : null,
    hasFrontmatter: page.hasFrontmatter,
    parseErrors: page.parseErrors,
    startLine,
    endLine,
    totalLines: allLines.length,
    content: allLines.slice(startLine - 1, endLine).join("\n"),
  };
}

export interface WriteResult {
  relPath: string;
  created: boolean;
  bytes: number;
  frontmatter: Record<string, unknown>;
}

export async function writePage(
  ctx: ServerContext,
  args: { path: string; body: string; frontmatter?: FrontmatterInput; overwrite?: boolean },
): Promise<WriteResult> {
  assertWritable(ctx);
  const { relPath, absPath } = wikiPath(ctx, args.path);
  const exists = fs.existsSync(absPath);
  if (exists && !args.overwrite) {
    throw new ToolError("exists", `${relPath} already exists. Pass overwrite: true or use wiki_patch_page.`);
  }

  const existingFrontmatter = exists ? parsePage(fs.readFileSync(absPath, "utf8")).data : undefined;
  const frontmatter = completeFrontmatter(args.frontmatter ?? {}, {
    fallbackId: baseNameWithoutMd(relPath),
    fallbackTitle: baseNameWithoutMd(relPath),
    existing: existingFrontmatter,
    strict: ctx.config.schemaStrict,
    defaultConfidence: ctx.config.defaultConfidence,
  });

  const content = composePage(frontmatter, args.body);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  await refreshIndex(ctx, relPath);

  return { relPath, created: !exists, bytes: Buffer.byteLength(content, "utf8"), frontmatter };
}

export type PatchMode = "replace-section" | "append-section" | "append" | "prepend" | "replace-body";

export interface PatchResult {
  relPath: string;
  mode: PatchMode | "frontmatter-only";
  bytes: number;
  frontmatter: Record<string, unknown>;
}

export async function patchPage(
  ctx: ServerContext,
  args: {
    path: string;
    mode?: PatchMode;
    section?: string;
    content?: string;
    frontmatter?: FrontmatterInput;
    frontmatterMode?: "merge" | "replace";
  },
): Promise<PatchResult> {
  assertWritable(ctx);
  const page = loadPage(ctx, args.path);

  let body = page.body;
  const mode = args.mode;

  if (mode !== undefined) {
    if (args.content === undefined) {
      throw new ToolError("missing-content", `mode "${mode}" requires the content parameter.`);
    }
    body = applyBodyPatch(page, body, mode, args.content, args.section);
  }

  const mergedFrontmatter = mergeFrontmatter(
    page.frontmatter,
    args.frontmatter ?? {},
    args.frontmatterMode ?? "merge",
  );
  const frontmatter = completeFrontmatter(mergedFrontmatter, {
    fallbackId: baseNameWithoutMd(page.relPath),
    fallbackTitle: baseNameWithoutMd(page.relPath),
    existing: page.frontmatter,
    strict: ctx.config.schemaStrict,
    defaultConfidence: ctx.config.defaultConfidence,
  });

  const content = composePage(frontmatter, body);
  fs.writeFileSync(page.absPath, content, "utf8");
  await refreshIndex(ctx, page.relPath);

  return {
    relPath: page.relPath,
    mode: mode ?? "frontmatter-only",
    bytes: Buffer.byteLength(content, "utf8"),
    frontmatter,
  };
}

function applyBodyPatch(
  page: PageContent,
  body: string,
  mode: PatchMode,
  content: string,
  section: string | undefined,
): string {
  const lines = body.split(/\r?\n/);

  switch (mode) {
    case "replace-body":
      return content;
    case "append":
      return `${body.replace(/\s*$/, "")}\n\n${content.trim()}`;
    case "prepend":
      return `${content.trim()}\n\n${body.replace(/^\s*\n+/, "")}`;
    case "replace-section":
    case "append-section": {
      if (!section) throw new ToolError("missing-section", `mode "${mode}" requires the section parameter.`);
      const range = findSection(lines, section, 1);
      if (!range) {
        throw new ToolError("section-not-found", `No heading matching "${section}" in ${page.relPath}.`);
      }
      const before = lines.slice(0, range.startLine - 1);
      const sectionLines = lines.slice(range.startLine - 1, range.endLine);
      const after = lines.slice(range.endLine);
      // The heading itself is kept in both modes - callers replace the text of a
      // section, not the section's identity.
      if (mode === "replace-section") {
        return [...before, sectionLines[0], "", ...content.trim().split(/\r?\n/), ...after].join("\n");
      }
      return [...before, ...sectionLines, "", ...content.trim().split(/\r?\n/), ...after].join("\n");
    }
    default:
      throw new ToolError("invalid-mode", `Unknown patch mode: ${String(mode)}`);
  }
}

/**
 * Locate a section by heading text. The section runs from the heading line up
 * to (but excluding) the next heading of the same or a higher level.
 */
function findSection(
  lines: string[],
  section: string,
  lineOffset = 1,
): { startLine: number; endLine: number } | undefined {
  const wanted = section.replace(/^#+\s*/, "").trim().toLowerCase();
  let fence: string | null = null;
  let startIndex = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!heading) continue;

    if (startIndex < 0) {
      if (heading[2].trim().toLowerCase() === wanted) {
        startIndex = i;
        level = heading[1].length;
      }
      continue;
    }
    if (heading[1].length <= level) {
      return { startLine: startIndex + lineOffset, endLine: i - 1 + lineOffset };
    }
  }

  if (startIndex < 0) return undefined;
  return { startLine: startIndex + lineOffset, endLine: lines.length - 1 + lineOffset };
}

export interface MoveResult {
  from: string;
  to: string;
  dryRun: boolean;
  rewrittenFiles: string[];
  movedFiles: { from: string; to: string }[];
}

export async function movePage(
  ctx: ServerContext,
  args: { from: string; to: string; updateLinks?: boolean; dryRun?: boolean; overwrite?: boolean },
): Promise<MoveResult> {
  assertWritable(ctx);
  const limits = limitsOf(ctx);
  const fromRel = normalizeRelPath(args.from, limits);
  const toRel = normalizeRelPath(args.to, limits);
  const fromAbs = resolveInRoot(ctx.config.wikiRoot, fromRel);
  const toAbs = resolveInRoot(ctx.config.wikiRoot, toRel);

  if (!fs.existsSync(fromAbs)) throw new ToolError("not-found", `${fromRel} does not exist.`);
  if (fromRel === toRel) throw new ToolError("invalid-move", "Source and target are identical.");

  const isDirectory = fs.statSync(fromAbs).isDirectory();
  if (isDirectory && (toRel === fromRel || toRel.startsWith(`${fromRel}/`))) {
    throw new ToolError("invalid-move", "Cannot move a folder into itself.");
  }
  if (!isDirectory) {
    normalizeMarkdownRelPath(fromRel, limits);
    normalizeMarkdownRelPath(toRel, limits);
  }
  if (fs.existsSync(toAbs) && !args.overwrite) {
    throw new ToolError("exists", `${toRel} already exists. Pass overwrite: true to replace it.`);
  }

  const movedFiles = isDirectory
    ? listMarkdownBelow(ctx.config.wikiRoot, fromAbs).map((rel) => ({
        from: rel,
        to: `${toRel}/${rel.slice(fromRel.length + 1)}`,
      }))
    : [{ from: fromRel, to: toRel }];

  const rewrites = args.updateLinks === false ? [] : planLinkRewrites(ctx, movedFiles);

  if (args.dryRun) {
    return { from: fromRel, to: toRel, dryRun: true, movedFiles, rewrittenFiles: rewrites.map((r) => r.relPath) };
  }

  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);
  pruneEmptyFolders(ctx.config.wikiRoot, path.dirname(fromAbs));

  for (const rewrite of rewrites) {
    const abs = resolveInRoot(ctx.config.wikiRoot, rewrite.relPath);
    if (!fs.existsSync(abs)) continue;
    fs.writeFileSync(abs, rewrite.content, "utf8");
  }

  await ctx.indexer.reindex({ mode: "incremental" });

  return { from: fromRel, to: toRel, dryRun: false, movedFiles, rewrittenFiles: rewrites.map((r) => r.relPath) };
}

interface PlannedRewrite {
  relPath: string;
  content: string;
}

/**
 * Wikilinks resolve by page id and survive a move untouched; only relative
 * markdown links have to be rewritten.
 */
function planLinkRewrites(ctx: ServerContext, moves: { from: string; to: string }[]): PlannedRewrite[] {
  const moveMap = new Map(moves.map((move) => [move.from, move.to]));
  const rows = ctx.db
    .prepare(
      `SELECT DISTINCT f.rel_path AS relPath, l.raw_target AS rawTarget, l.target_rel_path AS target
         FROM links l JOIN files f ON f.id = l.src_file_id
        WHERE l.kind = 'markdown' AND l.target_rel_path IS NOT NULL AND f.layer = 'wiki'`,
    )
    .all() as { relPath: string; rawTarget: string; target: string }[];

  const byFile = new Map<string, { rawTarget: string; target: string }[]>();
  for (const row of rows) {
    if (!moveMap.has(row.target)) continue;
    const list = byFile.get(row.relPath) ?? [];
    list.push({ rawTarget: row.rawTarget, target: row.target });
    byFile.set(row.relPath, list);
  }

  const rewrites: PlannedRewrite[] = [];
  for (const [relPath, targets] of byFile) {
    const sourceRel = moveMap.get(relPath) ?? relPath;
    let abs: string;
    try {
      abs = resolveInRoot(ctx.config.wikiRoot, relPath);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) continue;

    let content = fs.readFileSync(abs, "utf8");
    let changed = false;
    for (const { rawTarget, target } of targets) {
      const newTarget = relativeLink(folderOf(sourceRel), moveMap.get(target) ?? target);
      if (newTarget === rawTarget) continue;
      const next = content.split(`](${rawTarget})`).join(`](${newTarget})`);
      if (next !== content) {
        content = next;
        changed = true;
      }
    }
    if (changed) rewrites.push({ relPath, content });
  }
  return rewrites;
}

function relativeLink(fromFolder: string, targetRel: string): string {
  const relative = path.posix.relative(fromFolder === "" ? "." : fromFolder, targetRel);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export interface DeleteResult {
  relPath: string;
  trashPath: string;
}

export async function deletePage(
  ctx: ServerContext,
  args: { path: string; confirm: boolean },
): Promise<DeleteResult> {
  assertWritable(ctx);
  if (args.confirm !== true) {
    throw new ToolError("confirmation-required", "Pass confirm: true to delete a page.");
  }
  const { relPath, absPath } = wikiPath(ctx, args.path);
  if (!fs.existsSync(absPath)) throw new ToolError("not-found", `Page not found: ${relPath}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashRel = path.posix.join(".trash", stamp, relPath);
  const trashAbs = path.join(ctx.config.wikiRoot, ...trashRel.split("/"));
  fs.mkdirSync(path.dirname(trashAbs), { recursive: true });
  fs.renameSync(absPath, trashAbs);
  pruneEmptyFolders(ctx.config.wikiRoot, path.dirname(absPath));

  ctx.indexer.removeFile("wiki", relPath);
  log.info("page moved to trash", { relPath, trashRel });

  return { relPath, trashPath: trashRel };
}

export interface PageSummary {
  relPath: string;
  folder: string;
  id: string | null;
  title: string | null;
  type: string | null;
  status: string | null;
  summary: string | null;
  tags: string[];
  updated: string | null;
  size: number;
}

export function listPages(
  ctx: ServerContext,
  filters: {
    folder?: string;
    recursive?: boolean;
    type?: string;
    status?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  } = {},
): { total: number; pages: PageSummary[] } {
  const clauses = ["f.layer = 'wiki'"];
  const params: unknown[] = [];

  if (filters.folder !== undefined) {
    const folder = normalizeRelPath(filters.folder, limitsOf(ctx), { allowEmpty: true });
    if (folder !== "") {
      if (filters.recursive === false) {
        clauses.push("f.folder = ?");
        params.push(folder);
      } else {
        clauses.push("(f.folder = ? OR f.folder LIKE ? ESCAPE '\\')");
        params.push(folder, `${folder.replace(/[\\%_]/g, "\\$&")}/%`);
      }
    }
  }
  if (filters.type) {
    clauses.push("f.type = ?");
    params.push(filters.type);
  }
  if (filters.status) {
    clauses.push("f.status = ?");
    params.push(filters.status);
  }
  if (filters.tag) {
    clauses.push("EXISTS (SELECT 1 FROM tags t WHERE t.file_id = f.id AND t.tag = ?)");
    params.push(filters.tag.toLowerCase());
  }

  const where = clauses.join(" AND ");
  const total = (
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${where}`).get(...params) as { n: number }
  ).n;

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = ctx.db
    .prepare(
      `SELECT f.id AS id, f.rel_path AS relPath, f.folder AS folder, f.doc_id AS docId, f.title AS title,
              f.type AS type, f.status AS status, f.summary AS summary, f.updated AS updated, f.size AS size
         FROM files f WHERE ${where}
        ORDER BY f.rel_path LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
    id: number;
    relPath: string;
    folder: string;
    docId: string | null;
    title: string | null;
    type: string | null;
    status: string | null;
    summary: string | null;
    updated: string | null;
    size: number;
  }[];

  const tagStatement = ctx.db.prepare("SELECT tag FROM tags WHERE file_id = ? ORDER BY tag");
  const pages = rows.map((row) => ({
    relPath: row.relPath,
    folder: row.folder,
    id: row.docId,
    title: row.title,
    type: row.type,
    status: row.status,
    summary: row.summary,
    tags: (tagStatement.all(row.id) as { tag: string }[]).map((t) => t.tag),
    updated: row.updated,
    size: row.size,
  }));

  return { total, pages };
}

export interface FolderInfo {
  folder: string;
  depth: number;
  directPages: number;
  totalPages: number;
}

export function listFolders(ctx: ServerContext, maxDepth?: number): FolderInfo[] {
  const rows = ctx.db.prepare("SELECT folder FROM files WHERE layer = 'wiki'").all() as { folder: string }[];
  const direct = new Map<string, number>();
  const total = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (const row of rows) {
    bump(direct, row.folder);
    bump(total, "");
    if (row.folder === "") continue;
    const segments = row.folder.split("/");
    for (let i = 1; i <= segments.length; i++) {
      bump(total, segments.slice(0, i).join("/"));
    }
  }
  for (const folder of [...direct.keys()]) {
    if (folder === "") continue;
    const segments = folder.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join("/");
      if (!direct.has(parent)) direct.set(parent, 0);
    }
  }
  if (!direct.has("")) direct.set("", 0);

  return [...direct.keys()]
    .map((folder) => ({
      folder,
      depth: folder === "" ? 0 : folder.split("/").length,
      directPages: direct.get(folder) ?? 0,
      totalPages: total.get(folder) ?? 0,
    }))
    .filter((info) => maxDepth === undefined || info.depth <= maxDepth)
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

export function listTags(ctx: ServerContext): { tag: string; count: number }[] {
  return ctx.db
    .prepare(
      `SELECT t.tag AS tag, COUNT(*) AS count
         FROM tags t JOIN files f ON f.id = t.file_id
        WHERE f.layer = 'wiki'
        GROUP BY t.tag ORDER BY count DESC, tag ASC`,
    )
    .all() as { tag: string; count: number }[];
}

/** Read-only access to the immutable raw source layer. */
export function rawRead(ctx: ServerContext, relPathInput: string, options: ReadOptions = {}): ReadResult {
  const relPath = normalizeRelPath(relPathInput, limitsOf(ctx));
  const absPath = resolveInRoot(ctx.config.rawRoot, relPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new ToolError("not-found", `Raw source not found: ${relPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size > ctx.config.maxReadBytes) {
    throw new ToolError("too-large", `File is ${stat.size} bytes, the read limit is ${ctx.config.maxReadBytes}.`);
  }
  const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
  const startLine = Math.max(1, options.startLine ?? 1);
  const endLine = Math.min(lines.length, options.endLine ?? lines.length);
  return {
    relPath,
    title: null,
    frontmatter: null,
    hasFrontmatter: false,
    parseErrors: [],
    startLine,
    endLine,
    totalLines: lines.length,
    content: lines.slice(startLine - 1, endLine).join("\n"),
  };
}

export function rawList(ctx: ServerContext, prefix?: string): { relPath: string; size: number }[] {
  if (!fs.existsSync(ctx.config.rawRoot)) return [];
  const normalizedPrefix = prefix ? normalizeRelPath(prefix, limitsOf(ctx), { allowEmpty: true }) : "";
  return listAllBelow(ctx.config.rawRoot, ctx.config.rawRoot)
    .filter((entry) => normalizedPrefix === "" || entry.relPath.startsWith(normalizedPrefix))
    .slice(0, 2000);
}

function listAllBelow(root: string, dir: string): { relPath: string; size: number }[] {
  const out: { relPath: string; size: number }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      out.push(...listAllBelow(root, abs));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({ relPath: toRelPath(root, abs), size: fs.statSync(abs).size });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function listMarkdownBelow(root: string, dir: string): string[] {
  return listAllBelow(root, dir)
    .filter((entry) => entry.relPath.toLowerCase().endsWith(".md"))
    .map((entry) => entry.relPath);
}

/** Delete now-empty folders left behind by a move or delete, never the root. */
function pruneEmptyFolders(root: string, startDir: string): void {
  const absoluteRoot = path.resolve(root);
  let current = path.resolve(startDir);
  while (current !== absoluteRoot && current.startsWith(absoluteRoot + path.sep)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

async function refreshIndex(ctx: ServerContext, relPath: string): Promise<void> {
  try {
    await ctx.indexer.indexSingle("wiki", relPath);
  } catch (error) {
    log.error("index refresh failed after write", { relPath, error: String(error) });
  }
}

/** Used by lint: does a frontmatter source entry point at an existing raw file? */
export function rawSourceExists(ctx: ServerContext, target: string): boolean {
  if (isExternalTarget(target)) return true;
  try {
    const relPath = normalizeRelPath(target.replace(/^raw\//i, ""), limitsOf(ctx));
    return fs.existsSync(resolveInRoot(ctx.config.rawRoot, relPath));
  } catch {
    return false;
  }
}

export { folderOf, depthOf };
