import fs from "node:fs";
import { ToolError, type ServerContext } from "../context.js";
import { resolveInRoot } from "../paths.js";
import { completeFrontmatter, composePage, parsePage, todayIso } from "./frontmatter.js";

/**
 * Append-only chronological journal (`log.md`).
 *
 * Entries use the shape `## [YYYY-MM-DD] <operation> | <title>` so that a plain
 * `grep "^## \[" log.md | tail -5` still reconstructs the recent history without
 * loading the whole file.
 */

export const LOG_REL_PATH = "log.md";

export interface AppendLogResult {
  relPath: string;
  entry: string;
  totalEntries: number;
}

export async function appendLog(
  ctx: ServerContext,
  args: { operation: string; title: string; details?: string; date?: string },
): Promise<AppendLogResult> {
  if (!ctx.config.allowWrite) throw new ToolError("read-only", "This server is running with ALLOW_WRITE=false.");

  const date = args.date ?? todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ToolError("invalid-date", "date must be an ISO date (YYYY-MM-DD).");
  }
  const operation = args.operation.trim().replace(/\s+/g, " ");
  const title = args.title.trim().replace(/\s+/g, " ");
  if (operation.length === 0 || title.length === 0) {
    throw new ToolError("invalid-entry", "operation and title must not be empty.");
  }

  const absPath = resolveInRoot(ctx.config.wikiRoot, LOG_REL_PATH);
  const existingRaw = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : "";
  const parsed = parsePage(existingRaw);

  const heading = `## [${date}] ${operation} | ${title}`;
  const entryLines = [heading];
  if (args.details && args.details.trim().length > 0) {
    entryLines.push("", args.details.trim());
  }
  const entry = entryLines.join("\n");

  const body = parsed.body.trim().length > 0 ? `${parsed.body.replace(/\s*$/, "")}\n\n${entry}` : entry;

  const frontmatter = completeFrontmatter(
    { title: "Log", type: "log", summary: "Chronologisches Protokoll aller Wiki-Operationen." },
    {
      fallbackId: "log",
      fallbackTitle: "Log",
      existing: parsed.data,
      strict: false,
      defaultConfidence: ctx.config.defaultConfidence,
    },
  );

  fs.writeFileSync(absPath, composePage(frontmatter, body), "utf8");
  await ctx.indexer.indexSingle("wiki", LOG_REL_PATH);

  const totalEntries = (body.match(/^## \[\d{4}-\d{2}-\d{2}\]/gm) ?? []).length;
  return { relPath: LOG_REL_PATH, entry: heading, totalEntries };
}

export interface LogEntry {
  date: string;
  operation: string;
  title: string;
}

export function readRecentLog(ctx: ServerContext, limit = 10): LogEntry[] {
  const absPath = resolveInRoot(ctx.config.wikiRoot, LOG_REL_PATH);
  if (!fs.existsSync(absPath)) return [];
  const body = parsePage(fs.readFileSync(absPath, "utf8")).body;
  const entries: LogEntry[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^## \[(\d{4}-\d{2}-\d{2})\]\s*([^|]+?)\s*\|\s*(.+)$/.exec(line);
    if (match) entries.push({ date: match[1], operation: match[2].trim(), title: match[3].trim() });
  }
  return entries.slice(-limit).reverse();
}
