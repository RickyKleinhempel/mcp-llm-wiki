/**
 * Markdown-aware chunking.
 *
 * Sections are cut at ATX headings (fenced code blocks are skipped so `#`
 * comments inside code do not split a section). Oversized sections are further
 * split at paragraph, then line boundaries, with a configurable overlap so a
 * statement that straddles a cut is still retrievable.
 */

export interface Chunk {
  ord: number;
  headingPath: string;
  /** 1-based line numbers within the original file. */
  startLine: number;
  endLine: number;
  text: string;
}

export interface ChunkOptions {
  maxChars: number;
  overlap: number;
  /** 1-based line number the body starts at inside the file. */
  bodyStartLine: number;
}

interface Section {
  headingPath: string;
  startLine: number;
  lines: string[];
}

export function chunkMarkdown(body: string, options: ChunkOptions): Chunk[] {
  const sections = splitIntoSections(body, options.bodyStartLine);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (text.length === 0) continue;

    if (text.length <= options.maxChars) {
      chunks.push({
        ord: chunks.length,
        headingPath: section.headingPath,
        startLine: section.startLine,
        endLine: section.startLine + section.lines.length - 1,
        text,
      });
      continue;
    }

    for (const piece of splitLongSection(section, options)) {
      chunks.push({ ...piece, ord: chunks.length });
    }
  }

  return chunks;
}

function splitIntoSections(body: string, bodyStartLine: number): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let current: Section = { headingPath: "", startLine: bodyStartLine, lines: [] };
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    }

    const headingMatch = fence === null ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (headingMatch) {
      if (current.lines.some((l) => l.trim() !== "")) sections.push(current);
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = title;
      const headingPath = headingStack.filter(Boolean).join(" > ");
      current = { headingPath, startLine: bodyStartLine + i, lines: [line] };
      continue;
    }

    current.lines.push(line);
  }

  if (current.lines.some((l) => l.trim() !== "")) sections.push(current);
  return sections;
}

function splitLongSection(section: Section, options: ChunkOptions): Omit<Chunk, "ord">[] {
  const blocks = groupIntoBlocks(section.lines, section.startLine);
  const out: Omit<Chunk, "ord">[] = [];

  let buffer: Block[] = [];
  let bufferChars = 0;

  const emit = (): void => {
    if (buffer.length === 0) return;
    const text = buffer
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (text.length === 0) return;
    const last = out[out.length - 1];
    if (last?.text === text) return;
    out.push({
      headingPath: section.headingPath,
      startLine: buffer[0].startLine,
      endLine: buffer[buffer.length - 1].endLine,
      text,
    });
  };

  for (const block of blocks) {
    for (const piece of hardSplit(block, options.maxChars)) {
      if (bufferChars > 0 && bufferChars + piece.text.length > options.maxChars) {
        emit();
        buffer = carryOverlap(buffer, options.overlap);
        bufferChars = buffer.reduce((sum, b) => sum + b.text.length + 2, 0);
      }
      buffer.push(piece);
      bufferChars += piece.text.length + 2;
    }
  }
  emit();

  return out;
}

interface Block {
  text: string;
  startLine: number;
  endLine: number;
}

/** Group consecutive non-empty lines into paragraph blocks. */
function groupIntoBlocks(lines: string[], startLine: number): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let bufferStart = startLine;

  lines.forEach((line, index) => {
    const lineNumber = startLine + index;
    if (line.trim() === "") {
      if (buffer.length > 0) {
        blocks.push({ text: buffer.join("\n"), startLine: bufferStart, endLine: lineNumber - 1 });
        buffer = [];
      }
      bufferStart = lineNumber + 1;
      return;
    }
    if (buffer.length === 0) bufferStart = lineNumber;
    buffer.push(line);
  });

  if (buffer.length > 0) {
    blocks.push({ text: buffer.join("\n"), startLine: bufferStart, endLine: startLine + lines.length - 1 });
  }
  return blocks;
}

/** A single paragraph longer than the chunk budget is cut on line boundaries. */
function hardSplit(block: Block, maxChars: number): Block[] {
  if (block.text.length <= maxChars) return [block];

  const lines = block.text.split("\n");
  const out: Block[] = [];
  let buffer: string[] = [];
  let start = block.startLine;
  let cursor = block.startLine;

  for (const line of lines) {
    const projected = buffer.join("\n").length + line.length + 1;
    if (buffer.length > 0 && projected > maxChars) {
      out.push({ text: buffer.join("\n"), startLine: start, endLine: cursor - 1 });
      buffer = [];
      start = cursor;
    }
    buffer.push(line);
    cursor++;
  }
  if (buffer.length > 0) out.push({ text: buffer.join("\n"), startLine: start, endLine: block.endLine });
  return out;
}

/** Keep trailing blocks up to `overlap` characters as the head of the next chunk. */
function carryOverlap(buffer: Block[], overlap: number): Block[] {
  if (overlap <= 0) return [];
  const carried: Block[] = [];
  let chars = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const block = buffer[i];
    if (chars + block.text.length > overlap && carried.length > 0) break;
    carried.unshift(block);
    chars += block.text.length;
    if (chars >= overlap) break;
  }
  return carried;
}
