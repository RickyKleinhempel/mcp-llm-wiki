import fs from "node:fs";
import path from "node:path";

/**
 * Path safety for every LLM-supplied path.
 *
 * The wiki tree is free-form - the model decides where a page lives - so this
 * module enforces boundaries only, never conventions:
 *   - relative, POSIX-normalised paths below the configured root
 *   - no `..`, no absolute paths, no NUL bytes, no symlink escapes
 *   - no Windows reserved device names, no trailing dots/spaces
 *   - depth and length limits
 */

export class PathError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PathError";
    this.code = code;
  }
}

/** `CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9` - reserved on Windows even with an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export interface PathLimits {
  maxDepth: number;
  maxRelPathLength: number;
}

/**
 * Validate and normalise a caller-supplied relative path.
 * Returns a POSIX-style path such as `konzepte/wissensmanagement/llm-wiki.md`.
 */
export function normalizeRelPath(input: string, limits: PathLimits, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof input !== "string") {
    throw new PathError("invalid-path", "Path must be a string.");
  }
  if (input.includes("\0")) {
    throw new PathError("invalid-path", "Path must not contain NUL bytes.");
  }

  const unified = input.replace(/\\/g, "/").trim();

  if (unified.length === 0 || unified === "." || unified === "./") {
    if (opts.allowEmpty) return "";
    throw new PathError("invalid-path", "Path must not be empty.");
  }
  if (unified.startsWith("/") || unified.startsWith("//")) {
    throw new PathError("absolute-path", `Path must be relative to the root, got ${JSON.stringify(input)}.`);
  }
  if (/^[a-zA-Z]:/.test(unified)) {
    throw new PathError("absolute-path", `Path must be relative to the root, got ${JSON.stringify(input)}.`);
  }

  const segments: string[] = [];
  for (const rawSegment of unified.split("/")) {
    const segment = rawSegment.trim();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new PathError("traversal", `Path must not contain "..", got ${JSON.stringify(input)}.`);
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new PathError("reserved-name", `"${segment}" is a reserved device name on Windows.`);
    }
    if (/[<>:"|?*]/.test(segment)) {
      throw new PathError("invalid-path", `Segment "${segment}" contains characters that are illegal in file names.`);
    }
    if (segment.endsWith(".") || rawSegment !== segment) {
      throw new PathError("invalid-path", `Segment "${rawSegment}" must not start or end with a space or a dot.`);
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    if (opts.allowEmpty) return "";
    throw new PathError("invalid-path", "Path must not be empty.");
  }

  const rel = segments.join("/");
  if (rel.length > limits.maxRelPathLength) {
    throw new PathError(
      "path-too-long",
      `Path is ${rel.length} characters, limit is ${limits.maxRelPathLength}.`,
    );
  }
  const folderDepth = segments.length - 1;
  if (folderDepth > limits.maxDepth) {
    throw new PathError("too-deep", `Path nests ${folderDepth} folders, limit is ${limits.maxDepth}.`);
  }

  return rel;
}

/** Same as {@link normalizeRelPath} but additionally requires a `.md` extension. */
export function normalizeMarkdownRelPath(input: string, limits: PathLimits): string {
  const rel = normalizeRelPath(input, limits);
  if (!rel.toLowerCase().endsWith(".md")) {
    throw new PathError("not-markdown", `Only .md files are supported, got ${JSON.stringify(input)}.`);
  }
  return rel;
}

/**
 * Resolve a validated relative path inside `root` and verify it cannot escape,
 * including through symlinks on any existing path component.
 */
export function resolveInRoot(root: string, relPath: string): string {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relPath);
  assertInside(absoluteRoot, absolute);

  const realRoot = realpathOrSelf(absoluteRoot);
  const realTarget = realpathOfNearestExisting(absolute);
  assertInside(realRoot, realTarget);

  return absolute;
}

function assertInside(root: string, candidate: string): void {
  const normalizedRoot = stripTrailingSep(path.resolve(root));
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return;
  if (normalizedCandidate.startsWith(normalizedRoot + path.sep)) return;
  throw new PathError("outside-root", "Resolved path escapes the configured root.");
}

function stripTrailingSep(p: string): string {
  return p.endsWith(path.sep) && p.length > 1 ? p.slice(0, -1) : p;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * `fs.realpath` fails for paths that do not exist yet (new pages), so walk up to
 * the nearest existing ancestor, resolve that, and re-append the missing tail.
 */
function realpathOfNearestExisting(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    if (fs.existsSync(current)) {
      return path.join(realpathOrSelf(current), ...tail.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.push(path.basename(current));
    current = parent;
  }
}

/** Convert an absolute path below `root` into a POSIX relative path. */
export function toRelPath(root: string, absolute: string): string {
  return path.relative(path.resolve(root), path.resolve(absolute)).split(path.sep).join("/");
}

/** Folder portion of a relative path (`''` for files at the root). */
export function folderOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx < 0 ? "" : relPath.slice(0, idx);
}

/** Number of folder levels a relative path sits in. */
export function depthOf(relPath: string): number {
  const folder = folderOf(relPath);
  return folder === "" ? 0 : folder.split("/").length;
}

/** File name without the `.md` extension - the conventional page id. */
export function baseNameWithoutMd(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}
