import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { log } from "../logger.js";

export type Db = Database.Database;

/** Open (and create) the index database with sqlite-vec loaded. */
export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  sqliteVec.load(db);
  const { vec_version: vecVersion } = db.prepare("select vec_version() as vec_version").get() as {
    vec_version: string;
  };
  log.debug("sqlite-vec loaded", { version: vecVersion, file });

  return db;
}
