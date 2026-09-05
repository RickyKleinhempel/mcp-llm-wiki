import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { PAGE_STATUSES, PAGE_TYPES } from "../wiki/frontmatter.js";
import { listFolders, listPages, listTags, rawList, rawRead, readPage } from "../wiki/pages.js";
import { handle } from "./shared.js";

export function registerReadTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "wiki_read_page",
    {
      title: "Wiki-Seite lesen",
      description:
        "Liest eine Wiki-Seite. Ohne weitere Parameter kommt die komplette Datei inklusive Frontmatter zurück; " +
        "mit `section` nur der Abschnitt unter der angegebenen Überschrift, mit startLine/endLine ein Zeilenbereich.",
      inputSchema: {
        path: z.string().describe("Pfad relativ zum Wiki-Root, z. B. 'konzepte/llm-wiki.md'."),
        section: z.string().optional().describe("Überschriftentext, dessen Abschnitt gelesen werden soll."),
        startLine: z.number().int().min(1).optional().describe("Erste Zeile (1-basiert, inklusive)."),
        endLine: z.number().int().min(1).optional().describe("Letzte Zeile (1-basiert, inklusive)."),
        includeFrontmatter: z.boolean().optional().describe("false blendet den YAML-Header aus (Standard true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      handle(() =>
        readPage(ctx, args.path, {
          section: args.section,
          startLine: args.startLine,
          endLine: args.endLine,
          includeFrontmatter: args.includeFrontmatter,
        }),
      ),
  );

  server.registerTool(
    "wiki_list_pages",
    {
      title: "Wiki-Seiten auflisten",
      description:
        "Listet indexierte Wiki-Seiten mit Pfad, id, Titel, Zusammenfassung, Typ, Status, Tags und Änderungsdatum. " +
        "Filterbar nach Ordner, Typ, Status und Tag.",
      inputSchema: {
        folder: z.string().optional().describe("Nur Seiten in diesem Ordner."),
        recursive: z.boolean().optional().describe("Unterordner einschließen (Standard true)."),
        type: z.enum(PAGE_TYPES).optional(),
        status: z.enum(PAGE_STATUSES).optional(),
        tag: z.string().optional().describe("Nur Seiten mit diesem Tag."),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => listPages(ctx, args)),
  );

  server.registerTool(
    "wiki_list_folders",
    {
      title: "Ordnerbaum anzeigen",
      description:
        "Zeigt den bestehenden Ordnerbaum des Wikis mit Seitenzahlen je Ordner. " +
        "Vor dem Anlegen einer neuen Seite aufrufen, um den Pfad konsistent zur vorhandenen Struktur zu wählen." +
        (ctx.config.structureHint ? ` Konvention in diesem Wiki: ${ctx.config.structureHint}` : ""),
      inputSchema: {
        maxDepth: z.number().int().min(0).max(32).optional().describe("Nur Ordner bis zu dieser Tiefe."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      handle(() => ({
        structureHint: ctx.config.structureHint ?? null,
        folders: listFolders(ctx, args.maxDepth),
      })),
  );

  server.registerTool(
    "wiki_list_tags",
    {
      title: "Tags auflisten",
      description: "Listet alle im Wiki vergebenen Tags mit Häufigkeit, absteigend sortiert.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => handle(() => ({ tags: listTags(ctx) })),
  );

  server.registerTool(
    "raw_list",
    {
      title: "Quelldateien auflisten",
      description:
        "Listet Dateien in der unveränderlichen Quellenebene (RAW_ROOT). Diese Ebene ist strikt schreibgeschützt.",
      inputSchema: {
        prefix: z.string().optional().describe("Nur Dateien unterhalb dieses Präfixes."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => ({ files: rawList(ctx, args.prefix) })),
  );

  server.registerTool(
    "raw_read",
    {
      title: "Quelldatei lesen",
      description: "Liest eine Datei aus RAW_ROOT, optional als Zeilenbereich. Schreibzugriff gibt es hier nicht.",
      inputSchema: {
        path: z.string().describe("Pfad relativ zu RAW_ROOT."),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => rawRead(ctx, args.path, { startLine: args.startLine, endLine: args.endLine })),
  );
}
