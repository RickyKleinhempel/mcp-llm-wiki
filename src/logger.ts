/**
 * Logging for a stdio MCP server.
 *
 * stdout is owned by the JSON-RPC transport - writing anything to it breaks the
 * protocol stream. Every log line therefore goes to stderr.
 */

import process from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: Exclude<LogLevel, "silent">, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  let line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (extra !== undefined) {
    line += ` ${stringify(extra)}`;
  }
  process.stderr.write(`${line}\n`);
}

function stringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => emit("debug", message, extra),
  info: (message: string, extra?: unknown) => emit("info", message, extra),
  warn: (message: string, extra?: unknown) => emit("warn", message, extra),
  error: (message: string, extra?: unknown) => emit("error", message, extra),
};
