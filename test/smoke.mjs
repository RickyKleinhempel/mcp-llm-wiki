import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { openDb } from "../dist/db/open.js";
import { initSchema } from "../dist/db/schema.js";
import { Embedder } from "../dist/indexing/embed.js";
import { Indexer } from "../dist/indexing/indexer.js";
import { setLogLevel } from "../dist/logger.js";
import { runSearch } from "../dist/search/search.js";
import { updateIndex } from "../dist/wiki/indexmd.js";
import { backlinksFor } from "../dist/wiki/links.js";
import { lintWiki } from "../dist/wiki/lint.js";
import { appendLog, readRecentLog } from "../dist/wiki/logmd.js";
import { deletePage, listFolders, listPages, movePage, patchPage, readPage, writePage } from "../dist/wiki/pages.js";

setLogLevel("warn");

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../.smoke");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "wiki"), { recursive: true });
fs.mkdirSync(path.join(root, "raw"), { recursive: true });

const ARTIKEL = `# Das LLM-Wiki

Ein LLM-Wiki ist ein Wissensspeicher aus Markdown-Dateien, den das Sprachmodell selbst pflegt.

## Warum nicht einfach RAG?

Klassisches RAG zerschneidet Dokumente in Chunks und hofft, dass die Vektorsuche die richtigen Schnipsel findet.
Das ist besser als nichts, aber der Kontext geht verloren. Ein Wiki ist besser, weil das Modell den Text vorher
verdichtet, widerspruechliche Aussagen aufloest und Querverweise setzt. Die Frage "Warum ist das besser als RAG?"
beantwortet sich damit von selbst: Nicht die Suche wird schlauer, sondern der Speicher.

## Die drei Ebenen

Die Quellen bleiben unveraendert. Das Wiki gehoert dem Modell. Das Schema beschreibt die Konventionen.

## Die drei Operationen

Ingest verarbeitet neue Quellen. Query beantwortet Fragen. Lint haelt das Wiki sauber.
`;

fs.writeFileSync(path.join(root, "raw", "artikel.md"), ARTIKEL, "utf8");
fs.writeFileSync(path.join(root, "raw", "notizen.md"), "# Notizen\n\nVektorsuche allein reicht nicht.\n", "utf8");
fs.writeFileSync(path.join(root, "wiki", "llm-wiki.md"), `${ARTIKEL}\n[toter Link](gibtsnicht.md)\n`, "utf8");

const config = loadConfig(
  { WIKI_ROOT: path.join(root, "wiki"), RAW_ROOT: path.join(root, "raw"), LOG_LEVEL: "warn" },
  [],
);
const db = openDb(config.indexDb);
initSchema(db);
const embedder = new Embedder({
  modelId: config.modelId,
  cacheDir: config.modelCacheDir,
  allowRemoteModels: config.allowRemoteModels,
});
const indexer = new Indexer(db, config, embedder);
const ctx = { config, db, embedder, indexer };

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
};

console.log("1. index");
const indexed = await indexer.reindex({ mode: "full" });
check("files indexed", indexed.indexed >= 3, indexed);
check("chunks created", indexed.chunks > 0, indexed);
check("embedding dim 384", embedder.dim === 384, embedder.dim);

console.log("2. search");
const hybrid = await runSearch(db, embedder, config.rrfK, { query: "Warum ist das besser als RAG?", k: 5 });
check("hybrid hits", hybrid.hits.length > 0, hybrid.hits.map((h) => h.relPath));
check("bm25 + vector candidates", hybrid.bm25Candidates > 0 && hybrid.vectorCandidates > 0, {
  bm25: hybrid.bm25Candidates,
  vector: hybrid.vectorCandidates,
});
const bm25Only = await runSearch(db, embedder, config.rrfK, { query: "Wiki", mode: "bm25", k: 3 });
check("bm25 mode", bm25Only.hits.length > 0);
const raw = await runSearch(db, embedder, config.rrfK, { query: "wiki", layer: "raw", k: 3 });
check("raw layer search", raw.hits.every((h) => h.layer === "raw") && raw.hits.length > 0);
const fts = await runSearch(db, embedder, config.rrfK, { query: 'gibt"s NOT AND OR *', mode: "bm25", k: 3 });
check("fts operators neutralised", Array.isArray(fts.hits));

console.log("3. path safety");
for (const evil of ["../../secret.txt", "/etc/passwd", "C:\\Windows\\win.ini", "a/../../b.md", "sub/note.txt"]) {
  let threw = false;
  try {
    readPage(ctx, evil);
  } catch {
    threw = true;
  }
  check(`rejects ${evil}`, threw);
}

console.log("4. write / nested folders");
const written = await writePage(ctx, {
  path: "konzepte/wissensmanagement/llm-wiki-konzept.md",
  body: "# LLM-Wiki\n\nDas Wiki gehört dem Modell.\n\nSiehe [[llm-wiki]].\n",
  frontmatter: { title: "LLM-Wiki Konzept", type: "concept", tags: ["wiki", "llm"], summary: "Kernidee." },
});
check("nested file created", written.created && written.relPath === "konzepte/wissensmanagement/llm-wiki-konzept.md");
check("frontmatter completed", written.frontmatter.id === "llm-wiki-konzept" && !!written.frontmatter.updated, written.frontmatter);
check("folder on disk", fs.existsSync(path.join(root, "wiki", "konzepte", "wissensmanagement")));

let duplicateRejected = false;
try {
  await writePage(ctx, { path: "konzepte/wissensmanagement/llm-wiki-konzept.md", body: "x" });
} catch {
  duplicateRejected = true;
}
check("overwrite refused without flag", duplicateRejected);

