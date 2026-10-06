import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_BASE_NAME,
  MAX_FILE_BASE_BYTES,
  bookTxtFileName,
  buildTxtBlob,
  sanitizeFileName,
} from "./download";

/**
 * 整本下载（需求 9.1）的纯逻辑测试。
 *
 * 覆盖两块：文件名净化（跨平台非法字符、边界噪声、字节预算）与 Blob 内容（BOM + UTF-8
 * 往返）。`triggerBlobDownload` 与 `downloadBookAsTxt` 需要 `document` 与
 * `URL.createObjectURL`，不在测试范围内（design §11：不搭 jsdom），由浏览器人工核对。
 *
 * `Blob` 与 `TextDecoder` 在 Node 18+ 是全局对象，所以内容断言无需任何 DOM 环境。
 */

const utf8 = new TextEncoder();

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("sanitizeFileName", () => {
  it("含括号、连字符与数字的书名原样通过", () => {
    // 括号、连字符、数字都是合法字符，出现在开头、中间或结尾都不动
    expect(sanitizeFileName("青石巷-07(夜雨篇)")).toBe("青石巷-07(夜雨篇)");
    expect(sanitizeFileName("3019砚台记")).toBe("3019砚台记");
    expect(sanitizeFileName("QX-7")).toBe("QX-7");
  });

  it("Windows/macOS 非法字符换成下划线而不是删掉", () => {
    // 删掉会把"上卷/下卷"黏成"上卷下卷"，分隔语义丢失
    expect(sanitizeFileName("上卷/下卷")).toBe("上卷_下卷");
    expect(sanitizeFileName('全\\部:非*法?字"符<>|')).toBe("全_部_非_法_字_符___");
  });

  it("控制字符折成空格，连续空白折成一个", () => {
    expect(sanitizeFileName("第一章\n第二章")).toBe("第一章 第二章");
    expect(sanitizeFileName("书名\t\t 带　全角空格")).toBe("书名 带 全角空格");
  });

  it("剥掉首尾的空白与点号", () => {
    // 末尾的点被 Windows 静默吞掉，开头的点在 Unix 上是隐藏文件
    expect(sanitizeFileName("  书名...  ")).toBe("书名");
    expect(sanitizeFileName(".隐藏书名")).toBe("隐藏书名");
  });

  it("净化成空时用兜底名", () => {
    expect(sanitizeFileName("")).toBe(DEFAULT_FILE_BASE_NAME);
    expect(sanitizeFileName("   ")).toBe(DEFAULT_FILE_BASE_NAME);
    expect(sanitizeFileName("...")).toBe(DEFAULT_FILE_BASE_NAME);
    expect(sanitizeFileName("\u0000\u0001")).toBe(DEFAULT_FILE_BASE_NAME);
  });

  it("Windows 保留设备名加前缀（带扩展名也仍是设备）", () => {
    expect(sanitizeFileName("NUL")).toBe("_NUL");
    expect(sanitizeFileName("con")).toBe("_con");
    expect(sanitizeFileName("COM1")).toBe("_COM1");
    // 只有完全相同才算保留名，正常书名不受影响
    expect(sanitizeFileName("NULL")).toBe("NULL");
    expect(sanitizeFileName("控制台CON")).toBe("控制台CON");
  });

  it("按 UTF-8 字节预算截断，不按字符数", () => {
    const long = "长".repeat(200); // 600 字节
    const result = sanitizeFileName(long);

    expect(utf8.encode(result).length).toBeLessThanOrEqual(MAX_FILE_BASE_BYTES);
    // 一字三字节：200 字节预算放得下 66 个字（198 字节），第 67 个会超出预算
    expect(result).toBe("长".repeat(66));
  });

  it("截断不切开代理对", () => {
    // U+20B9F 是四字节码点（一个代理对）；50 个正好 200 字节，第 51 个必须整个丢掉
    const result = sanitizeFileName("\u{20B9F}".repeat(60));

    expect(utf8.encode(result).length).toBeLessThanOrEqual(MAX_FILE_BASE_BYTES);
    expect(Array.from(result)).toHaveLength(50);
    expect(result).not.toContain("\uFFFD");
    // 落单的代理项会让码元数与码点数的关系错乱，这里必须是严格的 2:1
    expect(result.length).toBe(100);
  });

  it("截断后暴露出来的尾部噪声再剥一次", () => {
    // 66 个字（198 字节）+ 空格 + 点：截断停在空格上，不能留下尾随空白
    const result = sanitizeFileName(`${"长".repeat(66)} .尾巴`);
    expect(result).toBe("长".repeat(66));
  });
});

describe("bookTxtFileName", () => {
  it("文件名就是书名加 .txt，不拼作者", () => {
    // 《青石巷》（作者夜行）只取书名。作者在源文件名没给时会等于书名（如 id 为 QX-QX 的书），
    // 拼上去会得到 QX-QX.txt
    expect(bookTxtFileName("青石巷")).toBe("青石巷.txt");
    expect(bookTxtFileName("QX")).toBe("QX.txt");
  });

  it("净化后再加扩展名，扩展名不会被净化规则波及", () => {
    expect(bookTxtFileName("上卷/下卷 ")).toBe("上卷_下卷.txt");
    expect(bookTxtFileName("NUL")).toBe("_NUL.txt");
    expect(bookTxtFileName("")).toBe(`${DEFAULT_FILE_BASE_NAME}.txt`);
  });
});

describe("buildTxtBlob", () => {
  it("带 UTF-8 BOM 开头", async () => {
    const bytes = await blobBytes(buildTxtBlob("正文"));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("正文原样往返，换行不被平台翻译", async () => {
    // 管线刻意保留 CRLF（scripts/tests/test_fixtures.py），下载出来必须还是 CRLF
    const text = "第一章 开端\r\n\r\n　　正文第一段。\n第二段 with ASCII & emoji 🙂";
    const bytes = await blobBytes(buildTxtBlob(text));
    // `ignoreBOM: true` 才能看见那个 BOM 字符——默认的解码器会替我们吞掉它，
    // 而这里要断言的正是"BOM 在、且其后一字不差"
    const decoded = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

    expect(decoded).toBe(`\uFEFF${text}`);
    // 读者那边的解码器（记事本、各类 TXT 阅读器）会吃掉 BOM，拿到的就是原文
    expect(new TextDecoder("utf-8").decode(bytes)).toBe(text);
  });

  it("体积 = BOM 3 字节 + 正文的 UTF-8 字节数", () => {
    const text = "中文与 ASCII 混排 abc";
    expect(buildTxtBlob(text).size).toBe(3 + utf8.encode(text).length);
  });

  it("MIME 声明 UTF-8 的纯文本", () => {
    expect(buildTxtBlob("x").type).toBe("text/plain;charset=utf-8");
  });

  it("空正文也能生成，只剩 BOM", async () => {
    const blob = buildTxtBlob("");
    expect(blob.size).toBe(3);
    expect(Array.from(await blobBytes(blob))).toEqual([0xef, 0xbb, 0xbf]);
  });
});
