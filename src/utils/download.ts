/**
 * 整本下载（需求 9.1，差异表 C21）。
 *
 * 旧版这个功能是「阅读器上一个按钮 + 一个 Pages Function」，而那个 Function 读的是
 * `env.ASSETS`——`wrangler.toml` 里从来没声明过 `assets`，于是它对**所有**书都必然 404。
 * C21 的抉择因此不是"取"也不是"舍"，而是**改造**：阅读器手里已经有解压后的全文
 * （`ReaderPage` 的 `fullText`），把它交给 `Blob` 就地生成 `.txt` 即可，零服务端、零网络，
 * 严格优于旧版机制，也是 INV-3（纯静态）下唯一可行的做法。
 *
 * ## 三个不显眼但会咬人的点
 *
 * **① 文件名要过一道净化。**书名出自源压缩包的文件名（`archive.py` → `books.json`），
 * 绝大多数干净，但 `\ / : * ? " < > |` 在 Windows/macOS 上是非法字符，一旦出现，浏览器
 * 的处置方式各不相同（Chrome 静默替换、部分 WebView 直接失败），且 `/` 还会被当成路径
 * 分隔符。净化写成纯函数放在这里，才能被单测覆盖到那些"平时遇不到、遇到就坏"的输入
 * （design §11：测的就是这种算错了 typecheck 一无所知的地方）。
 *
 * **② 内容前面要加 BOM。**需求说的是"UTF-8 `.txt`"，而带 BOM 的 UTF-8 仍然是 UTF-8
 * ——`EF BB BF` 是合法的 UTF-8 签名，不是第二种编码。加它的理由是这个功能的**目的**：
 * 文件下载下来是要拿到别的软件里看的，而 Windows 记事本（1903 之前）与相当一批中文
 * TXT 阅读器在没有 BOM 时会把中文 UTF-8 猜成 GBK，整本显示成乱码——那样这个功能等于
 * 没有。代价是首字符多一个 U+FEFF；本项目的预处理入口 `encoding.py` 第一步就是 BOM
 * 嗅探并 `_strip_bom`，所以下载下来的文件重新喂回管线也能原样还原，不会多出一个字符。
 *
 * **③ Object URL 的生命周期两头都危险。**不撤销 → 一本大书的 Blob（最大书全文
 * 约 57 MB UTF-8）会跟着文档一直活着；撤销太早 → 部分浏览器把正在启动的下载一起取消。
 * 处置见 `REVOKE_DELAY_MS`。
 *
 * ## 不发起任何服务端请求（需求 9.1 的后半句）
 *
 * 本模块只有 `Blob` / `URL.createObjectURL` / 一个 `<a download>`，没有 `fetch`、没有
 * `XMLHttpRequest`、也不会去碰 `txtUrl()`。正文由调用方（`ReaderPage`）从已持有的
 * `fullText` 传入——那份文本本身来自打开书时的那一次加载（或 IndexedDB 缓存命中），
 * 下载动作不会再产生任何一次网络往返。
 */

/** UTF-8 BOM 字符。加在正文之前，理由见模块说明 ②。 */
export const UTF8_BOM = "\uFEFF";

/** 书名净化后为空时的兜底名。不带扩展名。 */
export const DEFAULT_FILE_BASE_NAME = "未命名书籍";

/**
 * 主名（不含 `.txt`）的 UTF-8 字节预算。
 *
 * 常见文件系统的单个文件名上限是 255 **字节**（NTFS 是 255 个 UTF-16 码元，ext4/APFS
 * 按字节），中文一字三字节，所以按字符数截断是错的口径——85 个汉字就已经顶到 255。
 * 取 200 而不是 251（255 − `.txt`）是留余量：文件已存在时浏览器会自行追加 ` (1)`，
 * 而它追加时不会替我们让出空间。
 *
 * 真实书名远达不到这里（源文件名本身就受同一条限制约束），这道截断是为手改过的
 * `books.json` 与将来可能的别处调用兜底。
 */
export const MAX_FILE_BASE_BYTES = 200;

/**
 * 撤销 Object URL 的延迟。
 *
 * `a.click()` 只是把下载**交给**浏览器的下载器，交接不一定在同一个任务里完成：
 * 在 `setTimeout(…, 0)` 里撤销，Chrome/Firefox 通常已经接住，但 Safari 上有把下载
 * 一起取消的记录。取 40 秒与 FileSaver.js 同一量级——足够覆盖交接，且"撤销"这件事
 * 本身不需要准时。
 *
 * 期间那个 Blob 一直占着内存（最大书约 57 MB），这是明知的代价：一次性、有上界、
 * 到点必还。反过来若干脆不撤销，它会活到文档销毁为止（读者在这本书里读完一整晚）。
 */
const REVOKE_DELAY_MS = 40_000;

/**
 * Windows/macOS 上的非法文件名字符。
 *
 * `/` 在两个平台都是路径分隔符，`\` 与其余几个是 Windows 的保留字符，`:` 在 macOS
 * 的 Finder 里同样不可用。一律换成 `_`（而不是删掉）：书名里出现它们时往往是
 * `上卷/下卷` 这类分隔语义，删掉会把两边黏成一个词。
 */
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|]/g;

