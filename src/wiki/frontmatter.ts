import YAML from "yaml";
import { z } from "zod";

/**
 * YAML frontmatter: parsing, validation and deterministic serialisation.
 *
 * Every page written by this server carries a frontmatter block. Parsing is
 * deliberately tolerant (it reports problems instead of throwing) so that
 * pre-existing files without a header still index and lint; writing is strict.
 */

export const PAGE_TYPES = ["note", "concept", "source-summary", "howto", "index", "log"] as const;
export const PAGE_STATUSES = ["draft", "stable", "deprecated"] as const;
export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type PageType = (typeof PAGE_TYPES)[number];
export type PageStatus = (typeof PAGE_STATUSES)[number];
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Fixed output order - keeps diffs stable across rewrites. */
export const KEY_ORDER = [
  "id",
  "title",
  "type",
  "status",
  "summary",
  "tags",
  "aliases",
  "sources",
  "related",
  "supersedes",
  "superseded_by",
  "created",
  "updated",
  "confidence",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "must be an ISO date (YYYY-MM-DD)");
const shortString = z.string().trim().min(1).max(200);

export const frontmatterSchema = z
  .object({
    id: shortString,
    title: z.string().trim().min(1).max(300),
    type: z.enum(PAGE_TYPES),
    status: z.enum(PAGE_STATUSES).optional(),
    summary: z.string().trim().max(1000).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    aliases: z.array(shortString).max(50).optional(),
    sources: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
    related: z.array(shortString).max(200).optional(),
    supersedes: z.array(shortString).max(50).optional(),
    superseded_by: shortString.nullable().optional(),
    created: isoDate,
    updated: isoDate,
    confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  })
  .passthrough();

export type Frontmatter = z.infer<typeof frontmatterSchema>;

/** What a tool caller may supply - the server fills id/created/updated. */
export const frontmatterInputSchema = frontmatterSchema.partial().passthrough();
export type FrontmatterInput = z.infer<typeof frontmatterInputSchema>;

/** Upper bound on the YAML block, guards against pathological headers. */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

const YAML_PARSE_OPTIONS = {
  version: "1.2" as const,
  schema: "core" as const,
  customTags: [],
  maxAliasCount: 100,
  logLevel: "silent" as const,
  prettyErrors: false,
};

export interface ParsedPage {
  hasFrontmatter: boolean;
  /** Raw frontmatter object exactly as written (unknown keys preserved). */
  data: Record<string, unknown>;
  body: string;
  /** 1-based line number of the first body line within the original file. */
  bodyStartLine: number;
  errors: string[];
}

export function parsePage(content: string): ParsedPage {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  const noFrontmatter = (errors: string[] = []): ParsedPage => ({
    hasFrontmatter: false,
    data: {},
    body: text,
    bodyStartLine: 1,
    errors,
  });

  if (lines.length === 0 || lines[0].trim() !== "---") {
    return noFrontmatter();
  }

  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      closing = i;
      break;
    }
  }
  if (closing < 0) {
    return noFrontmatter(["Frontmatter block is not terminated by a closing `---`."]);
  }

  const yamlText = lines.slice(1, closing).join("\n");
  if (Buffer.byteLength(yamlText, "utf8") > MAX_FRONTMATTER_BYTES) {
    return noFrontmatter([`Frontmatter block exceeds ${MAX_FRONTMATTER_BYTES} bytes.`]);
  }

  const errors: string[] = [];
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(yamlText, YAML_PARSE_OPTIONS) as unknown;
    if (parsed === null || parsed === undefined) {
      data = {};
    } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    } else {
      errors.push("Frontmatter must be a YAML mapping.");
    }
  } catch (error) {
    errors.push(`Invalid YAML in frontmatter: ${(error as Error).message}`);
  }

  let bodyStart = closing + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;

  return {
    hasFrontmatter: true,
    data,
    body: lines.slice(bodyStart).join("\n"),
    bodyStartLine: bodyStart + 1,
    errors,
  };
}

/** Order known keys first, then any preserved unknown keys alphabetically. */
function orderKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = data[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value.length === 0) continue;
    out[key] = value;
  }
  const extras = Object.keys(data)
    .filter((key) => !(KEY_ORDER as readonly string[]).includes(key))
    .sort();
  for (const key of extras) {
    if (data[key] === undefined) continue;
    out[key] = data[key];
  }
  return out;
}

export function serializeFrontmatter(data: Record<string, unknown>): string {
  const yamlText = YAML.stringify(orderKeys(data), {
    lineWidth: 0,
    nullStr: "null",
    defaultKeyType: "PLAIN",
  });
  return `---\n${yamlText}---\n`;
}

/** Assemble a full page: frontmatter block, one blank line, then the body. */
export function composePage(data: Record<string, unknown>, body: string): string {
  const cleanBody = body.replace(/^\uFEFF/, "").replace(/^\s*\n+/, "").replace(/\s*$/, "");
  return `${serializeFrontmatter(data)}\n${cleanBody}\n`;
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface CompleteOptions {
  /** Page id fallback, normally the file name without `.md`. */
  fallbackId: string;
  fallbackTitle: string;
  /** Frontmatter of the page as it exists on disk, if any. */
  existing?: Record<string, unknown>;
  strict: boolean;
  defaultConfidence?: Confidence;
  now?: Date;
}

/**
 * Fill server-owned fields and validate. `updated` is always set by the server;
 * `created` is preserved from an existing page or defaults to today.
 */
export function completeFrontmatter(input: FrontmatterInput, options: CompleteOptions): Frontmatter {
  const existing = options.existing ?? {};
  const today = todayIso(options.now);

  const merged: Record<string, unknown> = {
    ...input,
    id: firstString(input.id, existing.id, options.fallbackId),
    title: firstString(input.title, existing.title, options.fallbackTitle),
    type: firstString(input.type, existing.type, "note"),
    created: firstString(input.created, existing.created, today),
    updated: today,
  };

  if (merged.confidence === undefined && options.defaultConfidence !== undefined) {
    merged.confidence = options.defaultConfidence;
  }

  if (options.strict) {
    const unknown = Object.keys(merged).filter((key) => !(KEY_ORDER as readonly string[]).includes(key));
    if (unknown.length > 0) {
      throw new Error(`Unknown frontmatter keys (SCHEMA_STRICT is on): ${unknown.join(", ")}`);
    }
  }

  const result = frontmatterSchema.safeParse(merged);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Invalid frontmatter - ${details.join("; ")}`);
  }
  return result.data;
}

/** Merge a partial frontmatter patch onto the existing header. */
export function mergeFrontmatter(
  existing: Record<string, unknown>,
  patch: FrontmatterInput,
  mode: "merge" | "replace",
): Record<string, unknown> {
  if (mode === "replace") return { ...patch };
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/** Best-effort title for pages without frontmatter: first ATX heading, else file name. */
export function inferTitle(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/, 200)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return match[1].trim();
  }
  return fallback;
}

export function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((s) => s.trim());
}
