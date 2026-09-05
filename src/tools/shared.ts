import { z } from "zod";
import { ToolError } from "../context.js";
import { PathError } from "../paths.js";
import { CONFIDENCE_LEVELS, PAGE_STATUSES, PAGE_TYPES } from "../wiki/frontmatter.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(code: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, ...extra } }, null, 2) }],
    isError: true,
  };
}

/** Uniform error mapping so the model always sees a machine-readable code. */
export async function handle<T>(fn: () => Promise<T> | T): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof PathError) return fail(error.code, error.message);
    if (error instanceof ToolError) return fail(error.code, error.message);
    if (error instanceof z.ZodError) {
      return fail("invalid-arguments", error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return fail("internal-error", error instanceof Error ? error.message : String(error));
  }
}

/** Frontmatter fields a caller may supply; unknown keys are preserved. */
export const frontmatterArg = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    type: z.enum(PAGE_TYPES).optional(),
    status: z.enum(PAGE_STATUSES).optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    aliases: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
    related: z.array(z.string()).optional(),
    supersedes: z.array(z.string()).optional(),
    superseded_by: z.string().nullable().optional(),
    created: z.string().optional(),
    confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  })
  .passthrough();

export const searchFilterArgs = {
  folder: z.string().optional().describe("Restrict to this folder, relative to the wiki root."),
  recursive: z.boolean().optional().describe("Include subfolders of `folder` (default true)."),
  pathPrefix: z.string().optional().describe("Restrict to paths starting with this prefix."),
  type: z.enum(PAGE_TYPES).optional().describe("Restrict to a frontmatter type."),
  status: z.enum(PAGE_STATUSES).optional().describe("Restrict to a frontmatter status."),
  tags: z.array(z.string()).optional().describe("Only pages carrying all of these tags."),
};
