import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError, type ServerContext } from "../context.js";
import { backlinksFor } from "../wiki/links.js";
import { lintWiki } from "../wiki/lint.js";
import { wikiPath } from "../wiki/pages.js";
import { handle } from "./shared.js";

const LINT_CHECKS = [
  "missing-frontmatter",
  "missing-required-field",
  "invalid-enum",
  "invalid-date",
  "stale-updated",
  "superseded-without-deprecated",
  "unknown-frontmatter-keys",
  "id-path-mismatch",
  "ambiguous-id",
  "too-deep",
  "path-too-long",
  "empty-stub",
  "unresolved-source",
  "unknown-reference",
  "dead-link",
  "orphan",
  "empty-folder",
] as const;

export function registerGraphTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "wiki_backlinks",
    {
      title: "Page links",
      description:
        "Show which pages link to this page (inbound), where it links (outbound), and which of its links are dead. " +
        "Call before delete, move, or merge.",
      inputSchema: {
        path: z.string().describe("Path relative to the wiki root."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      handle(() => {
        const { relPath } = wikiPath(ctx, args.path);
        const known = ctx.db
          .prepare("SELECT 1 FROM files WHERE layer = 'wiki' AND rel_path = ?")
          .get(relPath);
        if (!known) throw new ToolError("not-found", `${relPath} is not indexed. Run wiki_reindex if it is new.`);
        return backlinksFor(ctx.db, relPath);
      }),
  );

  server.registerTool(
    "wiki_lint",
    {
      title: "Lint wiki",
      description:
        "Check the wiki for frontmatter errors, invalid dates, duplicate ids, dead links, unresolved sources, " +
        "orphan pages, and empty folders. Nothing is changed - the result is a work list. " +
        "Folder layout is not judged, only technical limits (depth, path length).",
      inputSchema: {
        folder: z.string().optional().describe("Check only this folder and its subfolders."),
        checks: z.array(z.enum(LINT_CHECKS)).optional().describe("Run only these checks."),
        limit: z.number().int().min(1).max(2000).optional().describe("Max findings to report."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => lintWiki(ctx, args)),
  );
}
