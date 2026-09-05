import fs from "node:fs";
import path from "node:path";
import type { ServerContext } from "../context.js";
import { escapeLike } from "../search/bm25.js";
import { CONFIDENCE_LEVELS, KEY_ORDER, PAGE_STATUSES, PAGE_TYPES } from "./frontmatter.js";
import { isExternalTarget } from "./links.js";
import { rawSourceExists } from "./pages.js";

/**
 * Quality checks over the indexed wiki.
 *
 * Deliberately absent: any judgement about *where* a page lives. Folder layout
 * is the model's decision, so lint reports structural facts (ambiguity, depth,
 * empty folders) but never "this page is in the wrong place".
 */

export type Severity = "error" | "warning" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  relPath?: string;
  message: string;
}

export interface LintOptions {
  folder?: string;
  checks?: string[];
  limit?: number;
}

export interface LintReport {
  checked: number;
  findings: Finding[];
  counts: Record<string, number>;
  truncated: boolean;
}

interface FileRow {
  id: number;
  relPath: string;
  folder: string;
  depth: number;
  docId: string | null;
  title: string | null;
  type: string | null;
  status: string | null;
  confidence: string | null;
  created: string | null;
  updated: string | null;
  hasFrontmatter: number;
  frontmatter: string | null;
  mtimeMs: number;
  size: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function lintWiki(ctx: ServerContext, options: LintOptions = {}): LintReport {
  const findings: Finding[] = [];
  const enabled = options.checks && options.checks.length > 0 ? new Set(options.checks) : undefined;
  const add = (finding: Finding): void => {
    if (enabled && !enabled.has(finding.code)) return;
    findings.push(finding);
  };

  const params: unknown[] = [];
  let where = "layer = 'wiki'";
  if (options.folder) {
    where += " AND (folder = ? OR folder LIKE ? ESCAPE '\\')";
    params.push(options.folder, `${escapeLike(options.folder)}/%`);
  }

  const files = ctx.db
    .prepare(
      `SELECT id, rel_path AS relPath, folder, depth, doc_id AS docId, title, type, status, confidence,
              created, updated, has_frontmatter AS hasFrontmatter, frontmatter, mtime_ms AS mtimeMs, size
         FROM files WHERE ${where} ORDER BY rel_path`,
    )
    .all(...params) as FileRow[];

  const knownIds = new Set<string>();
  const idOwners = new Map<string, string[]>();
  for (const file of files) {
    const key = (file.docId ?? basename(file.relPath)).toLowerCase();
    knownIds.add(key);
    idOwners.set(key, [...(idOwners.get(key) ?? []), file.relPath]);
  }
  for (const row of ctx.db
    .prepare("SELECT alias FROM aliases a JOIN files f ON f.id = a.file_id WHERE f.layer = 'wiki'")
    .all() as { alias: string }[]) {
    knownIds.add(row.alias.toLowerCase());
  }

  for (const file of files) {
    const isBookkeepingPage = isBookkeeping(file.relPath);

    if (!file.hasFrontmatter) {
      add({
        code: "missing-frontmatter",
        severity: "warning",
        relPath: file.relPath,
        message: "Page has no YAML frontmatter. The next write or patch will add one.",
      });
    } else {
      const fm = safeParseJson(file.frontmatter);
      for (const field of ["id", "title", "type", "created", "updated"] as const) {
        if (typeof fm[field] !== "string" || (fm[field] as string).trim().length === 0) {
          add({
            code: "missing-required-field",
            severity: "error",
            relPath: file.relPath,
            message: `Required frontmatter field "${field}" is missing.`,
          });
        }
      }
      checkEnum(add, file, "type", file.type, PAGE_TYPES);
      checkEnum(add, file, "status", file.status, PAGE_STATUSES);
      checkEnum(add, file, "confidence", file.confidence, CONFIDENCE_LEVELS);

      for (const field of ["created", "updated"] as const) {
        const value = fm[field];
        if (typeof value === "string" && !ISO_DATE.test(value)) {
          add({
            code: "invalid-date",
            severity: "error",
            relPath: file.relPath,
            message: `Frontmatter "${field}" is not an ISO date: ${value}`,
          });
        }
      }

      if (file.updated && ISO_DATE.test(file.updated)) {
        const fileDate = new Date(file.mtimeMs).toISOString().slice(0, 10);
        if (file.updated < fileDate) {
          add({
            code: "stale-updated",
            severity: "warning",
            relPath: file.relPath,
            message: `Frontmatter "updated" is ${file.updated} but the file changed on ${fileDate}.`,
          });
        }
      }

      if (typeof fm.superseded_by === "string" && fm.superseded_by.trim() && file.status !== "deprecated") {
        add({
          code: "superseded-without-deprecated",
          severity: "warning",
          relPath: file.relPath,
          message: 'Page has "superseded_by" but its status is not "deprecated".',
        });
      }

      const unknownKeys = Object.keys(fm).filter((key) => !(KEY_ORDER as readonly string[]).includes(key));
      if (unknownKeys.length > 0) {
        add({
          code: "unknown-frontmatter-keys",
          severity: "info",
          relPath: file.relPath,
          message: `Frontmatter contains non-schema keys: ${unknownKeys.join(", ")}`,
        });
      }

      if (file.docId && file.docId !== basename(file.relPath)) {
        add({
          code: "id-path-mismatch",
          severity: "info",
          relPath: file.relPath,
          message: `Frontmatter id "${file.docId}" differs from the file name "${basename(file.relPath)}".`,
        });
      }
    }

    if (file.depth > ctx.config.maxDepth) {
      add({
        code: "too-deep",
        severity: "error",
        relPath: file.relPath,
        message: `Page nests ${file.depth} folders, the limit is ${ctx.config.maxDepth}.`,
      });
    }
    if (file.relPath.length > ctx.config.maxRelPathLength) {
      add({
        code: "path-too-long",
        severity: "error",
        relPath: file.relPath,
        message: `Path is ${file.relPath.length} characters, the limit is ${ctx.config.maxRelPathLength}.`,
      });
    }
    if (!isBookkeepingPage && file.size < 200) {
      add({
        code: "empty-stub",
        severity: "info",
        relPath: file.relPath,
        message: `Page is only ${file.size} bytes - likely an unfinished stub.`,
      });
    }
  }

  for (const [id, owners] of idOwners) {
    if (owners.length > 1) {
      add({
        code: "ambiguous-id",
        severity: "error",
        message: `Page id "${id}" is used by ${owners.length} pages: ${owners.join(", ")}. Wikilinks to it are ambiguous.`,
      });
    }
  }

  const fileIds = new Set(files.map((file) => file.id));
  const links = ctx.db
    .prepare(
      `SELECT l.src_file_id AS srcId, f.rel_path AS srcRelPath, l.raw_target AS rawTarget,
              l.target_rel_path AS target, l.kind AS kind, l.field AS field
         FROM links l JOIN files f ON f.id = l.src_file_id
        WHERE f.layer = 'wiki'`,
    )
    .all() as {
    srcId: number;
    srcRelPath: string;
    rawTarget: string;
    target: string | null;
    kind: string;
    field: string | null;
  }[];

  const inbound = new Set<string>();
  for (const link of links) {
    // Links from index.md/log.md are bookkeeping, not relationships - a page
    // that only appears in the catalogue is still unconnected.
    if (link.target && !isBookkeeping(link.srcRelPath)) inbound.add(link.target);
    if (!fileIds.has(link.srcId)) continue;
    if (link.target) continue;
    if (isExternalTarget(link.rawTarget)) continue;

    if (link.kind === "frontmatter" && link.field === "sources") {
      if (!rawSourceExists(ctx, link.rawTarget)) {
        add({
          code: "unresolved-source",
          severity: "warning",
          relPath: link.srcRelPath,
          message: `Frontmatter source "${link.rawTarget}" does not exist below RAW_ROOT.`,
        });
      }
      continue;
    }
    if (link.kind === "frontmatter") {
      if (!knownIds.has(link.rawTarget.toLowerCase())) {
        add({
          code: "unknown-reference",
          severity: "warning",
          relPath: link.srcRelPath,
          message: `Frontmatter "${link.field}" references unknown page "${link.rawTarget}".`,
        });
      }
      continue;
    }
    add({
      code: "dead-link",
      severity: "warning",
      relPath: link.srcRelPath,
      message: `Link target "${link.rawTarget}" (${link.kind}) does not resolve to a page.`,
    });
  }

  for (const file of files) {
    if (isBookkeeping(file.relPath)) continue;
    if (inbound.has(file.relPath)) continue;
    add({
      code: "orphan",
      severity: "info",
      relPath: file.relPath,
      message: "No other page links here - consider linking it from a related page.",
    });
  }

  for (const folder of emptyFolders(ctx.config.wikiRoot)) {
    add({ code: "empty-folder", severity: "info", message: `Folder "${folder}" contains no markdown pages.` });
  }

  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000);
  return {
    checked: files.length,
    findings: findings.slice(0, limit),
    counts,
    truncated: findings.length > limit,
  };
}

function checkEnum(
  add: (finding: Finding) => void,
  file: FileRow,
  field: string,
  value: string | null,
  allowed: readonly string[],
): void {
  if (value === null || allowed.includes(value)) return;
  add({
    code: "invalid-enum",
    severity: "error",
    relPath: file.relPath,
    message: `Frontmatter "${field}" is "${value}", allowed: ${allowed.join(", ")}.`,
  });
}

function basename(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

function isBookkeeping(relPath: string): boolean {
  const base = basename(relPath).toLowerCase();
  return base === "index" || base === "log";
}

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function emptyFolders(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): number => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let markdownCount = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        markdownCount += walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) markdownCount++;
    }
    if (markdownCount === 0 && path.resolve(dir) !== path.resolve(root)) {
      out.push(path.relative(root, dir).split(path.sep).join("/"));
    }
    return markdownCount;
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}
