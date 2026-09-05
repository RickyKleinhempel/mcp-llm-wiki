# mcp-llm-wiki

MCP-Server für ein Wiki, das ein Sprachmodell selbst pflegt: Markdown-Dateien mit YAML-Frontmatter,
durchsuchbar über BM25 **und** lokal auf der CPU berechnete Vektoren. Kein Cloud-Dienst, keine
Embedding-API, keine externe Datenbank.

Die Idee stammt aus `llm-wiki.md` / `idee.md`: drei Ebenen (unveränderliche Quellen, vom Modell
verantwortetes Wiki, Schema als `AGENTS.md`) und drei Operationen (Ingest, Query, Lint).

## Aufbau

```
raw/     unveränderliche Quellen  -> nur lesbar
wiki/    das eigentliche Wiki     -> Markdown + YAML-Frontmatter
         .llm-wiki/index.db       -> SQLite: FTS5, sqlite-vec, Metadaten, Linkgraph
         .llm-wiki/models/        -> heruntergeladenes Embedding-Modell
```

Der Server erzwingt **keine** Ordnerkonventionen. Er sorgt für Sicherheit (kein Ausbruch aus dem
Wiki-Verzeichnis), gültiges Frontmatter und einen aktuellen Index. Wohin eine Seite gehört,
entscheidet das Modell - `wiki_write_page` verlangt deshalb einen expliziten `path`.

## Installation

```powershell
cd mcp-llm-wiki
npm install
npm run build
```

Beim ersten Start lädt Transformers.js das Modell `Xenova/multilingual-e5-small` (~120 MB,
384 Dimensionen, deutsch und englisch) nach `MODEL_CACHE_DIR`. Danach läuft alles offline;
mit `ALLOW_REMOTE_MODELS=false` wird der Download unterbunden.

## Einbinden

`.vscode/mcp.json`:

```json
{
  "servers": {
    "llm-wiki": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp-llm-wiki/dist/index.js"],
      "env": {
        "WIKI_ROOT": "${workspaceFolder}/wiki",
        "RAW_ROOT": "${workspaceFolder}/raw"
      }
    }
  }
}
```

Kopiere anschließend `templates/AGENTS.md` nach `wiki/AGENTS.md` und passe sie an - das ist die
Stelle, an der Konventionen stehen, nicht die Serverkonfiguration.

## Konfiguration

Alle Werte lassen sich als Umgebungsvariable (`mcp.json` → `env`) oder als CLI-Flag setzen;
CLI schlägt Umgebung schlägt Vorgabe.

| Variable | Flag | Vorgabe | Bedeutung |
| --- | --- | --- | --- |
| `WIKI_ROOT` | `--wiki-root` | **erforderlich** | Wurzel des Wikis. |
| `RAW_ROOT` | `--raw-root` | `<WIKI_ROOT>/../raw` | Quellenebene, nur lesend. |
| `INDEX_DB` | `--index-db` | `<WIKI_ROOT>/.llm-wiki/index.db` | SQLite-Datei. |
| `MODEL_ID` | `--model` | `Xenova/multilingual-e5-small` | Embedding-Modell. |
| `MODEL_CACHE_DIR` | `--model-cache-dir` | `<INDEX_DB-Ordner>/models` | Modell-Cache. |
| `ALLOW_REMOTE_MODELS` | `--allow-remote-models` | `true` | Download erlauben. |
| `CHUNK_CHARS` | `--chunk-chars` | `1200` | Zielgröße eines Chunks. |
| `CHUNK_OVERLAP` | `--chunk-overlap` | `180` | Überlappung beim Teilen langer Abschnitte. |
| `WATCH` | `--watch` | `false` | Dateisystem beobachten. |
| `ALLOW_WRITE` | `--allow-write` | `true` | `false` schaltet alle Schreib-Tools ab. |
| `RRF_K` | `--rrf-k` | `60` | Konstante der Rangfusion. |
| `SCHEMA_STRICT` | `--schema-strict` | `false` | Unbekannte Frontmatter-Felder ablehnen. |
| `DEFAULT_CONFIDENCE` | `--default-confidence` | - | Vorgabe für `confidence`. |
| `MAX_DEPTH` | `--max-depth` | `8` | Maximale Ordnertiefe. |
| `MAX_PATH_LENGTH` | `--max-path-length` | `240` | Maximale Pfadlänge. |
| `STRUCTURE_HINT` | `--structure-hint` | - | Wird in Tool-Beschreibungen eingeblendet. |
| `IGNORE_GLOBS` | `--ignore-globs` | - | Kommaliste zusätzlich ignorierter Muster. |
| `MAX_READ_BYTES` | `--max-read-bytes` | `2097152` | Obergrenze beim Lesen. |
| `LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |

## Tools

**Suchen und lesen**

| Tool | Zweck |
| --- | --- |
| `wiki_search` | Hybride Suche (BM25 + Vektoren, Reciprocal Rank Fusion). Modi `hybrid`, `bm25`, `vector`. |
| `wiki_read_page` | Ganze Seite, Abschnitt (`section`) oder Zeilenbereich. |
| `wiki_list_pages` | Seitenliste mit Frontmatter, filterbar nach Ordner, Typ, Status, Tag. |
| `wiki_list_folders` | Ordnerbaum mit Seitenzahlen - vor dem Anlegen einer Seite. |
| `wiki_list_tags` | Alle Tags mit Häufigkeit. |
| `raw_list`, `raw_read` | Zugriff auf die Quellenebene. |

**Schreiben**

| Tool | Zweck |
| --- | --- |
| `wiki_write_page` | Seite anlegen oder ersetzen. `path` ist Pflicht, fehlende Ordner entstehen automatisch. |
| `wiki_patch_page` | `replace-section`, `append-section`, `append`, `prepend`, `replace-body` oder nur Frontmatter. |
| `wiki_move_page` | Datei oder Ordner verschieben; relative Links werden mitgezogen (`dryRun` möglich). |
| `wiki_delete_page` | Verschiebt nach `.trash/<Zeitstempel>/`, verlangt `confirm: true`. |

**Buchführung und Pflege**

| Tool | Zweck |
| --- | --- |
| `wiki_update_index` | Erzeugt `index.md` - global oder für einen Ordner (`scope`). |
| `wiki_append_log`, `wiki_read_log` | Chronologie in `log.md` als `## [YYYY-MM-DD] op \| Titel`. |
| `wiki_backlinks` | Ein- und ausgehende Verweise, inklusive der toten. |
| `wiki_lint` | Frontmatter, Datumsangaben, doppelte ids, tote Links, Waisen, leere Ordner. |
| `wiki_reindex`, `wiki_index_status` | Index neu aufbauen bzw. Zustand abfragen. |

