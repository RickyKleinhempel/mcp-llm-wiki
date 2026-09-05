import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { deletePage, movePage, patchPage, writePage } from "../wiki/pages.js";
import { frontmatterArg, handle } from "./shared.js";

export function registerWriteTools(server: McpServer, ctx: ServerContext): void {
  const hint = ctx.config.structureHint
    ? ` Konvention in diesem Wiki: ${ctx.config.structureHint}`
    : "";

  server.registerTool(
    "wiki_write_page",
    {
      title: "Wiki-Seite schreiben",
      description:
        "Legt eine Wiki-Seite an oder überschreibt sie vollständig. Der Pfad wird bewusst NICHT vom Server abgeleitet: " +
        "Du entscheidest über Ordner und Dateinamen. Fehlende Ordner werden automatisch erstellt. " +
        "Rufe vorher wiki_list_folders auf, um dich an die vorhandene Struktur anzulehnen. " +
        "Der YAML-Header wird ergänzt (id, title, type, created, updated), vorhandene Felder bleiben erhalten. " +
        "Eine bestehende Datei wird nur mit overwrite=true ersetzt - für Teiländerungen ist wiki_patch_page besser." +
        hint,
      inputSchema: {
        path: z
          .string()
          .describe("Zielpfad relativ zum Wiki-Root inklusive .md, z. B. 'konzepte/wissensmanagement/llm-wiki.md'."),
        body: z.string().describe("Markdown-Inhalt ohne YAML-Header."),
        frontmatter: frontmatterArg.optional().describe("Frontmatter-Felder; 'updated' wird immer gesetzt."),
        overwrite: z.boolean().optional().describe("Bestehende Datei ersetzen (Standard false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => writePage(ctx, args)),
  );

  server.registerTool(
    "wiki_patch_page",
    {
      title: "Wiki-Seite ändern",
      description:
        "Ändert eine bestehende Seite gezielt, ohne sie neu zu schreiben. Modi: 'replace-section' und 'append-section' " +
        "(benötigen `section` mit dem Überschriftentext), 'append', 'prepend', 'replace-body'. " +
        "Ohne `mode` wird nur der Frontmatter angepasst. 'updated' wird immer aktualisiert.",
      inputSchema: {
        path: z.string().describe("Pfad relativ zum Wiki-Root."),
        mode: z
          .enum(["replace-section", "append-section", "append", "prepend", "replace-body"])
          .optional()
          .describe("Art der Textänderung; weglassen für reine Frontmatter-Updates."),
        section: z.string().optional().describe("Überschriftentext für die section-Modi."),
        content: z.string().optional().describe("Neuer Text; bei gesetztem `mode` erforderlich."),
        frontmatter: frontmatterArg.optional().describe("Zu setzende Frontmatter-Felder."),
        frontmatterMode: z
          .enum(["merge", "replace"])
          .optional()
          .describe("'merge' (Standard) ergänzt, 'replace' ersetzt den kompletten Header."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => patchPage(ctx, args)),
  );

  server.registerTool(
    "wiki_move_page",
    {
      title: "Seite oder Ordner verschieben",
      description:
        "Verschiebt oder benennt eine Seite bzw. einen ganzen Ordner um und repariert dabei relative Markdown-Links " +
        "(Wikilinks über die id bleiben ohnehin gültig). Mit dryRun=true bekommst du die geplanten Änderungen, " +
        "ohne dass etwas geschrieben wird.",
      inputSchema: {
        from: z.string().describe("Aktueller Pfad (Datei oder Ordner) relativ zum Wiki-Root."),
        to: z.string().describe("Zielpfad relativ zum Wiki-Root."),
        updateLinks: z.boolean().optional().describe("Links in anderen Seiten anpassen (Standard true)."),
        dryRun: z.boolean().optional().describe("Nur planen, nichts schreiben."),
        overwrite: z.boolean().optional().describe("Vorhandenes Ziel überschreiben (Standard false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => movePage(ctx, args)),
  );

  server.registerTool(
    "wiki_delete_page",
    {
      title: "Wiki-Seite löschen",
      description:
        "Verschiebt eine Seite in den Papierkorb (.trash/<Zeitstempel>/) und entfernt sie aus dem Index. " +
        "Erfordert confirm=true. Prüfe vorher mit wiki_backlinks, ob andere Seiten darauf verweisen.",
      inputSchema: {
        path: z.string().describe("Pfad relativ zum Wiki-Root."),
        confirm: z.literal(true).describe("Muss explizit true sein."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => deletePage(ctx, args)),
  );
}