console.log("5. yaml round-trip");
const roundTrip = await writePage(ctx, {
  path: "tests/yaml.md",
  body: "# Y\n\nInhalt.",
  frontmatter: { title: "Titel: mit Doppelpunkt", summary: "Zeile mit #, - und \"Anführung\"", tags: ["a b", "c:d"] },
});
const reread = readPage(ctx, "tests/yaml.md");
check("special chars survive", reread.frontmatter.title === "Titel: mit Doppelpunkt", reread.frontmatter);
check("tags survive", JSON.stringify(reread.frontmatter.tags) === '["a b","c:d"]', reread.frontmatter.tags);
check("no frontmatter leak into body", reread.content.includes("Inhalt."), roundTrip.relPath);

console.log("6. patch");
await patchPage(ctx, { path: "konzepte/wissensmanagement/llm-wiki-konzept.md", mode: "append", content: "\n## Offen\n\nNoch nichts." });
await patchPage(ctx, {
  path: "konzepte/wissensmanagement/llm-wiki-konzept.md",
  mode: "replace-section",
  section: "Offen",
  content: "Jetzt geklärt.",
});
const patched = readPage(ctx, "konzepte/wissensmanagement/llm-wiki-konzept.md");
check("section replaced", patched.content.includes("Jetzt geklärt") && !patched.content.includes("Noch nichts"));
await patchPage(ctx, { path: "konzepte/wissensmanagement/llm-wiki-konzept.md", frontmatter: { status: "stable" } });
check("frontmatter patched", readPage(ctx, "konzepte/wissensmanagement/llm-wiki-konzept.md").frontmatter.status === "stable");
const section = readPage(ctx, "konzepte/wissensmanagement/llm-wiki-konzept.md", { section: "Offen" });
check("section read", section.content.trim().startsWith("## Offen"), section.content);

console.log("7. links");
const backlinks = backlinksFor(db, "llm-wiki.md");
check("wikilink resolved", backlinks.inbound.some((l) => l.relPath === "konzepte/wissensmanagement/llm-wiki-konzept.md"), backlinks.inbound);
const dead = backlinksFor(db, "llm-wiki.md").unresolvedOutbound;
check("dead link detected", dead.some((l) => l.rawTarget === "gibtsnicht.md"), dead);

console.log("8. move");
const moved = await movePage(ctx, { from: "konzepte/wissensmanagement", to: "wissen/konzepte" });
check("folder moved", fs.existsSync(path.join(root, "wiki", "wissen", "konzepte", "llm-wiki-konzept.md")), moved);
check("old folder pruned", !fs.existsSync(path.join(root, "wiki", "konzepte")));
const afterMove = backlinksFor(db, "llm-wiki.md");
check("wikilink survives move", afterMove.inbound.some((l) => l.relPath === "wissen/konzepte/llm-wiki-konzept.md"), afterMove.inbound);

console.log("9. listings");
check("listPages", listPages(ctx, { limit: 100 }).pages.length >= 3);
check("filter by tag", listPages(ctx, { tag: "wiki" }).pages.length === 1);
const folders = listFolders(ctx);
check("folder tree", folders.some((f) => f.folder === "wissen" && f.totalPages === 1), folders);

console.log("10. index.md + log.md");
const idx = await updateIndex(ctx, {});
check("index written", idx.pages >= 3 && fs.existsSync(path.join(root, "wiki", "index.md")), idx);
const scoped = await updateIndex(ctx, { scope: "wissen" });
check("scoped index", scoped.relPath === "wissen/index.md" && scoped.pages === 1, scoped);
await appendLog(ctx, { operation: "ingest", title: "LLM-Wiki Konzept", details: "Erster Eintrag." });
const logResult = await appendLog(ctx, { operation: "update", title: "Zweiter Eintrag" });
check("log entries", logResult.totalEntries === 2, logResult);
check("log grep format", /^## \[\d{4}-\d{2}-\d{2}\] update \| Zweiter Eintrag$/.test(logResult.entry), logResult.entry);
check("log read", readRecentLog(ctx, 5)[0].operation === "update", readRecentLog(ctx, 5));

console.log("11. lint");
const report = lintWiki(ctx, {});
check("dead link reported", (report.counts["dead-link"] ?? 0) >= 1, report.counts);
check("orphan reported", (report.counts.orphan ?? 0) >= 1, report.counts);
check("no crash on empty checks", lintWiki(ctx, { checks: ["ambiguous-id"] }).findings.every((f) => f.code === "ambiguous-id"));

console.log("12. delete");
let unconfirmed = false;
try {
  await deletePage(ctx, { path: "tests/yaml.md", confirm: false });
} catch {
  unconfirmed = true;
}
check("delete needs confirm", unconfirmed);
await deletePage(ctx, { path: "tests/yaml.md", confirm: true });
check("file trashed", !fs.existsSync(path.join(root, "wiki", "tests", "yaml.md")));
check("removed from index", listPages(ctx, { limit: 100 }).pages.every((p) => p.relPath !== "tests/yaml.md"));

console.log("13. incremental reindex");
fs.appendFileSync(path.join(root, "wiki", "llm-wiki.md"), "\n\nNachtrag zur Vektorsuche.\n", "utf8");
const incremental = await indexer.reindex({ mode: "incremental" });
check("only changed file reindexed", incremental.indexed === 1, incremental);
const afterEdit = await runSearch(db, embedder, config.rrfK, { query: "Nachtrag zur Vektorsuche", mode: "bm25", k: 3 });
check("new text searchable", afterEdit.hits.some((h) => h.relPath === "llm-wiki.md"), afterEdit.hits);

db.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