## Wie die Suche funktioniert

1. Jede Datei wird an Überschriften geschnitten; zu lange Abschnitte werden an Absätzen mit
   Überlappung geteilt. Der Überschriftenpfad (`H1 > H2`) bleibt am Chunk hängen.
2. BM25 läuft über FTS5 mit gewichteten Spalten (Text, Überschriftenpfad, Titel, Summary, Tags).
   Anfragen werden in Anführungszeichen gesetzt, damit FTS5-Operatoren nicht durchschlagen;
   zuerst wird `AND` versucht, dann `OR`.
3. Die Vektorsuche nutzt `sqlite-vec` mit Kosinusabstand. Das e5-Modell braucht Präfixe
   (`passage:` beim Indexieren, `query:` beim Suchen) - der Server setzt sie selbst.
4. Beide Ranglisten werden per Reciprocal Rank Fusion zusammengeführt, danach bleibt pro Seite
   der beste Chunk übrig.

## Sicherheit

- Jeder Pfad wird normalisiert und gegen die Wurzel geprüft (`..`, absolute Pfade, UNC, reservierte
  Windows-Namen, Steuerzeichen). Zusätzlich wird über `realpath` geprüft, damit Symlinks nicht
  hinausführen; beim Indexieren werden Symlinks komplett übersprungen.
- `RAW_ROOT` ist ausschließlich lesbar.
- Löschen heißt Verschieben in den Papierkorb und verlangt eine ausdrückliche Bestätigung.
- Alle SQL-Zugriffe laufen über Parameter, nie über Stringverkettung.

### Bekannte Schwachstellen in Abhängigkeiten

`npm audit` meldet vier Einträge mit hohem Schweregrad, für die es keinen Fix gibt:

- `adm-zip < 0.6.0` über `onnxruntime-node`
- `sharp < 0.35.0` über `@huggingface/transformers`

Beide Pfade werden hier nicht ausgeführt: Der Server entpackt keine fremden Archive und verarbeitet
keine Bilder. Wer das anders bewertet, kann die Vektorsuche mit `mode: "bm25"` umgehen; ein Ersatz
der Abhängigkeit steht aus.

## Tests

```powershell
npm run build
npm test        # Indexierung, Suche, Pfadsicherheit, Schreiben, Move, Lint, Löschen
npm run test:stdio  # echter MCP-Client über stdio gegen den gebauten Server
```

Beide Skripte legen ein Wegwerf-Wiki unter `.smoke/` an.

## Hinweise

- stdout gehört dem JSON-RPC-Protokoll. Diagnose geht ausschließlich nach stderr.
- Der erste Indexlauf startet erst, nachdem die Verbindung steht - der Client wartet nicht auf den
  Modell-Download.
- Wird das Modell gewechselt, erkennt der Server die abweichende Dimension und baut den Vektorindex
  beim nächsten Lauf neu auf.
