import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { deletePage, movePage, patchPage, writePage } from "../wiki/pages.js";
import { frontmatterArg, handle } from "./shared.js";

export function registerWriteTools(server: McpServer, ctx: ServerContext): void {
  const hint = ctx.config.structureHint
    ? ` Convention in this wiki: ${ctx.config.structureHint}`
    : "";

  server.registerTool(
    "wiki_write_page",
    {
      title: "Write wiki page",
      description:
        "Create or fully overwrite a wiki page. The path is deliberately NOT derived by the server: " +
        "you choose the folder and filename. Missing folders are created automatically. " +
        "Call wiki_list_folders first so the path matches the existing structure. " +
        "The YAML header is completed (id, title, type, created, updated); existing fields are kept. " +
        "An existing file is replaced only with overwrite=true - use wiki_patch_page for partial edits." +
        hint,
      inputSchema: {
        path: z
          .string()
          .describe("Target path relative to the wiki root, including .md, e.g. 'concepts/knowledge-management/llm-wiki.md'."),
        body: z.string().describe("Markdown body without the YAML header."),
        frontmatter: frontmatterArg.optional().describe("Frontmatter fields; 'updated' is always set."),
        overwrite: z.boolean().optional().describe("Replace an existing file (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => writePage(ctx, args)),
  );

  server.registerTool(
    "wiki_patch_page",
    {
      title: "Patch wiki page",
      description:
        "Change an existing page without rewriting it. Modes: 'replace-section' and 'append-section' " +
        "(require `section` with the heading text), 'append', 'prepend', 'replace-body'. " +
        "Omit `mode` to update frontmatter only. 'updated' is always refreshed.",
      inputSchema: {
        path: z.string().describe("Path relative to the wiki root."),
        mode: z
          .enum(["replace-section", "append-section", "append", "prepend", "replace-body"])
          .optional()
          .describe("Kind of text change; omit for frontmatter-only updates."),
        section: z.string().optional().describe("Heading text for the section modes."),
        content: z.string().optional().describe("New text; required when `mode` is set."),
        frontmatter: frontmatterArg.optional().describe("Frontmatter fields to set."),
        frontmatterMode: z
          .enum(["merge", "replace"])
          .optional()
          .describe("'merge' (default) fills in, 'replace' replaces the whole header."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => patchPage(ctx, args)),
  );

  server.registerTool(
    "wiki_move_page",
    {
      title: "Move page or folder",
      description:
        "Move or rename a page or a whole folder and rewrite relative Markdown links " +
        "(id-based wikilinks stay valid). With dryRun=true you get the planned changes " +
        "without writing anything.",
      inputSchema: {
        from: z.string().describe("Current path (file or folder) relative to the wiki root."),
        to: z.string().describe("Target path relative to the wiki root."),
        updateLinks: z.boolean().optional().describe("Rewrite links on other pages (default true)."),
        dryRun: z.boolean().optional().describe("Plan only, do not write."),
        overwrite: z.boolean().optional().describe("Overwrite an existing target (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => movePage(ctx, args)),
  );

  server.registerTool(
    "wiki_delete_page",
    {
      title: "Delete wiki page",
      description:
        "Move a page to the trash (.trash/<timestamp>/) and drop it from the index. " +
        "Requires confirm=true. Check wiki_backlinks first to see if other pages link here.",
      inputSchema: {
        path: z.string().describe("Path relative to the wiki root."),
        confirm: z.literal(true).describe("Must be explicitly true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => deletePage(ctx, args)),
  );
}
