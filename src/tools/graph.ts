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
      title: "Verlinkungen einer Seite",
      description:
        "Zeigt, welche Seiten auf die angegebene Seite verweisen (inbound), wohin sie selbst verlinkt (outbound) und " +
        "welche ihrer Verweise ins Leere laufen. Vor dem Löschen, Verschieben oder Zusammenführen aufrufen.",
      inputSchema: {
        path: z.string().describe("Pfad relativ zum Wiki-Root."),
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
      title: "Wiki prüfen",
      description:
        "Prüft das Wiki auf Frontmatter-Fehler, ungültige Datumsangaben, doppelte ids, tote Links, nicht auflösbare " +
        "Quellen, verwaiste Seiten und leere Ordner. Es wird nichts verändert - das Ergebnis ist eine Arbeitsliste. " +
        "Die Ordnerstruktur selbst wird nicht bewertet, nur ihre technischen Grenzen (Tiefe, Pfadlänge).",
      inputSchema: {
        folder: z.string().optional().describe("Nur diesen Ordner samt Unterordnern prüfen."),
        checks: z.array(z.enum(LINT_CHECKS)).optional().describe("Nur diese Prüfungen ausführen."),
        limit: z.number().int().min(1).max(2000).optional().describe("Maximale Anzahl gemeldeter Befunde."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => lintWiki(ctx, args)),
  );
}
