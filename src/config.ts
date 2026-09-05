import path from "node:path";
import { z } from "zod";
import type { LogLevel } from "./logger.js";

/**
 * Server configuration.
 *
 * Sources, in ascending precedence: defaults -> environment (mcp.json `env`) -> CLI flags.
 */
export interface Config {
  wikiRoot: string;
  rawRoot: string;
  indexDb: string;
  modelId: string;
  modelCacheDir: string;
  allowRemoteModels: boolean;
  chunkChars: number;
  chunkOverlap: number;
  watch: boolean;
  allowWrite: boolean;
  rrfK: number;
  logLevel: LogLevel;
  schemaStrict: boolean;
  defaultConfidence?: "low" | "medium" | "high";
  maxDepth: number;
  maxRelPathLength: number;
  structureHint?: string;
  ignoreGlobs: string[];
  maxReadBytes: number;
}

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

const rawSchema = z.object({
  wikiRoot: z.string().min(1, "WIKI_ROOT is required (set it in mcp.json env or pass --wiki-root)"),
  rawRoot: z.string().optional(),
  indexDb: z.string().optional(),
  modelId: z.string().min(1).default("Xenova/multilingual-e5-small"),
  modelCacheDir: z.string().optional(),
  allowRemoteModels: z.boolean().default(true),
  chunkChars: z.number().int().min(200).max(8000).default(1200),
  chunkOverlap: z.number().int().min(0).max(2000).default(180),
  watch: z.boolean().default(false),
  allowWrite: z.boolean().default(true),
  rrfK: z.number().int().min(1).max(1000).default(60),
  logLevel: z.enum(LOG_LEVELS).default("info"),
  schemaStrict: z.boolean().default(false),
  defaultConfidence: z.enum(["low", "medium", "high"]).optional(),
  maxDepth: z.number().int().min(1).max(32).default(8),
  maxRelPathLength: z.number().int().min(32).max(1000).default(240),
  structureHint: z.string().max(2000).optional(),
  ignoreGlobs: z.array(z.string()).default([]),
  maxReadBytes: z.number().int().min(1024).default(2 * 1024 * 1024),
});

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`Expected a boolean value, got ${JSON.stringify(value)}`);
}

function parseInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer, got ${JSON.stringify(value)}`);
  return n;
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Minimal `--key value` / `--key=value` / `--flag` parser. */
export function parseArgv(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[body] = next;
      i++;
    } else {
      out[body] = "true";
    }
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): Config {
  const args = parseArgv(argv);
  const pick = (argKey: string, envKey: string): string | undefined => args[argKey] ?? env[envKey];

  const parsed = rawSchema.parse({
    wikiRoot: pick("wiki-root", "WIKI_ROOT"),
    rawRoot: pick("raw-root", "RAW_ROOT"),
    indexDb: pick("index-db", "INDEX_DB"),
    modelId: pick("model", "MODEL_ID"),
    modelCacheDir: pick("model-cache-dir", "MODEL_CACHE_DIR"),
    allowRemoteModels: parseBool(pick("allow-remote-models", "ALLOW_REMOTE_MODELS")),
    chunkChars: parseInteger(pick("chunk-chars", "CHUNK_CHARS"), "CHUNK_CHARS"),
    chunkOverlap: parseInteger(pick("chunk-overlap", "CHUNK_OVERLAP"), "CHUNK_OVERLAP"),
    watch: parseBool(pick("watch", "WATCH")),
    allowWrite: parseBool(pick("allow-write", "ALLOW_WRITE")),
    rrfK: parseInteger(pick("rrf-k", "RRF_K"), "RRF_K"),
    logLevel: pick("log-level", "LOG_LEVEL")?.toLowerCase(),
    schemaStrict: parseBool(pick("schema-strict", "SCHEMA_STRICT")),
    defaultConfidence: pick("default-confidence", "DEFAULT_CONFIDENCE"),
    maxDepth: parseInteger(pick("max-depth", "MAX_DEPTH"), "MAX_DEPTH"),
    maxRelPathLength: parseInteger(pick("max-path-length", "MAX_PATH_LENGTH"), "MAX_PATH_LENGTH"),
    structureHint: pick("structure-hint", "STRUCTURE_HINT"),
    ignoreGlobs: parseList(pick("ignore-globs", "IGNORE_GLOBS")),
    maxReadBytes: parseInteger(pick("max-read-bytes", "MAX_READ_BYTES"), "MAX_READ_BYTES"),
  });

  const wikiRoot = path.resolve(parsed.wikiRoot);
  const rawRoot = path.resolve(parsed.rawRoot ?? path.join(wikiRoot, "..", "raw"));
  const indexDb = path.resolve(parsed.indexDb ?? path.join(wikiRoot, ".llm-wiki", "index.db"));
  const modelCacheDir = path.resolve(parsed.modelCacheDir ?? path.join(path.dirname(indexDb), "models"));

  if (chunkOverlapTooLarge(parsed.chunkOverlap, parsed.chunkChars)) {
    throw new Error("CHUNK_OVERLAP must be smaller than CHUNK_CHARS");
  }

  return {
    ...parsed,
    wikiRoot,
    rawRoot,
    indexDb,
    modelCacheDir,
  };
}

function chunkOverlapTooLarge(overlap: number, chars: number): boolean {
  return overlap >= chars;
}
