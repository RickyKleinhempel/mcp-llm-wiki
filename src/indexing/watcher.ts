import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import type { Config } from "../config.js";
import { log } from "../logger.js";
import { toRelPath } from "../paths.js";
import type { Indexer, Layer } from "./indexer.js";

/**
 * Optional file-system watcher.
 *
 * Changes are collected and processed after a quiet period so that a bulk edit
 * (or a git checkout) triggers one incremental pass instead of hundreds.
 */
export class WikiWatcher {
  private watcher: FSWatcher | undefined;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(
    private readonly config: Config,
    private readonly indexer: Indexer,
    private readonly debounceMs = 750,
  ) {}

  start(): void {
    if (this.watcher) return;
    const roots = [this.config.wikiRoot];
    if (fs.existsSync(this.config.rawRoot)) roots.push(this.config.rawRoot);

    this.watcher = chokidar.watch(roots, {
      ignored: (candidate: string) => /(^|[\\/])(\.[^\\/]+|node_modules)([\\/]|$)/.test(candidate),
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    for (const event of ["add", "change", "unlink"] as const) {
      this.watcher.on(event, (file: string) => this.enqueue(file));
    }
    this.watcher.on("error", (error: unknown) => log.error("watcher error", { error: String(error) }));
    log.info("watching for changes", { roots });
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
  }

  private enqueue(file: string): void {
    if (!file.toLowerCase().endsWith(".md")) return;
    this.pending.add(file);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), this.debounceMs);
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      this.timer = setTimeout(() => void this.drain(), this.debounceMs);
      return;
    }
    const files = [...this.pending];
    this.pending.clear();
    if (files.length === 0) return;

    this.draining = true;
    try {
      for (const file of files) {
        const layer: Layer = file.toLowerCase().startsWith(this.config.rawRoot.toLowerCase()) ? "raw" : "wiki";
        const root = layer === "raw" ? this.config.rawRoot : this.config.wikiRoot;
        const relPath = toRelPath(root, file);
        if (relPath.startsWith("..")) continue;
        await this.indexer.indexSingle(layer, relPath);
      }
      log.debug("watcher reindexed files", { count: files.length });
    } catch (error) {
      log.error("watcher reindex failed", { error: String(error) });
    } finally {
      this.draining = false;
    }
  }
}
