#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import type { ServerContext } from "./context.js";
import { openDb } from "./db/open.js";
import { initSchema } from "./db/schema.js";
import { Embedder } from "./indexing/embed.js";
import { Indexer } from "./indexing/indexer.js";
import { WikiWatcher } from "./indexing/watcher.js";
import { log, setLogLevel } from "./logger.js";
import { registerBookkeepingTools } from "./tools/bookkeeping.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerIndexTools } from "./tools/index-ops.js";
import { registerReadTools } from "./tools/read.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWriteTools } from "./tools/write.js";

/**
 * stdio transport: stdout carries the JSON-RPC stream, so every diagnostic must
 * go to stderr. `logger.ts` enforces that; nothing here may use console.log.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv.slice(2));
  setLogLevel(config.logLevel);

  fs.mkdirSync(config.wikiRoot, { recursive: true });
  log.info("starting mcp-llm-wiki", {
    wikiRoot: config.wikiRoot,
    rawRoot: config.rawRoot,
    indexDb: config.indexDb,
    model: config.modelId,
    allowWrite: config.allowWrite,
  });

  const db = openDb(config.indexDb);
  initSchema(db);

  const embedder = new Embedder({
    modelId: config.modelId,
    cacheDir: config.modelCacheDir,
    allowRemoteModels: config.allowRemoteModels,
  });
  const indexer = new Indexer(db, config, embedder);
  const ctx: ServerContext = { config, db, embedder, indexer };

  const server = new McpServer(
    { name: "mcp-llm-wiki", version: "0.1.0" },
    {
      instructions:
        "This wiki is an LLM-maintained knowledge store of Markdown files with YAML frontmatter. " +
        "Start a session with wiki_index_status and wiki_search before writing. " +
        "Always search for an existing page first and extend it with wiki_patch_page instead of creating duplicates. " +
        "When creating a page you choose the path yourself - use wiki_list_folders to match the existing structure " +
        "and only add subfolders when a topic actually needs them. " +
        "After every content change call wiki_append_log, and wiki_update_index if needed. " +
        "The raw layer is immutable: sources are read, never overwritten.",
    },
  );

  registerSearchTools(server, ctx);
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerBookkeepingTools(server, ctx);
  registerGraphTools(server, ctx);
  registerIndexTools(server, ctx);

  const watcher = config.watch ? new WikiWatcher(config, indexer) : undefined;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("connected via stdio");

  // Kick off the first index pass after the transport is up so the client is
  // not blocked by model download and embedding of a large wiki.
  void indexer
    .reindex({ mode: "incremental" })
    .then((result) => {
      log.info("initial index complete", result);
      watcher?.start();
    })
    .catch((error: unknown) => log.error("initial index failed", { error: String(error) }));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    try {
      await watcher?.stop();
      await server.close();
      db.close();
    } catch (error) {
      log.error("shutdown error", { error: String(error) });
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("fatal error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
});
