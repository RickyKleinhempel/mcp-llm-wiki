import { normalizeRelPath, normalizeMarkdownRelPath, PathError } from "../dist/paths.js";
import { buildMatchExpression, escapeLike } from "../dist/search/bm25.js";
import { reciprocalRankFusion } from "../dist/search/fusion.js";
import { chunkMarkdown } from "../dist/indexing/chunk.js";

/**
 * Pure-function checks - no DB, no embedding model, no filesystem beyond dist/.
 * Run with `npm run build` first.
 */

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof PathError ? error.code : true;
  }
};

const limits = { maxDepth: 8, maxRelPathLength: 240 };

console.log("paths");
check("accepts a normal relative path", normalizeRelPath("a/b/c.md", limits) === "a/b/c.md");
check("rejects ..", throws(() => normalizeRelPath("../escape.md", limits)) === "traversal");
check("rejects absolute posix path", throws(() => normalizeRelPath("/etc/passwd", limits)) === "absolute-path");
check("rejects windows drive path", throws(() => normalizeRelPath("C:\\Windows\\win.ini", limits)) === "absolute-path");
check("rejects reserved device name", throws(() => normalizeRelPath("con.md", limits)) === "reserved-name");
check("normalizeMarkdownRelPath requires .md", throws(() => normalizeMarkdownRelPath("a/b.txt", limits)) === "not-markdown");

console.log("bm25");
check(
  "buildMatchExpression quotes every term",
  buildMatchExpression("foo bar", "and") === '"foo" AND "bar"',
  buildMatchExpression("foo bar", "and"),
);
check(
  "operators inside a query become quoted literals, not FTS5 syntax",
  buildMatchExpression('foo" OR 1=1 --', "and") === '"foo" AND "OR" AND "1" AND "1"',
  buildMatchExpression('foo" OR 1=1 --', "and"),
);
check("empty query has no match expression", buildMatchExpression("   ", "and") === undefined);
check("escapeLike escapes %, _ and backslash", escapeLike("50%_off\\path") === "50\\%\\_off\\\\path", escapeLike("50%_off\\path"));

console.log("fusion");
const fused = reciprocalRankFusion({ bm25: { ids: [1, 2, 3] }, vector: { ids: [2, 3, 1] } }, 60, 10);
check("fusion returns every distinct id", fused.length === 3, fused);
check(
  "an id ranked well in both lists outranks one that only appears once",
  fused[0].id === 1 || fused[0].id === 2,
  fused,
);
const tie = reciprocalRankFusion({ a: { ids: [5] }, b: { ids: [7] } }, 60, 10);
check("equal scores tie-break by ascending id", tie[0].id === 5 && tie[1].id === 7, tie);

console.log("chunk");
const withHeadings = chunkMarkdown("# Title\n\nIntro text.\n\n## Sub\n\nMore text.\n", {
  maxChars: 1200,
  overlap: 180,
  bodyStartLine: 1,
});
check("splits into one chunk per heading", withHeadings.length === 2, withHeadings);
check("heading path is tracked", withHeadings[1].headingPath === "Title > Sub", withHeadings[1]);

const withCodeFence = chunkMarkdown("# Title\n\n```\n# not a heading\n```\n\nText after.\n", {
  maxChars: 1200,
  overlap: 180,
  bodyStartLine: 1,
});
check("a # inside a fenced code block does not start a new section", withCodeFence.length === 1, withCodeFence);
check("fenced code survives in the chunk text", withCodeFence[0].text.includes("# not a heading"), withCodeFence[0]);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
