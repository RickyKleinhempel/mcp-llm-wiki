# mcp-llm-wiki

MCP server for a wiki an LLM maintains itself: Markdown files with YAML frontmatter,
searchable via BM25 **and** vectors computed locally on the CPU. No cloud service, no
embedding API, no external database.

The idea comes from `llm-wiki.md` / `idee.md`: three layers (immutable sources, a wiki
owned by the model, schema as `AGENTS.md`) and three operations (Ingest, Query, Lint).

## Layout

```
raw/     immutable sources        -> read-only
wiki/    the wiki itself          -> Markdown + YAML frontmatter
         .llm-wiki/index.db       -> SQLite: FTS5, sqlite-vec, metadata, link graph
         .llm-wiki/models/        -> downloaded embedding model
```

The server does **not** enforce folder conventions. It enforces safety (no escape from the
wiki directory), valid frontmatter, and a current index. Where a page belongs is the model's
decision - `wiki_write_page` therefore requires an explicit `path`.

## Installation

No install needed if you start the server with `npx` (see Wiring). Otherwise:

```powershell
npm install -g mcp-llm-wiki
```

From a clone:

```powershell
cd mcp-llm-wiki
npm install
npm run build
```

On first start Transformers.js downloads the model `Xenova/multilingual-e5-small` (~120 MB,
384 dimensions, German and English) into `MODEL_CACHE_DIR`. After that everything runs offline;
`ALLOW_REMOTE_MODELS=false` blocks the download.

## Wiring

`.vscode/mcp.json` via `npx` (no global install):

```json
{
  "servers": {
    "llm-wiki": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-llm-wiki"],
      "env": {
        "WIKI_ROOT": "${workspaceFolder}/wiki",
        "RAW_ROOT": "${workspaceFolder}/raw"
      }
    }
  }
}
```

After `npm install -g mcp-llm-wiki`:

```json
{
  "servers": {
    "llm-wiki": {
      "type": "stdio",
      "command": "mcp-llm-wiki",
      "env": {
        "WIKI_ROOT": "${workspaceFolder}/wiki",
        "RAW_ROOT": "${workspaceFolder}/raw"
      }
    }
  }
}
```

From a clone, use `"command": "node"` and `"args": ["${workspaceFolder}/mcp-llm-wiki/dist/index.js"]`.

Copy `templates/AGENTS.md` from the package to `wiki/AGENTS.md` and adapt it - conventions live there, not in the server config. After a global install the template is at `$(npm root -g)/mcp-llm-wiki/templates/AGENTS.md`.

## Configuration

Every value can be set as an environment variable (`mcp.json` → `env`) or as a CLI flag;
CLI overrides environment overrides the default.

