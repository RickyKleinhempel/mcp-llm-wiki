import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { getMeta, getMetaNumber, hasTable } from "../db/schema.js";
import { handle } from "./shared.js";

export function registerIndexTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "wiki_reindex",
    {
      title: "Index neu aufbauen",
      description:
        "Aktualisiert den Suchindex. 'incremental' (Standard) verarbeitet nur geänderte Dateien, 'full' baut alles neu " +
        "auf. Normalerweise unnötig, weil Schreib-Tools den Index selbst pflegen - nötig nach Änderungen, die an diesem " +
        "Server vorbei am Dateisystem gemacht wurden.",
      inputSchema: {
        mode: z.enum(["incremental", "full"]).optional().describe("Standard: incremental."),
        paths: z.array(z.string()).optional().describe("Nur diese Pfade (relativ zum Wiki-Root) neu einlesen."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => handle(() => ctx.indexer.reindex({ mode: args.mode, paths: args.paths })),
  );

  server.registerTool(
    "wiki_index_status",
    {
      title: "Indexstatus",
      description:
        "Zeigt Konfiguration und Zustand des Index: Wurzelverzeichnisse, Embedding-Modell und Dimension, Anzahl " +
        "Seiten/Chunks/Tags/Links und den Zeitpunkt der letzten Indexierung. Guter erster Aufruf in einer Sitzung.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      handle(() => {
        const count = (sql: string, ...params: unknown[]): number =>
          (ctx.db.prepare(sql).get(...params) as { n: number }).n;
        const lastIndex = getMetaNumber(ctx.db, "last_index");
        const lastFullIndex = getMetaNumber(ctx.db, "last_full_index");

        return {
          config: {
            wikiRoot: ctx.config.wikiRoot,
            rawRoot: ctx.config.rawRoot,
            indexDb: ctx.config.indexDb,
            allowWrite: ctx.config.allowWrite,
            watch: ctx.config.watch,
            schemaStrict: ctx.config.schemaStrict,
            maxDepth: ctx.config.maxDepth,
            structureHint: ctx.config.structureHint ?? null,
          },
          model: {
            id: getMeta(ctx.db, "model_id") ?? ctx.config.modelId,
            dim: getMetaNumber(ctx.db, "dim") ?? null,
            loaded: ctx.embedder.isLoaded,
            vectorTable: hasTable(ctx.db, "chunk_vec"),
          },
          counts: {
            wikiPages: count("SELECT COUNT(*) AS n FROM files WHERE layer = 'wiki'"),
            rawFiles: count("SELECT COUNT(*) AS n FROM files WHERE layer = 'raw'"),
            chunks: count("SELECT COUNT(*) AS n FROM chunks"),
            tags: count("SELECT COUNT(DISTINCT tag) AS n FROM tags"),
            links: count("SELECT COUNT(*) AS n FROM links"),
            unresolvedLinks: count("SELECT COUNT(*) AS n FROM links WHERE target_rel_path IS NULL"),
          },
          lastIndex: lastIndex ? new Date(lastIndex).toISOString() : null,
          lastFullIndex: lastFullIndex ? new Date(lastFullIndex).toISOString() : null,
        };
      }),
  );
}
