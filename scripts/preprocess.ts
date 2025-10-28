import { createHash } from "node:crypto";
import * as path from "node:path";
import { tmpdir } from "node:os";
import * as fs from "fs-extra";
import { createExtractorFromFile } from "node-unrar-js";
import jschardet from "jschardet";
import iconv from "iconv-lite";

const SOURCE_DIR = path.resolve("sourceRar");
const OUTPUT_DIR = path.resolve("public", "books");
const DATA_DIR = path.resolve("public", "data");
const MANIFEST_PATH = path.resolve("generated", "manifest.json");
const BOOKS_JSON_PATH = path.join(DATA_DIR, "books.json");
const MAX_CHUNK_SIZE = 25 * 1024 * 1024 - 1024; // Slightly below 25MiB safety margin

interface ChapterManifest {
  chapterId: string;
  bookId: string;
  order: number;
  title: string;
  assetPath: string;
  startByte: number;
  length: number;
}

interface BookManifest {
  hash: string;
  title: string;
  author: string;
  assets: string[];
  chapters: ChapterManifest[];
}

interface ManifestJSON {
  books: Record<string, BookManifest>;
}

interface BookSummary {
  id: string;
  title: string;
  author: string;
  totalChapters: number;
}

type ChapterCompactEntry = [string, string, number, number, number];

interface ChaptersFile {
  book: {
    id: string;
    title: string;
    author: string;
    totalChapters: number;
    assets: string[];
  };
  chapters: ChapterCompactEntry[];
}

interface ParsedBookMeta {
  bookId: string;
  title: string;
  author: string;
}

interface ParsedChapter {
  title: string;
  content: string;
}

