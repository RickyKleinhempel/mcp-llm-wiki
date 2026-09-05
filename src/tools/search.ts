import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { runSearch } from "../search/search.js";
import { handle, searchFilterArgs } from "./shared.js";

export function registerSearchTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "wiki_search",
    {
      title: "Wiki durchsuchen",
      description:
        "Hybride Suche über das Wiki: BM25 (SQLite FTS5) und lokale CPU-Vektoren werden per Reciprocal Rank Fusion " +
        "kombiniert. Liefert pro Seite den besten Treffer mit Pfad, Überschriftenpfad, Zeilenbereich und Frontmatter-Auszug. " +
        "Nutze mode='bm25' für exakte Begriffe, mode='vector' für semantische Umschreibungen, sonst 'hybrid'.",
      inputSchema: {
        query: z.string().min(1).describe("Suchanfrage in natürlicher Sprache oder als Stichworte."),
        mode: z.enum(["hybrid", "bm25", "vector"]).optional().describe("Suchverfahren (Standard: hybrid)."),
        k: z.number().int().min(1).max(50).optional().describe("Maximale Trefferzahl (Standard 10)."),
        layer: z.enum(["wiki", "raw"]).optional().describe("Ebene: 'wiki' (Standard) oder 'raw' (Quellen)."),
        includeText: z.boolean().optional().describe("Vollständigen Chunk-Text mitliefern statt nur einen Auszug."),
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