| Variable | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `WIKI_ROOT` | `--wiki-root` | **required** | Wiki root. |
| `RAW_ROOT` | `--raw-root` | `<WIKI_ROOT>/../raw` | Source layer, read-only. |
| `INDEX_DB` | `--index-db` | `<WIKI_ROOT>/.llm-wiki/index.db` | SQLite file. |
| `MODEL_ID` | `--model` | `Xenova/multilingual-e5-small` | Embedding model. |
| `MODEL_CACHE_DIR` | `--model-cache-dir` | `<INDEX_DB-dir>/models` | Model cache. |
| `ALLOW_REMOTE_MODELS` | `--allow-remote-models` | `true` | Allow download. |
| `CHUNK_CHARS` | `--chunk-chars` | `1200` | Target chunk size. |
| `CHUNK_OVERLAP` | `--chunk-overlap` | `180` | Overlap when splitting long sections. |
| `WATCH` | `--watch` | `false` | Watch the filesystem. |
| `ALLOW_WRITE` | `--allow-write` | `true` | `false` disables all write tools. |
| `RRF_K` | `--rrf-k` | `60` | Rank-fusion constant. |
| `SCHEMA_STRICT` | `--schema-strict` | `false` | Reject unknown frontmatter fields. |
| `DEFAULT_CONFIDENCE` | `--default-confidence` | - | Default for `confidence`. |
| `MAX_DEPTH` | `--max-depth` | `8` | Maximum folder depth. |
| `MAX_PATH_LENGTH` | `--max-path-length` | `240` | Maximum path length. |
| `STRUCTURE_HINT` | `--structure-hint` | - | Injected into tool descriptions. |
| `IGNORE_GLOBS` | `--ignore-globs` | - | Comma-separated extra ignore patterns. |
| `MAX_READ_BYTES` | `--max-read-bytes` | `2097152` | Read size cap. |
| `LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |

## Tools

**Search and read**

| Tool | Purpose |
| --- | --- |
| `wiki_search` | Hybrid search (BM25 + vectors, Reciprocal Rank Fusion). Modes `hybrid`, `bm25`, `vector`. |
| `wiki_read_page` | Whole page, section (`section`), or line range. |
| `wiki_list_pages` | Page list with frontmatter, filterable by folder, type, status, tag. |
| `wiki_list_folders` | Folder tree with page counts - before creating a page. |
| `wiki_list_tags` | All tags with counts. |
| `raw_list`, `raw_read` | Access to the source layer. |

**Write**

| Tool | Purpose |
| --- | --- |
| `wiki_write_page` | Create or replace a page. `path` is required; missing folders are created. |
| `wiki_patch_page` | `replace-section`, `append-section`, `append`, `prepend`, `replace-body`, or frontmatter only. |
| `wiki_move_page` | Move a file or folder; relative links are rewritten (`dryRun` available). |
| `wiki_delete_page` | Moves to `.trash/<timestamp>/`, requires `confirm: true`. |

**Bookkeeping and maintenance**

| Tool | Purpose |
| --- | --- |
| `wiki_update_index` | Writes `index.md` - global or for a folder (`scope`). |
| `wiki_append_log`, `wiki_read_log` | Chronology in `log.md` as `## [YYYY-MM-DD] op \| title`. |
| `wiki_backlinks` | Inbound and outbound links, including dead ones. |
| `wiki_lint` | Frontmatter, dates, duplicate ids, dead links, orphans, empty folders. |
| `wiki_reindex`, `wiki_index_status` | Rebuild the index or query its state. |

## How search works

1. Each file is split on headings; sections that are still too long are split on paragraphs
   with overlap. The heading path (`H1 > H2`) stays attached to the chunk.
2. BM25 runs over FTS5 with weighted columns (text, heading path, title, summary, tags).
   Queries are wrapped in quotes so FTS5 operators do not leak through;
   `AND` is tried first, then `OR`.
3. Vector search uses `sqlite-vec` with cosine distance. The e5 model needs prefixes
   (`passage:` when indexing, `query:` when searching) - the server adds them.
4. Both rankings are merged with Reciprocal Rank Fusion, then the best chunk per page remains.

## Security

- Every path is normalized and checked against the root (`..`, absolute paths, UNC, reserved
  Windows names, control characters). `realpath` is also used so symlinks cannot escape;
  indexing skips symlinks entirely.
- `RAW_ROOT` is read-only.
- Delete means move to the trash and requires an explicit confirmation.
- All SQL access uses parameters, never string concatenation.

### Known vulnerabilities in dependencies

`onnxruntime-node` 1.24 (pulled by `@huggingface/transformers`) still declares `adm-zip@0.5` and
`global-agent@3` (`boolean`). `sharp` is declared `<0.35`. This package overrides those to patched
releases (`adm-zip@0.6`, `global-agent@4`, `sharp@0.35`). None of those paths are exercised here:
the server does not unpack untrusted archives and does not process images. If you disagree, skip
vector search with `mode: "bm25"`.

## Tests

```powershell
npm run build
npm test        # indexing, search, path safety, write, move, lint, delete
npm run test:stdio  # real MCP client over stdio against the built server
```

Both scripts create a throwaway wiki under `.smoke/`.

## Notes

- stdout belongs to the JSON-RPC protocol. Diagnostics go to stderr only.
- The first index pass starts only after the connection is up - the client does not wait for
  the model download.
- If the model is changed, the server detects the different dimension and rebuilds the vector
  index on the next pass.