function normaliseWhitespace(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

function parseBookMeta(filename: string): ParsedBookMeta {
  const name = filename.replace(/\.rar$/i, "");
  const match = name.match(/^《(.+?)》.*?作者[:：]\s*(.+)$/);
  const title = match?.[1]?.trim() ?? name;
  const author = match?.[2]?.trim() ?? "佚名";
  const bookId = slugify(`${title}-${author}`);
  return { bookId, title, author };
}

function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function computeFileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function detectEncoding(buffer: Buffer): string {
  const detection = jschardet.detect(buffer);
  const encoding = detection.encoding?.toLowerCase();
  if (!encoding) return "utf-8";
  if (encoding.includes("gb")) {
    return "gb18030";
  }
  if (encoding === "big5") {
    return "big5";
  }
  return "utf-8";
}

function parseChapters(rawText: string): ParsedChapter[] {
  const text = normaliseWhitespace(rawText);
  const lines = text.split("\n");
  const chapterIndices: Array<{ index: number; title: string }> = [];

  const chapterRegex = /^第\s*([〇零一二三四五六七八九十百千0-9两]+)\s*(章|节|回|集|篇|幕)\s*(.*)$/;
  const specialTitles = /^(楔子|序章|序言|引子|终章|尾声|后记)(.*)$/;
  let currentHeading: string | null = null;

  const extractUpperHeading = (line: string): string | null => {
    const patterns: Array<(line: string) => string | null> = [
      (source) => {
        const match = source.match(
          /^第\s*([〇零一二三四五六七八九十百千0-9两]+)\s*(卷|部|篇|册|集|季|章)\s*[:：]?\s*(.*)$/i,
        );
        if (!match) return null;
        const [, ordinal, kind, rest] = match;
        const suffix = rest?.trim();
        return suffix ? `第${ordinal}${kind} ${suffix}` : `第${ordinal}${kind}`;
      },
      (source) => {
        const match = source.match(
          /^(卷|部|篇|册|集|季)\s*([〇零一二三四五六七八九十百千0-9两]+)\s*[:：]?\s*(.*)$/i,
        );
        if (!match) return null;
        const [, kind, ordinal, rest] = match;
        const suffix = rest?.trim();
        return suffix ? `${kind}${ordinal} ${suffix}` : `${kind}${ordinal}`;
      },
      (source) => {
        const match = source.match(/^(Book|Part|Section)\s+(\d+)\s*[:：]?\s*(.*)$/i);
        if (!match) return null;
        const [, keyword, number, rest] = match;
        const suffix = rest?.trim();
        return suffix ? `${keyword} ${number} ${suffix}` : `${keyword} ${number}`;
      },
      (source) => {
        const match = source.match(/^【(.+?)】$/);
        return match ? match[0] : null;
      },
    ];

    for (const pattern of patterns) {
      const heading = pattern(line);
      if (heading) {
        return heading.trim();
      }
    }
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const upperHeading = extractUpperHeading(line);
    if (upperHeading && !chapterRegex.test(line)) {
      currentHeading = upperHeading;
      continue;
    }
    const match = line.match(chapterRegex);
    if (match) {
      const [, , , rest] = match;
      const titleSuffix = rest?.trim() ?? "";
      const baseTitle = titleSuffix ? `${line}` : line;
      const title = currentHeading ? `${currentHeading} ${baseTitle}` : baseTitle;
      chapterIndices.push({ index: i, title });
      continue;
    }
    if (specialTitles.test(line)) {
      const title = currentHeading ? `${currentHeading} ${line}` : line;
      chapterIndices.push({ index: i, title });
    }
  }

  if (chapterIndices.length === 0) {
    const trimmed = text.trim();
    return trimmed
      ? [
          {
            title: "全文",
            content: trimmed,
          },
        ]
      : [];
  }

  chapterIndices.sort((a, b) => a.index - b.index);

  const chapters: ParsedChapter[] = [];
  for (let i = 0; i < chapterIndices.length; i += 1) {
    const { index, title } = chapterIndices[i];
    const endIndex = i + 1 < chapterIndices.length ? chapterIndices[i + 1].index : lines.length;
    const content = lines
      .slice(index + 1, endIndex)
      .join("\n")
      .trim();
    chapters.push({ title, content });
  }

  return chapters;
}

async function decodeTxtFromRar(rarPath: string): Promise<string | null> {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "novel-preprocess-"));
  const nameMap = new Map<string, string>();
  const usedNames = new Map<string, number>();

  const allocateName = (entry: string) => {
    const normalized = entry
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .at(-1) ?? `entry_${nameMap.size}`;
    const safeBase = normalized.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "_") || `entry_${nameMap.size}`;
    const count = usedNames.get(safeBase);
    if (count === undefined) {
      usedNames.set(safeBase, 1);
      return safeBase;
    }
    const candidate = `${safeBase}_${count}`;
    usedNames.set(safeBase, count + 1);
    return candidate;
  };

  try {
    const extractor = await createExtractorFromFile({
      filepath: rarPath,
      targetPath: tempDir,
      filenameTransform: (filename) => {
        const allocated = allocateName(filename);
        nameMap.set(filename, allocated);
        return allocated;
      },
    });

    const extracted = extractor.extract({
      files: (header) => header.name.toLowerCase().endsWith(".txt"),
    });

    const candidatePaths: string[] = [];
    for (const file of extracted.files) {
      if (file.fileHeader.flags.directory) continue;
      const relative = nameMap.get(file.fileHeader.name);
      if (!relative) continue;
      const absPath = path.join(tempDir, relative);
      candidatePaths.push(absPath);
    }

    for (const candidate of candidatePaths) {
      if (!(await fs.pathExists(candidate))) continue;
      const buffer = await fs.readFile(candidate);
      const encoding = detectEncoding(buffer);
      const decoded = iconv.decode(buffer, encoding).trim();
      if (decoded) {
        return decoded;
      }
    }
    return null;
  } finally {
    await fs.remove(tempDir);
  }
}

async function ensureDirectories(): Promise<void> {
  await fs.ensureDir(SOURCE_DIR);
  await fs.ensureDir(OUTPUT_DIR);
  await fs.ensureDir(DATA_DIR);
  await fs.ensureDir(path.dirname(MANIFEST_PATH));
}

