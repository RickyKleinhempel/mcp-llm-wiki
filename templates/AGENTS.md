---
id: AGENTS
title: Wiki-Schema und Arbeitsregeln
type: note
status: stable
summary: Konventionen für dieses Wiki - Frontmatter, Seitentypen, Ordnerstruktur und Ablauf beim Schreiben.
tags: [meta, schema]
created: 2026-01-01
updated: 2026-01-01
---

# Wiki-Schema und Arbeitsregeln

Diese Datei beschreibt, wie dieses Wiki geführt wird. Sie ist die einzige Quelle für Konventionen -
der MCP-Server erzwingt sie nicht, er erzwingt nur Sicherheitsgrenzen.

## Frontmatter

Jede Seite beginnt mit einem YAML-Header. Pflichtfelder werden beim Schreiben automatisch ergänzt.

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `id` | ja | Stabiler Bezeichner, Ziel von `[[wikilinks]]`. Standard: Dateiname ohne `.md`. |
| `title` | ja | Überschrift in Alltagssprache. |
| `type` | ja | `note`, `concept`, `source-summary`, `howto`, `index`, `log`. |
| `status` | nein | `draft`, `stable`, `deprecated`. |
| `summary` | nein | Ein bis zwei Sätze. Erscheint in Suchtreffern und im Index. |
| `tags` | nein | Kleingeschrieben, Mehrzahl vermeiden. |
| `aliases` | nein | Weitere Namen, unter denen die Seite verlinkt werden darf. |
| `sources` | nein | Pfade relativ zu `RAW_ROOT`. |
| `related` | nein | ids verwandter Seiten. |
| `supersedes` / `superseded_by` | nein | Ablösung. Mit `superseded_by` gehört `status: deprecated`. |
| `created` / `updated` | ja | ISO-Datum. `updated` wird bei jedem Schreibvorgang gesetzt. |
| `confidence` | nein | `low`, `medium`, `high`. |

## Seitentypen

- **concept** - eine Idee, ein Begriff, ein Modell. Zeitlos formuliert.
- **source-summary** - Verdichtung genau einer Quelle. `sources` ist gesetzt.
- **howto** - Handlungsanleitung in Schritten.
- **note** - alles andere.
- **index** / **log** - Buchführung, wird von den Tools gepflegt.

## Ordnerstruktur

Die Struktur wächst mit dem Inhalt und wird nicht vorab festgelegt.

- Vor dem Anlegen einer Seite `wiki_list_folders` aufrufen und sich einfügen.
- Ein neuer Unterordner lohnt sich ab etwa fünf verwandten Seiten, vorher nicht.
- Dateinamen: kleingeschrieben, Bindestriche statt Leerzeichen, `.md`.
- `index.md` und `log.md` liegen in der Wurzel; Ordner dürfen eine eigene `index.md` haben.

## Ablauf

**Aufnehmen (Ingest)**

1. `raw_list` / `raw_read` - Quelle lesen.
2. `wiki_search` - gibt es die Seite schon?
3. Vorhandene Seite mit `wiki_patch_page` erweitern, sonst `wiki_write_page` mit selbst gewähltem Pfad.
4. `wiki_append_log` mit `operation: ingest`.

**Fragen (Query)**

1. `wiki_search` - hybrid, danach gezielt lesen.
2. Bei Lücken zuerst antworten, dann die Lücke als `draft`-Seite anlegen.

**Aufräumen (Lint)**

1. `wiki_lint` - Befunde abarbeiten.
2. Doppelte Seiten zusammenführen, Verweise per `wiki_backlinks` prüfen, dann `wiki_move_page` oder `wiki_delete_page`.
3. `wiki_update_index`, danach `wiki_append_log`.

## Schreibstil

- Deutsch, sachlich, ohne Füllwörter.
- Eine Seite, ein Thema. Lieber verlinken als wiederholen.
- Widersprüche nicht nebeneinander stehen lassen: auflösen oder als offene Frage kennzeichnen.
- Quellen als `sources` im Frontmatter, nicht als Fußnote im Text.
