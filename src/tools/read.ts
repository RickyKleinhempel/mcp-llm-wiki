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
      title: "Read wiki page",
      description:
        "Read a wiki page. With no extra args the full file including frontmatter is returned; " +
        "`section` returns that heading's section; startLine/endLine return a line range.",
      inputSchema: {
        path: z.string().describe("Path relative to the wiki root, e.g. 'concepts/llm-wiki.md'."),
        section: z.string().optional().describe("Heading text whose section to read."),
        startLine: z.number().int().min(1).optional().describe("First line (1-based, inclusive)."),
        endLine: z.number().int().min(1).optional().describe("Last line (1-based, inclusive)."),
        includeFrontmatter: z.boolean().optional().describe("false omits the YAML header (default true)."),
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
      title: "List wiki pages",
      description:
        "List indexed wiki pages with path, id, title, summary, type, status, tags, and updated date. " +
        "Filterable by folder, type, status, and tag.",
      inputSchema: {
        folder: z.string().optional().describe("Only pages in this folder."),
        recursive: z.boolean().optional().describe("Include subfolders (default true)."),
        type: z.enum(PAGE_TYPES).optional(),
        status: z.enum(PAGE_STATUSES).optional(),
        tag: z.string().optional().describe("Only pages with this tag."),
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
      title: "Show folder tree",
      description:
        "Show the wiki folder tree with page counts per folder. " +
        "Call before creating a page so the path matches the existing structure." +
        (ctx.config.structureHint ? ` Convention in this wiki: ${ctx.config.structureHint}` : ""),
      inputSchema: {
        maxDepth: z.number().int().min(0).max(32).optional().describe("Only folders up to this depth."),
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
      title: "List tags",
      description: "List all tags used in the wiki with counts, highest first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => handle(() => ({ tags: listTags(ctx) })),
  );

  server.registerTool(
    "raw_list",
    {
      title: "List source files",
      description:
        "List files in the immutable source layer (RAW_ROOT). This layer is strictly read-only.",
      inputSchema: {
        prefix: z.string().optional().describe("Only files under this prefix."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => ({ files: rawList(ctx, args.prefix) })),
  );

  server.registerTool(
    "raw_read",
    {
      title: "Read source file",
      description: "Read a file from RAW_ROOT, optionally as a line range. There is no write access here.",
      inputSchema: {
        path: z.string().describe("Path relative to RAW_ROOT."),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => rawRead(ctx, args.path, { startLine: args.startLine, endLine: args.endLine })),
  );
}