async function loadManifest(): Promise<ManifestJSON> {
  if (!(await fs.pathExists(MANIFEST_PATH))) {
    return { books: {} };
  }
  const raw = await fs.readFile(MANIFEST_PATH, "utf-8");
  return JSON.parse(raw) as ManifestJSON;
}

async function writeManifest(manifest: ManifestJSON): Promise<void> {
  await fs.writeJson(MANIFEST_PATH, manifest, { spaces: 2 });
}

async function removeObsoleteAssets(assets: string[]): Promise<void> {
  const removals = assets.map(async (asset) => {
    const absPath = path.resolve("public", asset.replace(/^\/+/, ""));
    if (await fs.pathExists(absPath)) {
      await fs.remove(absPath);
    }
  });
  await Promise.all(removals);
}

async function removeObsoleteBookArtifacts(bookId: string): Promise<void> {
  const dataPath = path.join(DATA_DIR, `${bookId}_chapters.json`);
  await fs.pathExists(dataPath).then((exists) => (exists ? fs.remove(dataPath) : undefined));
}

async function processBook(
  rarPath: string,
  meta: ParsedBookMeta,
  manifest: ManifestJSON,
  existing?: BookManifest,
): Promise<BookManifest | null> {
  const text = await decodeTxtFromRar(rarPath);
  if (!text) {
    console.warn(`未在 ${path.basename(rarPath)} 中找到可用的 .txt 正文`);
    return existing ?? null;
  }

  const chapters = parseChapters(text);
  if (chapters.length === 0) {
    console.warn(`${meta.title} 未检测到任何章节，跳过`);
    return existing ?? null;
  }

  if (existing) {
    await removeObsoleteAssets(existing.assets);
  }

  const bookDir = path.join(OUTPUT_DIR, meta.bookId);
  await fs.ensureDir(bookDir);

  const manifestChapters: ChapterManifest[] = [];
  const assetPaths: string[] = [];
  let chunkIndex = 1;
  let chunkParts: string[] = [];
  let chunkLength = 0;
  let chunkChapterEntries: ChapterManifest[] = [];

  const flushChunk = async () => {
    if (chunkParts.length === 0) return;
    const filename = `part_${String(chunkIndex).padStart(3, "0")}.txt`;
    const relativeAsset = `/books/${meta.bookId}/${filename}`;
    const fullPath = path.join(bookDir, filename);
    const chunkContent = chunkParts.join("");
    await fs.writeFile(fullPath, chunkContent, "utf-8");
    assetPaths.push(relativeAsset);
    for (const chapter of chunkChapterEntries) {
      manifestChapters.push({ ...chapter, assetPath: relativeAsset });
    }
    chunkIndex += 1;
    chunkParts = [];
    chunkLength = 0;
    chunkChapterEntries = [];
  };

  for (let idx = 0; idx < chapters.length; idx += 1) {
    const chapter = chapters[idx];
    const chapterOrder = idx + 1;
    const chapterId = `${meta.bookId}-${String(chapterOrder).padStart(5, "0")}`;
    const chapterHeader = `${chapter.title.trim()}\n`;
    const chapterBody = chapter.content ? `${chapter.content.trim()}\n\n` : "\n";
    const chapterText = `${chapterHeader}${chapterBody}`;
    const chapterBuffer = Buffer.from(chapterText, "utf-8");
    const chapterLength = chapterBuffer.byteLength;

    if (chunkLength + chapterLength > MAX_CHUNK_SIZE && chunkLength > 0) {
      await flushChunk();
    }

    const startByte = chunkLength;
    chunkParts.push(chapterText);
    chunkLength += chapterLength;
    chunkChapterEntries.push({
      chapterId,
      bookId: meta.bookId,
      order: chapterOrder,
      title: chapter.title.trim() || `章节 ${chapterOrder}`,
      assetPath: "", // placeholder, set on flush
      startByte,
      length: chapterLength,
    });
  }

  await flushChunk();
  const assetIndexMap = new Map<string, number>();
  const compactAssets: string[] = [];
  const compactChapters: ChapterCompactEntry[] = manifestChapters.map((chapter) => {
    let assetIndex = assetIndexMap.get(chapter.assetPath);
    if (assetIndex === undefined) {
      assetIndex = compactAssets.length;
      compactAssets.push(chapter.assetPath);
      assetIndexMap.set(chapter.assetPath, assetIndex);
    }
    return [chapter.chapterId, chapter.title, assetIndex, chapter.startByte, chapter.length];
  });

  const chaptersPayload: ChaptersFile = {
    book: {
      id: meta.bookId,
      title: meta.title,
      author: meta.author,
      totalChapters: compactChapters.length,
      assets: compactAssets,
    },
    chapters: compactChapters,
  };
  const chaptersPath = path.join(DATA_DIR, `${meta.bookId}_chapters.json`);
  await fs.writeJson(chaptersPath, chaptersPayload, { spaces: 2 });

  return {
    hash: await computeFileHash(rarPath),
    title: meta.title,
    author: meta.author,
    assets: assetPaths,
    chapters: manifestChapters,
  };
}

