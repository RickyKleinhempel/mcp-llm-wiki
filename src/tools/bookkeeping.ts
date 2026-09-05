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
      title: "Update index.md",
      description:
        "Create or refresh an index.md catalogue. With no `scope` this is the root index; with `scope` it writes " +
        "<scope>/index.md. Entries come from indexed page titles and summaries - keep frontmatter current before calling.",
      inputSchema: {
        scope: z.string().optional().describe("Folder to index; omit for the whole wiki."),
        title: z.string().optional().describe("Override title for the index page."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => handle(() => updateIndex(ctx, args)),
  );

  server.registerTool(
    "wiki_append_log",
    {
      title: "Append log entry",
      description:
        "Append an entry in the form '## [YYYY-MM-DD] <operation> | <title>' to log.md at the wiki root. " +
        "Call after every content change (ingest, update, merge, split, delete, refactor) so history stays chronological.",
      inputSchema: {
        operation: z.string().min(1).describe("Short operation name, e.g. 'ingest', 'update', 'merge'."),
        title: z.string().min(1).describe("Affected page or topic."),
        details: z.string().optional().describe("Optional note placed under the heading."),
        date: z.string().optional().describe("ISO date (YYYY-MM-DD); default today."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handle(() => appendLog(ctx, args)),
  );

  server.registerTool(
    "wiki_read_log",
    {
      title: "Read recent log entries",
      description: "Return the latest log.md entries, newest first - useful at the start of a session.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Number of entries (default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handle(() => ({ entries: readRecentLog(ctx, args.limit ?? 10) })),
  );
}
