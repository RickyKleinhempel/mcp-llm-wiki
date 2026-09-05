import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(here, "../.smoke");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(here, "../dist/index.js")],
  env: {
    ...process.env,
    WIKI_ROOT: path.join(root, "wiki"),
    RAW_ROOT: path.join(root, "raw"),
    LOG_LEVEL: "warn",
  },
  stderr: "inherit",
});

const client = new Client({ name: "smoke-client", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const tool of tools) {
  const required = tool.inputSchema?.required ?? [];
  console.log(`  ${tool.name}  required=[${required.join(", ")}]`);
}

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ${result.isError ? "(isError)" : ""}\n${text.slice(0, 420)}`);
  return result;
};

await call("wiki_index_status", {});
await call("wiki_search", { query: "Warum ist ein Wiki besser als RAG?", k: 3 });
await call("wiki_read_page", { path: "llm-wiki.md", startLine: 1, endLine: 6 });
await call("wiki_list_folders", {});
await call("wiki_read_page", { path: "../../../etc/passwd" });
await call("wiki_write_page", { path: "sitzung/mcp-test.md", body: "# MCP\n\nÜber stdio geschrieben.\n", frontmatter: { type: "note", tags: ["mcp"] } });
await call("wiki_append_log", { operation: "test", title: "MCP smoke" });
await call("wiki_backlinks", { path: "llm-wiki.md" });

await client.close();
console.log("\nSTDIO CHECK DONE");