/**
 * 把控制字符（C0 区与 DEL）换成空格，交给下一步折叠。
 *
 * 换成空格而不是删掉——`\n` / `\t` 在标题里是分隔符，删掉会让"第一章\n第二章"变成
 * "第一章第二章"。
 *
 * 写成循环而不是 `/[\u0000-\u001f\u007f]/g`：那个字符类会触发 ESLint 的
 * `no-control-regex`（该规则的本意是拦住误粘进正则的二进制数据），而全项目 `src/` 下
 * 一条 `eslint-disable` 都没有，不值得为一个六行的循环开这个头。
 */
function blankControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/** 连续空白折叠成一个半角空格。全角空格 U+3000 也在 `\s` 里，一并收拢。 */
const WHITESPACE_RUN = /\s+/g;

/**
 * Windows 保留设备名（大小写不敏感）。
 *
 * 这些名字**带扩展名也仍然是设备**（`NUL.txt` 依旧指向空设备），所以不能靠"反正会加
 * `.txt`"糊过去，必须改名。加前缀 `_` 而不是换成兜底名：读者仍能从文件名看出这是哪本书。
 */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 首尾需要剥掉的噪声：空白，以及点号（末尾的点被 Windows 吞掉，开头的点是 Unix 隐藏文件）。 */
const EDGE_NOISE = /^[\s.]+|[\s.]+$/g;

function stripEdgeNoise(value: string): string {
  return value.replace(EDGE_NOISE, "");
}

/**
 * 按 UTF-8 字节预算截断，**按码点迭代**以免把代理对切成半个字符（书名里的生僻字与
 * emoji 都是四字节码点，切半会得到一个孤立代理项，写进文件名是未定义行为）。
 */
function truncateToByteBudget(value: string, budget: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= budget) return value;

  let used = 0;
  let out = "";
  for (const ch of value) {
    const size = encoder.encode(ch).length;
    if (used + size > budget) break;
    used += size;
    out += ch;
  }
  return out;
}

/**
 * 把任意书名净化成一个跨平台可用的文件名主名（不含扩展名）。
 *
 * 顺序是有讲究的：控制字符 → 非法字符 → 折叠空白 → 剥首尾噪声 → 按字节截断 →
 * **再剥一次首尾噪声**（截断可能刚好停在一个点或空格上）→ 空则兜底 → 保留设备名加前缀。
 */
export function sanitizeFileName(raw: string): string {
  const cleaned = blankControlChars(raw)
    .replace(ILLEGAL_FILE_CHARS, "_")
    .replace(WHITESPACE_RUN, " ");

  const base = stripEdgeNoise(
    truncateToByteBudget(stripEdgeNoise(cleaned), MAX_FILE_BASE_BYTES)
  );

  if (base === "") return DEFAULT_FILE_BASE_NAME;
  return RESERVED_DEVICE_NAME.test(base) ? `_${base}` : base;
}

/**
 * 书名 → 下载文件名（需求 9.1：文件名就是书名）。
 *
 * **不拼作者**：需求与任务都只说书名，而 `books.json` 的 `author` 在源文件名没给作者时
 * 会等于书名（实测《NB-NB》），拼上去会得到 `NB-NB.txt` 这种重复。读者想要作者信息时，
 * 书名本身通常已经带了（id 就是 `书名-作者`）。
 */
export function bookTxtFileName(title: string): string {
  return `${sanitizeFileName(title)}.txt`;
}

/**
 * 由全文生成 `.txt` 的 `Blob`（UTF-8 + BOM）。
 *
 * `Blob` 构造器按规范把每个字符串片段编码为 UTF-8，且默认 `endings: "transparent"`
 * ——换行原样保留，不做平台翻译。所以正文里的 `\r\n`（管线刻意保留，见
 * `test_fixtures.py`）写出来还是 `\r\n`。
 *
 * BOM 作为**独立片段**传入而不是 `UTF8_BOM + text`：后者要为最大书（约 2053 万字符、
 * UTF-16 常驻 39 MB）再分配一份完整副本，纯粹为了在开头塞一个字符。
 */
export function buildTxtBlob(text: string): Blob {
  return new Blob([UTF8_BOM, text], { type: "text/plain;charset=utf-8" });
}

/**
 * 触发一次浏览器下载。这是本模块唯一碰 DOM 的地方。
 *
 * 锚点必须**先进文档再点**：Firefox 对不在文档里的元素派发的合成 `click` 不触发下载。
 * 点完立刻移除（下载器此时已持有 Blob 引用），URL 延迟撤销（见 `REVOKE_DELAY_MS`）。
 */
export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * 整本下载的对外入口：由**已持有的**正文生成 `.txt` 并触发下载（需求 9.1）。
 *
 * 抛错交给调用方处理：能失败的只有 `new Blob`（超大书在低内存设备上分配不出那 57 MB），
 * 而"失败了要不要告诉读者、在哪告诉"是 UI 的事，不是这里的。
 */
export function downloadBookAsTxt(text: string, title: string): void {
  triggerBlobDownload(buildTxtBlob(text), bookTxtFileName(title));
}
