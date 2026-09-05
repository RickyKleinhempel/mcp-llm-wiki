import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toRelPath } from "../paths.js";

/** Directories that are never part of the wiki content. */
const ALWAYS_IGNORED = new Set([".llm-wiki", ".trash", ".git", "node_modules", ".obsidian", ".vscode"]);

export interface ScannedFile {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface ScanOptions {
  /** Extra ignore patterns; a leading/trailing `**` is treated as a wildcard. */
  ignoreGlobs?: string[];
  maxFileBytes?: number;
}

/** Recursively collect all `.md` files below `root`, without following symlinks. */
export function scanMarkdown(root: string, options: ScanOptions = {}): ScannedFile[] {
  const results: ScannedFile[] = [];
  if (!fs.existsSync(root)) return results;
  const matchers = (options.ignoreGlobs ?? []).map(globToRegExp);
  walk(root, root, results, matchers, options.maxFileBytes ?? 8 * 1024 * 1024);
  results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return results;
}

function walk(root: string, dir: string, out: ScannedFile[], matchers: RegExp[], maxFileBytes: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Symlinks are skipped entirely: following them could leave the root.
    if (entry.isSymbolicLink()) continue;

    const abs = path.join(dir, entry.name);
    const rel = toRelPath(root, abs);
    if (matchers.some((matcher) => matcher.test(rel))) continue;

    if (entry.isDirectory()) {
      if (ALWAYS_IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(root, abs, out, matchers, maxFileBytes);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.size > maxFileBytes) continue;

    out.push({
      relPath: rel,
      absPath: abs,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      sha256: hashFile(abs),
    });
  }
}

export function hashFile(absPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

export function hashString(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Very small glob subset: `*` (no separator), `**` (any), `?` (one char). */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}
