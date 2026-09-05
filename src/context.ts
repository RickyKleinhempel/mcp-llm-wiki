import type { Config } from "./config.js";
import type { Db } from "./db/open.js";
import type { Embedder } from "./indexing/embed.js";
import type { Indexer } from "./indexing/indexer.js";

export interface ServerContext {
  config: Config;
  db: Db;
  embedder: Embedder;
  indexer: Indexer;
}

/** Errors carrying a stable machine-readable code for tool responses. */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}