async function main(): Promise<void> {
  await ensureDirectories();
  const manifest = await loadManifest();
  const nextManifest: ManifestJSON = { books: {} };

  const allFiles = await fs.readdir(SOURCE_DIR);
  const rarFiles = allFiles.filter((file) => file.toLowerCase().endsWith(".rar"));
  const totalBooks = rarFiles.length;

  if (totalBooks === 0) {
    console.log("未在 sourceRar 目录中找到任何 .rar 文件。");
  }

  for (let index = 0; index < rarFiles.length; index += 1) {
    const file = rarFiles[index];
    const rarPath = path.join(SOURCE_DIR, file);
    const meta = parseBookMeta(file);
    const progress = `[${index + 1}/${totalBooks}]`;
    console.log(`${progress} 正在处理《${meta.title}》 - ${meta.author}`);

    const fileHash = await computeFileHash(rarPath);
    const existing = manifest.books[meta.bookId];
    const dataPath = path.join(DATA_DIR, `${meta.bookId}_chapters.json`);
    const needArtifacts = !(await fs.pathExists(dataPath));

    if (existing && existing.hash === fileHash && !needArtifacts) {
      nextManifest.books[meta.bookId] = existing;
      console.log(`${progress} 跳过《${meta.title}》，无内容变化。`);
      continue;
    }

    const processed = await processBook(rarPath, meta, manifest, existing);
    if (processed) {
      nextManifest.books[meta.bookId] = processed;
      console.log(`${progress} 完成《${meta.title}》，共 ${processed.chapters.length} 章。`);
    } else {
      console.log(`${progress} 跳过《${meta.title}》，未能生成有效章节。`);
    }
  }

  // Handle books removed from source: clean up assets
  for (const [bookId, bookManifest] of Object.entries(manifest.books)) {
    if (nextManifest.books[bookId]) continue;
    // Book no longer present
    await removeObsoleteAssets(bookManifest.assets);
    await removeObsoleteBookArtifacts(bookId);
    console.log(`已移除缺失源文件的书籍：${bookId}`);
  }

  await writeManifest(nextManifest);
  const summaries: BookSummary[] = Object.entries(nextManifest.books).map(([bookId, book]) => ({
    id: bookId,
    title: book.title,
    author: book.author,
    totalChapters: book.chapters.length,
  }));
  const bookRows = summaries.map((summary) => [summary.id, summary.title, summary.author, summary.totalChapters]);
  await fs.writeJson(
    BOOKS_JSON_PATH,
    {
      generatedAt: new Date().toISOString(),
      columns: ["id", "title", "author", "totalChapters"],
      books: bookRows,
    },
    { spaces: 2 },
  );

  console.log(`处理完成，共 ${summaries.length} 本书。`);
}

main().catch((error) => {
  console.error("预处理流程失败", error);
  process.exitCode = 1;
});
