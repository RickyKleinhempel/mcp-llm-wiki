import type { Db } from "../db/open.js";
import { asStringArray } from "./frontmatter.js";
import { folderOf } from "../paths.js";

/**
 * Link extraction and resolution.
 *
 * Wikilinks (`[[id]]`) resolve through the page id / alias index rather than
 * through the file system, so moving a page between folders never breaks an
 * inbound link. Relative markdown links resolve against the source folder.
 */

export type LinkKind = "wikilink" | "markdown" | "frontmatter";

export interface ExtractedLink {
  rawTarget: string;
  kind: LinkKind;
  field?: string;
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

export function isExternalTarget(target: string): boolean {
  return EXTERNAL.test(target) || target.startsWith("//");
}

/** Frontmatter fields whose values are references to other pages or sources. */
const REFERENCE_FIELDS = ["sources", "related", "supersedes", "superseded_by"] as const;

export function extractLinks(body: string, frontmatter: Record<string, unknown>): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  const add = (rawTarget: string, kind: LinkKind, field?: string): void => {
    const target = rawTarget.trim();
    if (target.length === 0 || target.startsWith("#")) return;
    const key = `${kind}\u0000${field ?? ""}\u0000${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(field === undefined ? { rawTarget: target, kind } : { rawTarget: target, kind, field });
  };

  const withoutCode = stripCode(body);

  for (const match of withoutCode.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const target = match[1].split("|")[0].split("#")[0];
    add(target, "wikilink");
  }

  for (const match of withoutCode.matchAll(/(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (match[1] === "!") continue; // image
    const target = match[2].split("#")[0];
    if (isExternalTarget(target)) continue;
    add(target, "markdown");
  }

  for (const field of REFERENCE_FIELDS) {
    for (const value of asStringArray(frontmatter[field])) {
      add(value, "frontmatter", field);
    }
  }

  return links;
}

/** Remove fenced and inline code so link syntax in samples is not indexed. */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "").replace(/`[^`\n]*`/g, "");
}

export interface LinkResolver {
  resolve(sourceRelPath: string, rawTarget: string): string | undefined;
}

/** Build an in-memory resolver from the current index contents. */
export function buildResolver(db: Db): LinkResolver {
  const byPath = new Set<string>();
  const byPathLower = new Map<string, string>();
  for (const row of db.prepare("SELECT rel_path FROM files WHERE layer = 'wiki'").all() as { rel_path: string }[]) {
    byPath.add(row.rel_path);
    byPathLower.set(row.rel_path.toLowerCase(), row.rel_path);
  }

  const byKey = new Map<string, string>();
  const addKey = (key: string | null, relPath: string): void => {
    if (!key) return;
    const normalized = key.trim().toLowerCase();
    if (normalized.length === 0 || byKey.has(normalized)) return;
    byKey.set(normalized, relPath);
  };

  for (const row of db
    .prepare("SELECT rel_path, doc_id FROM files WHERE layer = 'wiki' ORDER BY rel_path")
    .all() as { rel_path: string; doc_id: string | null }[]) {
    addKey(row.doc_id, row.rel_path);
    addKey(row.rel_path.slice(row.rel_path.lastIndexOf("/") + 1).replace(/\.md$/i, ""), row.rel_path);
  }
  for (const row of db
    .prepare("SELECT f.rel_path AS rel_path, a.alias AS alias FROM aliases a JOIN files f ON f.id = a.file_id ORDER BY f.rel_path")
    .all() as { rel_path: string; alias: string }[]) {
    addKey(row.alias, row.rel_path);
  }

  return {
    resolve(sourceRelPath: string, rawTarget: string): string | undefined {
      const target = rawTarget.trim();
      if (target.length === 0 || isExternalTarget(target)) return undefined;

      const looksLikePath = target.includes("/") || /\.md$/i.test(target);
      if (looksLikePath) {
        const candidates = [
          joinRelative(folderOf(sourceRelPath), target),
          joinRelative("", target),
        ];
        for (const candidate of candidates) {
          if (candidate === undefined) continue;
          const withExt = /\.md$/i.test(candidate) ? candidate : `${candidate}.md`;
          if (byPath.has(withExt)) return withExt;
          const insensitive = byPathLower.get(withExt.toLowerCase());
          if (insensitive) return insensitive;
        }
        return undefined;
      }

      return byKey.get(target.toLowerCase());
    },
  };
}

/** POSIX-only relative join that refuses to leave the root. */
function joinRelative(baseFolder: string, target: string): string | undefined {
  const segments = baseFolder === "" ? [] : baseFolder.split("/");
  for (const segment of target.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Second pass after indexing: fill in `target_rel_path` now that every page is
 * known. Run once per reindex rather than per file.
 */
export function resolveAllLinks(db: Db): number {
  const resolver = buildResolver(db);
  const rows = db
    .prepare(
      `SELECT l.rowid AS rowid, l.raw_target AS raw_target, f.rel_path AS src_rel_path
         FROM links l JOIN files f ON f.id = l.src_file_id`,
    )
    .all() as { rowid: number; raw_target: string; src_rel_path: string }[];

  const update = db.prepare("UPDATE links SET target_rel_path = ? WHERE rowid = ?");
  let resolved = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      const target = resolver.resolve(row.src_rel_path, row.raw_target);
      update.run(target ?? null, row.rowid);
      if (target) resolved++;
    }
  });
  run();
  return resolved;
}

export interface LinkEdge {
  relPath: string;
  title: string | null;
  rawTarget: string;
  kind: LinkKind;
  field: string | null;
}

export interface BacklinkReport {
  relPath: string;
  inbound: LinkEdge[];
  outbound: LinkEdge[];
  unresolvedOutbound: { rawTarget: string; kind: LinkKind; field: string | null }[];
}

/** Inbound and outbound edges for one page, including frontmatter references. */
export function backlinksFor(db: Db, relPath: string): BacklinkReport {
  const inbound = db
    .prepare(
      `SELECT f.rel_path AS relPath, f.title AS title, l.raw_target AS rawTarget, l.kind AS kind, l.field AS field
         FROM links l JOIN files f ON f.id = l.src_file_id
        WHERE l.target_rel_path = ? AND f.layer = 'wiki' AND f.rel_path <> ?
        ORDER BY f.rel_path`,
    )
    .all(relPath, relPath) as LinkEdge[];

  const outboundRows = db
    .prepare(
      `SELECT l.raw_target AS rawTarget, l.target_rel_path AS target, l.kind AS kind, l.field AS field,
              t.title AS title
         FROM links l
         JOIN files f ON f.id = l.src_file_id
    LEFT JOIN files t ON t.rel_path = l.target_rel_path AND t.layer = 'wiki'
        WHERE f.rel_path = ? AND f.layer = 'wiki'
        ORDER BY l.rowid`,
    )
    .all(relPath) as { rawTarget: string; target: string | null; kind: LinkKind; field: string | null; title: string | null }[];

  const outbound: LinkEdge[] = [];
  const unresolvedOutbound: { rawTarget: string; kind: LinkKind; field: string | null }[] = [];
  for (const row of outboundRows) {
    if (row.target) {
      outbound.push({ relPath: row.target, title: row.title, rawTarget: row.rawTarget, kind: row.kind, field: row.field });
    } else {
      unresolvedOutbound.push({ rawTarget: row.rawTarget, kind: row.kind, field: row.field });
    }
  }

  return { relPath, inbound, outbound, unresolvedOutbound };
}
