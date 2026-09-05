---
id: AGENTS
title: Wiki schema and working rules
type: note
status: stable
summary: Conventions for this wiki - frontmatter, page types, folder structure, and the writing workflow.
tags: [meta, schema]
created: 2026-01-01
updated: 2026-01-01
---

# Wiki schema and working rules

This file describes how this wiki is run. It is the only source of conventions -
the MCP server does not enforce them, only safety limits.

## Frontmatter

Every page starts with a YAML header. Required fields are filled in automatically on write.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable identifier, target of `[[wikilinks]]`. Default: filename without `.md`. |
| `title` | yes | Everyday-language heading. |
| `type` | yes | `note`, `concept`, `source-summary`, `howto`, `index`, `log`. |
| `status` | no | `draft`, `stable`, `deprecated`. |
| `summary` | no | One or two sentences. Appears in search hits and the index. |
| `tags` | no | Lowercase, avoid plurals. |
| `aliases` | no | Other names the page may be linked under. |
| `sources` | no | Paths relative to `RAW_ROOT`. |
| `related` | no | ids of related pages. |
| `supersedes` / `superseded_by` | no | Replacement. With `superseded_by` set `status: deprecated`. |
| `created` / `updated` | yes | ISO date. `updated` is set on every write. |
| `confidence` | no | `low`, `medium`, `high`. |

## Page types

- **concept** - an idea, a term, a model. Written timelessly.
- **source-summary** - distillation of exactly one source. `sources` is set.
- **howto** - step-by-step instructions.
- **note** - everything else.
- **index** / **log** - bookkeeping, maintained by the tools.

## Folder structure

The structure grows with the content and is not predefined.

- Call `wiki_list_folders` before creating a page and fit in.
- A new subfolder is worth it around five related pages, not before.
- Filenames: lowercase, hyphens instead of spaces, `.md`.
- `index.md` and `log.md` live at the root; folders may have their own `index.md`.

## Workflow

**Ingest**

1. `raw_list` / `raw_read` - read the source.
2. `wiki_search` - does the page already exist?
3. Extend an existing page with `wiki_patch_page`, otherwise `wiki_write_page` with a path you choose.
4. `wiki_append_log` with `operation: ingest`.

**Query**

1. `wiki_search` - hybrid, then read targeted pages.
2. If there are gaps, answer first, then create the gap as a `draft` page.

**Lint**

1. `wiki_lint` - work through the findings.
2. Merge duplicate pages, check refs with `wiki_backlinks`, then `wiki_move_page` or `wiki_delete_page`.
3. `wiki_update_index`, then `wiki_append_log`.

## Writing style

- English, factual, no filler.
- One page, one topic. Prefer linking over repeating.
- Do not leave contradictions side by side: resolve them or mark as an open question.
- Cite sources as `sources` in frontmatter, not as footnotes in the text.
