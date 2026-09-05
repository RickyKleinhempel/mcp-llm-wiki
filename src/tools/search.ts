import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { runSearch } from "../search/search.js";
import { handle, searchFilterArgs } from "./shared.js";

export function registerSearchTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "wiki_search",
    {
      title: "Search wiki",
      description:
        "Hybrid search over the wiki: BM25 (SQLite FTS5) and local CPU vectors combined with Reciprocal Rank Fusion. " +
        "Returns the best hit per page with path, heading path, line range, and a frontmatter excerpt. " +
        "Use mode='bm25' for exact terms, mode='vector' for semantic paraphrases, otherwise 'hybrid'.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language or keyword query."),
        mode: z.enum(["hybrid", "bm25", "vector"]).optional().describe("Search method (default: hybrid)."),
        k: z.number().int().min(1).max(50).optional().describe("Max hits (default 10)."),
        layer: z.enum(["wiki", "raw"]).optional().describe("Layer: 'wiki' (default) or 'raw' (sources)."),
        includeText: z.boolean().optional().describe("Include full chunk text instead of an excerpt."),
        ...searchFilterArgs,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      handle(() =>
        runSearch(ctx.db, ctx.embedder, ctx.config.rrfK, {
          query: args.query,
          mode: args.mode,
          k: args.k,
          layer: args.layer,
          includeText: args.includeText,
          folder: args.folder,
          recursive: args.recursive,
          pathPrefix: args.pathPrefix,
          type: args.type,
          status: args.status,
          tags: args.tags,
        }),
      ),
  );
}
