import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { updateIndex } from "../wiki/indexmd.js";
import { appendLog, readRecentLog } from "../wiki/logmd.js";
import { handle } from "./shared.js";

export function registerBookkeepingTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "wiki_update_index",
    {
      title: "index.md aktualisieren",
      description:
        "Erzeugt oder aktualisiert eine index.md als Inhaltsverzeichnis. Ohne `scope` entsteht der Gesamtindex im " +
        "Wiki-Root, mit `scope` ein Index für genau diesen Ordner (<scope>/index.md). Die Einträge stammen aus " +
        "Titel und summary der indexierten Seiten - pflege also den Frontmatter, bevor du hier aufräumst.",
      inputSchema: {
        scope: z.string().optional().describe("Ordner, für den der Index erzeugt wird; leer = gesamtes Wiki."),
        title: z.string().optional().describe("Abweichender Titel für die Indexseite."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => handle(() => updateIndex(ctx, args)),
  );

  server.registerTool(
    "wiki_append_log",
    {
      title: "Log-Eintrag anhängen",
      description:
        "Hängt einen Eintrag im Format '## [YYYY-MM-DD] <operation> | <title>' an die log.md im Wiki-Root an. " +
        "Nach jeder inhaltlichen Änderung aufrufen (ingest, update, merge, split, delete, refactor), damit die " +
        "Historie chronologisch nachvollziehbar bleibt.",
      inputSchema: {
        operation: z.string().min(1).describe("Kurzer Operationsname, z. B. 'ingest', 'update', 'merge'."),
        title: z.string().min(1).describe("Betroffene Seite oder Thema."),
        details: z.string().optional().describe("Optionale Erläuterung, wird unter die Überschrift gesetzt."),
        date: z.string().optional().describe("ISO-Datum (YYYY-MM-DD); Standard ist heute."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => appendLog(ctx, args)),
  );

  server.registerTool(
    "wiki_read_log",
    {
      title: "Letzte Log-Einträge lesen",
      description: "Liefert die letzten Einträge aus log.md, neueste zuerst - nützlich als Einstieg in eine Sitzung.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Anzahl der Einträge (Standard 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => ({ entries: readRecentLog(ctx, args.limit ?? 10) })),
  );
}
