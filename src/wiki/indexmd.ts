import fs from "node:fs";
import path from "node:path";
import { ToolError, type ServerContext } from "../context.js";
import { normalizeRelPath, resolveInRoot } from "../paths.js";
import { completeFrontmatter, composePage, parsePage, todayIso } from "./frontmatter.js";
import { listPages } from "./pages.js";

/**
 * Generates the content-oriented catalogue (`index.md`).
 *
 * Without a scope the root index lists the whole tree grouped by folder; with a
 * scope only that folder is written. Which of the two happens is the model's
 * decision - there is no configured index mode.
 */
export interface UpdateIndexResult {
  relPath: string;
  pages: number;
  bytes: number;
}

export async function updateIndex(
  ctx: ServerContext,
  args: { scope?: string; title?: string } = {},
): Promise<UpdateIndexResult> {
  if (!ctx.config.allowWrite) throw new ToolError("read-only", "This server is running with ALLOW_WRITE=false.");

  const limits = { maxDepth: ctx.config.maxDepth, maxRelPathLength: ctx.config.maxRelPathLength };
  const scope = args.scope ? normalizeRelPath(args.scope, limits, { allowEmpty: true }) : "";
  const relPath = scope === "" ? "index.md" : `${scope}/index.md`;
  const absPath = resolveInRoot(ctx.config.wikiRoot, relPath);

  const { pages } = listPages(ctx, { folder: scope, recursive: true, limit: 1000 });
  const listed = pages.filter((page) => page.relPath !== relPath && !isBookkeepingFile(page.relPath));

  const groups = new Map<string, typeof listed>();
  for (const page of listed) {
    const group = groups.get(page.folder) ?? [];
    group.push(page);
    groups.set(page.folder, group);
  }

  const lines: string[] = [];
  lines.push(scope === "" ? "# Index" : `# Index: ${scope}`);
  lines.push("");
  lines.push(`${listed.length} page(s), as of ${todayIso()}.`);
  lines.push("");

  for (const folder of [...groups.keys()].sort()) {
    lines.push(`## ${folder === "" ? "(root)" : folder}`);
    lines.push("");
    for (const page of groups.get(folder) ?? []) {
      const link = relativeLink(scope, page.relPath);
      const label = page.title ?? page.relPath;
      const meta = [page.type, page.status, page.tags.length > 0 ? page.tags.join(", ") : undefined]
        .filter(Boolean)
        .join(" | ");
      const description = page.summary ? ` - ${page.summary}` : "";
      lines.push(`- [${label}](${link})${description}${meta ? ` _(${meta})_` : ""}`);
    }
    lines.push("");
  }

  const existing = fs.existsSync(absPath) ? parsePage(fs.readFileSync(absPath, "utf8")).data : undefined;
  const frontmatter = completeFrontmatter(
    {
      title: args.title ?? (scope === "" ? "Index" : `Index: ${scope}`),
      type: "index",
      summary: scope === "" ? "Automatically generated full wiki index." : `Index of folder ${scope}.`,
      ...(scope === "" ? {} : { scope }),
    },
    {
      fallbackId: scope === "" ? "index" : `${scope.replace(/\//g, "-")}-index`,
      fallbackTitle: "Index",
      existing,
      strict: false,
      defaultConfidence: ctx.config.defaultConfidence,
    },
  );

  const content = composePage(frontmatter, lines.join("\n"));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  await ctx.indexer.indexSingle("wiki", relPath);

  return { relPath, pages: listed.length, bytes: Buffer.byteLength(content, "utf8") };
}

function isBookkeepingFile(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  return base === "index.md" || base === "log.md";
}

function relativeLink(fromFolder: string, targetRel: string): string {
  const relative = path.posix.relative(fromFolder === "" ? "." : fromFolder, targetRel);
  return encodeURI(relative.startsWith(".") ? relative : `./${relative}`);
}
