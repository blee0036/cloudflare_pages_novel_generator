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

interface ParsedChapterIndex {
  title: string;
  startLine: number;
  endLine: number;
}

const BASE_CHINESE_NUMERAL_CHARS = "〇零一二三四五六七八九十百千两";
const EXTENDED_CHINESE_NUMERAL_CHARS = `${BASE_CHINESE_NUMERAL_CHARS}萬万亿億兆壹贰叁肆伍陆柒捌玖拾佰仟廿卅卌○`;
const ORDINAL_FRAGMENT_PATTERN = `(?:[IVXLCDM]+|[ivxlcdm]+|[Ⅰ-Ⅻ]+|[ⅰ-ⅻ]+|\\d+|[${EXTENDED_CHINESE_NUMERAL_CHARS}]+)`;
const PRIMARY_CHAPTER_MARKERS = ["章", "节", "回", "集", "篇", "幕", "话", "段", "折", "品"];
const UPPER_MARKER_CANDIDATES = ["卷", "部", "册", "季"];
const LATIN_CHAPTER_KEYWORDS = "chapter|chap\\.?|ch\\.?|episode|ep\\.?|act|scene|story";
const ALL_MARKER_CANDIDATES = [...UPPER_MARKER_CANDIDATES, ...PRIMARY_CHAPTER_MARKERS];
const ALL_HEADING_MARKERS = ALL_MARKER_CANDIDATES.join("|");
const SENTENCE_PUNCTUATION_REGEX = /[，。,。？！、；]/g;
const HEADING_LEADING_DELIMITER_REGEX = /[:：\-—·,，.。!！?？()（）【】《》「」『』"“”‘’\s]/;
const ALLOWED_SUFFIX_PREFIXES = new Set(["上", "下", "中", "末", "终", "序", "外", "前", "后", "番", "篇", "卷", "章"]);
const HEADING_CONFIDENCE_THRESHOLD = 1.8;
const ASCII_ALNUM_REGEX = /[A-Za-z0-9]/;
const CJK_LETTER_REGEX = /\p{Unified_Ideograph}/u;
const HEADING_POST_MARKER_PATTERN = /^(?<gap>[\s　]+)(?<lead>[\p{P}\p{S}"“”'‘’《》【】()（）]*)/u;
const CHINESE_NUMERAL_ONLY_REGEX = new RegExp(`^[${EXTENDED_CHINESE_NUMERAL_CHARS}]+$`);
const ARABIC_OR_ROMAN_REGEX = /[0-9０-９IVXLCDMⅰ-ⅻⅰ-ⅻ]/i;

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

interface HeadingPatternMatch {
  lineIndex: number;
  marker: string;
  hasOrdinalPrefix: boolean;
  numeral: string;
}

interface HeadingHierarchy {
  upperMarkers: Set<string>;
  primaryMarkers: Set<string>;
}

function scanHeadingPatterns(lines: string[]): HeadingHierarchy {
  const markerPattern = new RegExp(
    `^(?:【[^】]+】\\s*)?(?:第\\s*)?(?<num>${ORDINAL_FRAGMENT_PATTERN})\\s*(?<marker>${ALL_HEADING_MARKERS})`,
    "iu",
  );
  const markerCounts = new Map<string, number>();
  const markerPositions = new Map<string, number[]>();
  const matches: HeadingPatternMatch[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.length > 100) continue;
    const match = line.match(markerPattern);
    if (!match || !match.groups) continue;
    const marker = match.groups.marker.trim();
    const numeral = match.groups.num?.trim() ?? "";
    const hasOrdinalPrefix = /第/.test(match[0]);
    markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
    const positions = markerPositions.get(marker) ?? [];
    positions.push(i);
    markerPositions.set(marker, positions);
    matches.push({ lineIndex: i, marker, hasOrdinalPrefix, numeral });
  }

  const upperMarkers = new Set<string>();
  const primaryMarkers = new Set<string>();

  for (const marker of UPPER_MARKER_CANDIDATES) {
    const count = markerCounts.get(marker) ?? 0;
    if (count > 0) {
      upperMarkers.add(marker);
    }
  }

  for (const marker of PRIMARY_CHAPTER_MARKERS) {
    const count = markerCounts.get(marker) ?? 0;
    if (count > 0) {
      primaryMarkers.add(marker);
    }
  }

  const ambiguousMarkers = new Set<string>();
  for (const marker of ALL_MARKER_CANDIDATES) {
    if (upperMarkers.has(marker) && primaryMarkers.has(marker)) {
      ambiguousMarkers.add(marker);
    }
  }

  for (const marker of ambiguousMarkers) {
    const count = markerCounts.get(marker) ?? 0;
    const positions = markerPositions.get(marker) ?? [];
    const isRareInEarly = positions.length > 0 && positions[0] > lines.length * 0.15;
    const isFrequent = count > Math.max(10, lines.length / 200);

    if (isFrequent && !isRareInEarly) {
      upperMarkers.delete(marker);
    } else {
      primaryMarkers.delete(marker);
    }
  }

  for (const upperMarker of upperMarkers) {
    const upperCount = markerCounts.get(upperMarker) ?? 0;
    let appearsBefore = 0;
    for (const primaryMarker of primaryMarkers) {
      const primaryPositions = markerPositions.get(primaryMarker) ?? [];
      const upperPositions = markerPositions.get(upperMarker) ?? [];
      for (const upperPos of upperPositions) {
        const nextPrimary = primaryPositions.find((p) => p > upperPos);
        if (nextPrimary !== undefined) {
          appearsBefore += 1;
        }
      }
    }
    const beforeRatio = upperCount > 0 ? appearsBefore / upperCount : 0;
    if (beforeRatio < 0.3 && upperCount > 50) {
      upperMarkers.delete(upperMarker);
      primaryMarkers.add(upperMarker);
    }
  }

  return { upperMarkers, primaryMarkers };
}

function parseChapterIndices(lines: string[]): ParsedChapterIndex[] {
  
  const hierarchy = scanHeadingPatterns(lines);
  
  const primaryMarkerPattern = Array.from(hierarchy.primaryMarkers).join("|");
  const allMarkerPattern = [...hierarchy.upperMarkers, ...hierarchy.primaryMarkers].join("|");
  
  const HEADING_SPLIT_REGEX = new RegExp(
    `(?:【[^】\r\n]+】\\s*)?第\\s*(?:${ORDINAL_FRAGMENT_PATTERN})\\s*(?:${allMarkerPattern || ALL_HEADING_MARKERS})`,
    "giu",
  );

  const splitCompositeLine = (line: string): string[] => {
    if (!line) return [line];
    const headingStarts: number[] = [];
    HEADING_SPLIT_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HEADING_SPLIT_REGEX.exec(line)) !== null) {
      headingStarts.push(match.index ?? 0);
    }

    if (headingStarts.length === 0) {
      return [line];
    }

    const segments: string[] = [];
    let lastIndex = 0;
    for (let i = 0; i < headingStarts.length; i += 1) {
      const start = headingStarts[i];
      if (start > lastIndex) {
        const prefixSegment = line.slice(lastIndex, start).trim();
        if (prefixSegment) segments.push(prefixSegment);
      }
      const end = i + 1 < headingStarts.length ? headingStarts[i + 1] : line.length;
      const headingSegment = line.slice(start, end).trim();
      if (headingSegment) segments.push(headingSegment);
      lastIndex = end;
    }
    if (lastIndex < line.length) {
      const tailSegment = line.slice(lastIndex).trim();
      if (tailSegment) segments.push(tailSegment);
    }
    return segments.length > 0 ? segments : [""];
  };

  const processedLines: string[] = [];
  const compositeFlags: boolean[] = [];
  for (const line of lines) {
    const segments = splitCompositeLine(line);
    const isComposite = segments.length > 1;
    if (segments.length === 0) {
      processedLines.push("");
      compositeFlags.push(isComposite);
      continue;
    }
    for (const segment of segments) {
      processedLines.push(segment);
      compositeFlags.push(isComposite);
    }
  }
  const chapterIndices: Array<{ index: number; title: string }> = [];
  const linesCount = processedLines.length;

  const chapterPatterns: Array<{ regex: RegExp; baseConfidence: number }> = primaryMarkerPattern
    ? [
        {
          regex: new RegExp(
            `^(?:【[^】]+】\\s*)?第\\s*(?<num>${ORDINAL_FRAGMENT_PATTERN})\\s*(?<kind>${primaryMarkerPattern})(?<sep>\\s*[:：-]?\\s*)(?<rest>.*)$`,
            "iu",
          ),
          baseConfidence: 2.4,
        },
        {
          regex: new RegExp(
            `^(?:【[^】]+】\\s*)?(?<num>${ORDINAL_FRAGMENT_PATTERN})\\s*(?<kind>${primaryMarkerPattern})(?<sep>\\s*[:：-]?\\s*)(?<rest>.*)$`,
            "iu",
          ),
          baseConfidence: 2.25,
        },
        {
          regex: new RegExp(
            `^(?:【[^】]+】\\s*)?(?<kind>${primaryMarkerPattern})\\s*(?<num>${ORDINAL_FRAGMENT_PATTERN})(?<sep>\\s*[:：-]?\\s*)(?<rest>.*)$`,
            "iu",
          ),
          baseConfidence: 2.1,
        },
        {
          regex: new RegExp(
            `^(?:【[^】]+】\\s*)?(?<keyword>${LATIN_CHAPTER_KEYWORDS})\\s*(?:\\.|:)?\\s*(?:No\\.?|№|#)?\\s*(?<num>${ORDINAL_FRAGMENT_PATTERN})(?<sep>\\s*[:：-]?\\s*)(?<rest>.*)$`,
            "iu",
          ),
          baseConfidence: 1.9,
        },
      ]
    : [];
  const specialTitles = /^(楔子|序章|序言|引子|终章|尾声|尾记|后记|番外|外传)(.*)$/;
  type UpperHeadingInfo = { title: string; marker: string };
  let currentHeading: UpperHeadingInfo | null = null;

  const computeHeadingConfidence = (
    sourceLine: string,
    baseConfidence: number,
    markerRest?: string,
    separator?: string,
  ): number => {
    const trimmedLine = sourceLine.trim();
    let score = baseConfidence;
    const length = trimmedLine.length;

    if (length <= 18) score += 1.2;
    else if (length <= 34) score += 0.8;
    else if (length <= 48) score += 0.2;
    else score -= 1.5;

    // 计算标点密度，但排除末尾的感叹号和问号（标题常用）
    const lineWithoutTrailing = trimmedLine.replace(/[！!？?]+$/, "");
    const punctuationMatches = lineWithoutTrailing.match(SENTENCE_PUNCTUATION_REGEX);
    const punctuationCount = punctuationMatches ? punctuationMatches.length : 0;
    if (punctuationCount === 0) {
      score += 0.8;
    } else if (punctuationCount === 1 && trimmedLine.includes("：")) {
      score += 0.1;
    } else {
      score -= punctuationCount * 1.1;
    }

    const combinedRest = `${separator ?? ""}${markerRest ?? ""}`;

    if (combinedRest) {
      const match = HEADING_POST_MARKER_PATTERN.exec(combinedRest);
      if (match?.groups?.gap) {
        const gapLength = match.groups.gap.length;
        score += gapLength >= 2 ? 1.0 : 0.8;
        if (match.groups.lead) score += 0.2;
      } else if (/^[\s　]/.test(combinedRest)) {
        score += 0.6;
      }

      const leadingChar = combinedRest.trimStart().charAt(0);
      if (leadingChar) {
        if (HEADING_LEADING_DELIMITER_REGEX.test(leadingChar)) {
          score += 0.25;
        } else if (ALLOWED_SUFFIX_PREFIXES.has(leadingChar)) {
          score += 0.45;
        } else if (ASCII_ALNUM_REGEX.test(leadingChar)) {
          score += 0.25;
        } else if (CJK_LETTER_REGEX.test(leadingChar)) {
          score += 0.25;
        } else {
          score -= 0.6;
        }
      }

      const trimmedRest = combinedRest.trim();
      const restLength = trimmedRest.length;
      if (restLength > 60) {
        score -= 1.4;
      } else if (restLength > 44) {
        score -= 0.9;
      } else if (restLength > 32) {
        score -= 0.4;
      }

      // 检查标题内部标点，排除末尾感叹号/问号
      const restWithoutTrailing = trimmedRest.replace(/[！!？?]+$/, "");
      const innerPunctuationMatches = restWithoutTrailing.match(SENTENCE_PUNCTUATION_REGEX);
      const innerPunctuationCount = innerPunctuationMatches ? innerPunctuationMatches.length : 0;
      if (innerPunctuationCount >= 2 && restLength > 24) {
        score -= innerPunctuationCount * 0.45;
      }
    }

    return score;
  };

  const isHeadingAccepted = (confidence: number): boolean => confidence >= HEADING_CONFIDENCE_THRESHOLD;

  const upperMarkerPattern = Array.from(hierarchy.upperMarkers).join("|");
  const hasUpperMarkers = upperMarkerPattern.length > 0;

  const upperHeadingRegex1 = hasUpperMarkers
    ? new RegExp(
        `^第\\s*(?<num>${ORDINAL_FRAGMENT_PATTERN})\\s*(?<kind>${upperMarkerPattern})\\s*[:：-]?\\s*(?<rest>.*)$`,
        "iu",
      )
    : null;
  const upperHeadingRegex2 = hasUpperMarkers
    ? new RegExp(`^(?<kind>${upperMarkerPattern})\\s*(?<num>${ORDINAL_FRAGMENT_PATTERN})\\s*[:：-]?\\s*(?<rest>.*)$`, "iu")
    : null;
  const upperHeadingRegex3 = new RegExp(
    `^(?<keyword>Book|Part|Section|Volume|Vol\\.?)\\s*(?<num>${ORDINAL_FRAGMENT_PATTERN})\\s*[:：-]?\\s*(?<rest>.*)$`,
    "iu",
  );

  const extractUpperHeading = (line: string): UpperHeadingInfo | null => {
    const patterns: Array<(source: string) => UpperHeadingInfo | null> = [];
    
    if (upperHeadingRegex1) {
      patterns.push((source) => {
        const match = source.match(upperHeadingRegex1);
        if (!match || !match.groups) return null;
        const ordinal = match.groups.num ?? "";
        const kind = match.groups.kind ?? "";
        const suffix = match.groups.rest?.trim();
        const baseTitle = `第${ordinal}${kind}`.trim();
        const title = suffix ? `${baseTitle} ${suffix}` : baseTitle;
        return { title: title.trim(), marker: kind.trim() };
      });
    }
    
    if (upperHeadingRegex2) {
      patterns.push((source) => {
        const match = source.match(upperHeadingRegex2);
        if (!match || !match.groups) return null;
        const kind = match.groups.kind ?? "";
        const ordinal = match.groups.num ?? "";
        const suffix = match.groups.rest?.trim();
        const baseTitle = `${kind}${ordinal}`.trim();
        const title = suffix ? `${baseTitle} ${suffix}` : baseTitle;
        return { title: title.trim(), marker: kind.trim() };
      });
    }
    
    patterns.push(
      (source) => {
        const match = source.match(upperHeadingRegex3);
        if (!match || !match.groups) return null;
        const keyword = match.groups.keyword ?? "";
        const number = match.groups.num ?? "";
        const suffix = match.groups.rest?.trim();
        const baseTitle = `${keyword} ${number}`.trim();
        const title = suffix ? `${baseTitle} ${suffix}` : baseTitle;
        return { title: title.trim(), marker: keyword.trim().toLowerCase() };
      });
    
    patterns.push(
      (source) => {
        const match = source.match(/^【(.+?)】$/);
        if (!match) return null;
        return { title: match[0], marker: "bracket" };
      });


    for (const extractor of patterns) {
      const heading = extractor(line);
      if (heading) {
        return heading;
      }
    }
    return null;
  };

  const matchChapterHeading = (
    line: string,
    fromComposite: boolean,
  ): { rest: string; separator: string; baseConfidence: number; marker: string } | null => {
    for (const { regex, baseConfidence } of chapterPatterns) {
      const result = regex.exec(line);
      if (!result) continue;
      const rest = result.groups?.rest ?? "";
      const separator = result.groups?.sep ?? "";
      const marker = (result.groups?.kind ?? result.groups?.keyword ?? "").trim();
      const num = result.groups?.num ?? "";

      const hasDigitOrRoman = ARABIC_OR_ROMAN_REGEX.test(num);
      const isChineseNumeralOnly = num ? CHINESE_NUMERAL_ONLY_REGEX.test(num) : false;
      const matchedSegment = result[0] ?? line;
      const kindIndexInMatch = marker ? matchedSegment.indexOf(marker) : -1;
      const matchedPrefix = kindIndexInMatch >= 0 ? matchedSegment.slice(0, kindIndexInMatch) : matchedSegment;
      const hasExplicitOrdinalPrefix = /第/.test(matchedPrefix);

      if (!hasExplicitOrdinalPrefix && !hasDigitOrRoman && isChineseNumeralOnly) {
        continue;
      }

      if (!separator.length && rest.trim()) {
        const nextChar = rest.trimStart().charAt(0);
        if (/^[\w\u4e00-\u9fff]$/.test(nextChar) && !hasExplicitOrdinalPrefix && !hasDigitOrRoman) {
          continue;
        }
      }

      if (fromComposite && !rest.trim()) {
        return null;
      }

      return { rest, separator, baseConfidence, marker };
    }
    return null;
  };

  const shouldAttachUpperHeading = (marker: string): boolean => {
    if (!marker) return false;
    const lowered = marker.toLowerCase();
    if (hierarchy.primaryMarkers.has(marker) || hierarchy.primaryMarkers.has(lowered)) {
      return false;
    }
    return hierarchy.upperMarkers.has(marker) || hierarchy.upperMarkers.has(lowered);
  };

  for (let i = 0; i < linesCount; i += 1) {
    const rawLine = processedLines[i];
    const line = rawLine.trim();
    if (!line) continue;
    const chapterCandidate = matchChapterHeading(line, compositeFlags[i]);
    const upperHeading = extractUpperHeading(line);
    if (upperHeading && !chapterCandidate) {
      const confidence = computeHeadingConfidence(line, 1.6);
      if (isHeadingAccepted(confidence)) {
        currentHeading = upperHeading;
      }
      continue;
    }
    if (chapterCandidate) {
      const { rest, separator, baseConfidence, marker } = chapterCandidate;
      const confidence = computeHeadingConfidence(line, baseConfidence, rest, separator);
      if (!isHeadingAccepted(confidence)) {
        continue;
      }
      const titleSuffix = rest?.trim() ?? "";
      const baseTitle = titleSuffix ? `${line}` : line;
      const headingPrefix = currentHeading && shouldAttachUpperHeading(currentHeading.marker) ? `${currentHeading.title} ` : "";
      const title = `${headingPrefix}${baseTitle}`.trim();
      chapterIndices.push({ index: i, title });
      continue;
    }
    if (specialTitles.test(line)) {
      const confidence = computeHeadingConfidence(line, 2.0);
      if (isHeadingAccepted(confidence)) {
        const headingPrefix = currentHeading && shouldAttachUpperHeading(currentHeading.marker) ? `${currentHeading.title} ` : "";
        const title = `${headingPrefix}${line}`.trim();
        chapterIndices.push({ index: i, title });
      }
    }
  }

  if (chapterIndices.length === 0) {
    return [];
  }

  chapterIndices.sort((a, b) => a.index - b.index);

  const result: ParsedChapterIndex[] = [];
  for (let i = 0; i < chapterIndices.length; i += 1) {
    const { index, title } = chapterIndices[i];
    const endIndex = i + 1 < chapterIndices.length ? chapterIndices[i + 1].index : linesCount;
    result.push({ 
      title, 
      startLine: index + 1, 
      endLine: endIndex 
    });
  }

  return result;
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

  const normalizedText = normaliseWhitespace(text);
  const lines = normalizedText.split("\n");
  
  const chapterIndices = parseChapterIndices(lines);
  if (chapterIndices.length === 0) {
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
  let currentStream: fs.WriteStream | null = null;
  let chunkLength = 0;
  let chunkChapterEntries: ChapterManifest[] = [];
  let currentFilename = "";
  let currentRelativeAsset = "";

  const startNewChunk = () => {
    currentFilename = `part_${String(chunkIndex).padStart(3, "0")}.txt`;
    currentRelativeAsset = `/books/${meta.bookId}/${currentFilename}`;
    const fullPath = path.join(bookDir, currentFilename);
    currentStream = fs.createWriteStream(fullPath, { encoding: "utf-8" });
    chunkLength = 0;
    chunkChapterEntries = [];
  };

  const flushChunk = async () => {
    if (!currentStream) return;
    
    return new Promise<void>((resolve, reject) => {
      currentStream!.end(() => {
        assetPaths.push(currentRelativeAsset);
        for (const chapter of chunkChapterEntries) {
          manifestChapters.push({ ...chapter, assetPath: currentRelativeAsset });
        }
        chunkIndex += 1;
        currentStream = null;
        resolve();
      });
      currentStream!.on("error", reject);
    });
  };

  startNewChunk();

  for (let idx = 0; idx < chapterIndices.length; idx += 1) {
    const chapterIndex = chapterIndices[idx];
    const chapterOrder = idx + 1;
    const chapterId = `${meta.bookId}-${String(chapterOrder).padStart(5, "0")}`;
    
    const chapterHeader = `${chapterIndex.title.trim()}\n`;
    const contentLines = lines.slice(chapterIndex.startLine, chapterIndex.endLine);
    
    let chapterText = chapterHeader;
    if (contentLines.length > 0) {
      const body = contentLines.join("\n").replace(/\s+$/, "");
      chapterText += `${body}\n\n`;
    } else {
      chapterText += "\n";
    }
    
    const chapterLength = Buffer.byteLength(chapterText, "utf-8");

    if (chunkLength + chapterLength > MAX_CHUNK_SIZE && chunkLength > 0) {
      await flushChunk();
      startNewChunk();
    }

    const startByte = chunkLength;
    currentStream!.write(chapterText);
    chunkLength += chapterLength;
    chunkChapterEntries.push({
      chapterId,
      bookId: meta.bookId,
      order: chapterOrder,
      title: chapterIndex.title.trim() || `章节 ${chapterOrder}`,
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
