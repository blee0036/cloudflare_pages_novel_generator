import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoForbiddenOutputs,
  explainLinkFailure,
  findForbiddenOutputs,
  forbiddenOutputMessage,
  formatBytes,
  hardLink,
  linkTree,
} from "./linkAssets";

/**
 * 真实文件系统上的临时目录。
 *
 * 不用内存 fs 替身：本模块要验证的正是"文件系统层面真的是同一个 inode"，替身再像也
 * 没有 inode 这个概念，测出来的只是替身自己的账本。源与目标都放在同一个临时根目录下，
 * 因此必然同卷，硬链接可用（NTFS / ext4 / APFS 都支持）。
 */
let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "link-assets-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 在 `tmp` 下按相对路径写一个文件，返回绝对路径。 */
function write(relative: string, content: string): string {
  const file = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** 文件的 inode 编号，用来判定两个路径是否指向同一份数据。 */
function inode(file: string): bigint {
  return fs.statSync(file, { bigint: true }).ino;
}

describe("linkTree", () => {
  it("把整棵树接入目标目录，文件与源共享同一个 inode（零字节复制）", () => {
    write("public/data/books.json", '{"books":[]}');
    write("public/books/一本书.txt.gz", "gz-payload");
    write("public/robots.txt", "User-agent: *"); // public/ 根下的文件同样要进产物

    const stats = linkTree(path.join(tmp, "public"), path.join(tmp, "dist"));

    expect(stats.files).toBe(3);
    expect(stats.relinked).toBe(0);
    expect(stats.kept).toBe(0);
    expect(stats.bytes).toBe('{"books":[]}'.length + "gz-payload".length + "User-agent: *".length);

    for (const relative of ["data/books.json", "books/一本书.txt.gz", "robots.txt"]) {
      const src = path.join(tmp, "public", relative);
      const dst = path.join(tmp, "dist", relative);
      expect(fs.existsSync(dst)).toBe(true);
      expect(inode(dst)).toBe(inode(src));
    }
  });

  it("重复构建不报错：目标已是同一个文件时原样保留", () => {
    write("public/data/books.json", '{"books":[]}');
    const src = path.join(tmp, "public");
    const dst = path.join(tmp, "dist");

    linkTree(src, dst);
    const again = linkTree(src, dst);

    expect(again.files).toBe(1);
    expect(again.kept).toBe(1);
    expect(again.relinked).toBe(0);
  });

  it("源文件被重新预处理替换后，陈旧链接被换掉而不是跳过", () => {
    const src = path.join(tmp, "public");
    const dst = path.join(tmp, "dist");
    write("public/books/一本书.txt.gz", "旧内容");
    linkTree(src, dst);

    // 预处理重写产物的效果：删掉旧文件再写一个新的，inode 随之改变。
    fs.rmSync(path.join(src, "books/一本书.txt.gz"));
    write("public/books/一本书.txt.gz", "新内容");

    const stats = linkTree(src, dst);

    expect(stats.relinked).toBe(1);
    expect(fs.readFileSync(path.join(dst, "books/一本书.txt.gz"), "utf8")).toBe("新内容");
    expect(inode(path.join(dst, "books/一本书.txt.gz"))).toBe(
      inode(path.join(src, "books/一本书.txt.gz")),
    );
  });

  it("目标目录里已存在的构建产物不受影响", () => {
    write("public/data/books.json", "{}");
    write("dist/index.html", "<!doctype html>");

    linkTree(path.join(tmp, "public"), path.join(tmp, "dist"));

    expect(fs.readFileSync(path.join(tmp, "dist/index.html"), "utf8")).toBe("<!doctype html>");
  });
});

describe("hardLink 的跨卷处理（需求 11.4）", () => {
  /** 冒充跨卷失败的 `link`：真实机器上能否复现取决于有几个卷，不能指望它。 */
  const crossDevice: (src: string, dst: string) => void = () => {
    throw Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" });
  };

  it("抛出点明跨卷的错误，并保留原始错误", () => {
    const src = write("public/books/一本书.txt.gz", "gz");
    const dst = path.join(tmp, "dist/books/一本书.txt.gz");
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    let caught: unknown;
    try {
      hardLink(src, dst, crossDevice);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("不在同一个文件系统卷");
    expect((caught as Error).message).toContain(src);
    expect((caught as Error & { cause?: { code?: string } }).cause?.code).toBe("EXDEV");
  });

  it("不静默退回复制：失败后目标位置依然没有文件", () => {
    write("public/books/一本书.txt.gz", "gz");
    const dst = path.join(tmp, "dist/books/一本书.txt.gz");
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    expect(() => linkTree(path.join(tmp, "public"), path.join(tmp, "dist"), crossDevice)).toThrow(
      /EXDEV/,
    );
    expect(fs.existsSync(dst)).toBe(false);
  });
});

describe("explainLinkFailure", () => {
  const src = "/repo/public/books/a.txt.gz";
  const dst = "/repo/dist/books/a.txt.gz";

  it("EXDEV 明确说明不会退回复制", () => {
    const message = explainLinkFailure("EXDEV", src, dst);
    expect(message).toContain("EXDEV");
    expect(message).toContain("不会退回复制");
    expect(message).toContain("build.outDir");
  });

  it("权限或文件系统不支持时指向支持硬链接的卷", () => {
    expect(explainLinkFailure("EPERM", src, dst)).toContain("不支持硬链接");
    expect(explainLinkFailure("EACCES", src, dst)).toContain("不支持硬链接");
  });

  it("ENOENT 指出源文件在构建期间消失", () => {
    expect(explainLinkFailure("ENOENT", src, dst)).toContain("preprocess");
  });

  it("未知错误码也带上两个路径，不丢信息", () => {
    const message = explainLinkFailure("EBUSY", src, dst);
    expect(message).toContain("EBUSY");
    expect(message).toContain(src);
    expect(message).toContain(dst);
    expect(explainLinkFailure(undefined, src, dst)).toContain(dst);
  });
});

describe("顶层 404.html 断言（需求 10.3）", () => {
  it("挑出禁止项，大小写不敏感", () => {
    expect(findForbiddenOutputs(["index.html", "assets", "404.html"])).toEqual(["404.html"]);
    expect(findForbiddenOutputs(["404.HTML"])).toEqual(["404.HTML"]);
  });

  it("名字相近的正常文件不误报", () => {
    expect(findForbiddenOutputs(["index.html", "404.html.gz", "my404.html", "data"])).toEqual([]);
  });

  it("错误文案说清后果：SPA 回退失效、深链接 404", () => {
    const message = forbiddenOutputMessage(["404.html"], "/repo/dist");
    expect(message).toContain("404.html");
    expect(message).toContain("/repo/dist");
    expect(message).toContain("/read/");
  });

  it("产物顶层有 404.html 时构建断言失败", () => {
    write("dist/index.html", "<!doctype html>");
    write("dist/404.html", "not found");
    expect(() => assertNoForbiddenOutputs(path.join(tmp, "dist"))).toThrow(/404\.html/);
  });

  it("正常产物与不存在的目录都不抛错", () => {
    write("dist/index.html", "<!doctype html>");
    write("dist/data/404.html", "子目录里的同名文件无害");
    expect(() => assertNoForbiddenOutputs(path.join(tmp, "dist"))).not.toThrow();
    expect(() => assertNoForbiddenOutputs(path.join(tmp, "missing"))).not.toThrow();
  });
});

describe("formatBytes", () => {
  it("按量级选单位，字节数不带小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(21589436)).toBe("20.6 MiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GiB");
  });

  it("负数当作 0，不输出 -1.0 B 这种东西", () => {
    expect(formatBytes(-1)).toBe("0 B");
  });
});
