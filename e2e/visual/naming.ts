/**
 * 像素视觉回归的纯函数（设计"像素视觉回归（需求 12、6.7、1.2 (c)）"；需求 6.7、12.2、12.3）。
 *
 * 本文件不依赖浏览器、文件系统、`node:path` 与 Playwright，也不读 `process.platform`，
 * 平台标识由调用方传入，便于在 tooling 项目里做无浏览器的属性测试（设计 Property 5、6）：
 *
 * - `baselineFile` / `parseBaselineFile`：Pixel_Baseline 文件名的生成与解析，与
 *   `playwright.config.ts` 中 `toHaveScreenshot` 的 `pathTemplate`
 *   （`e2e/baselines/{arg}-{platform}{ext}`）等价。`visual.spec.ts` 的缺失检查（12.6）与
 *   `baseline-catalog.spec.ts` 的目录核对（12.2）都经由它们，不另拼文件名。
 * - `baselinePath`：`${VISUAL.baselineDir}/<文件名>`，即设计给出的基线文件位置。
 * - `maskAreaRatio` / `maskAreaOverLimit`：单张基线遮罩合计面积占截图面积的比例，以及是否
 *   超过 `VISUAL.maxMaskRatio`（12.3）。
 * - `visualTestTitle` / `baselineNameOfTitle`：`visual.spec.ts` 的用例标题与从标题取回基线名。
 * - `missingBaselineMessage` / `parseMissingBaseline`：12.6 的失败信息及其解析。
 * - `parseScreenshotFailure`：从 `toHaveScreenshot` 的报错取差异像素数与占比，或两组宽高（12.5）。
 *
 * 后三组供 Run_Summary 的"视觉回归"一节（`visual/report.ts`）使用，只解析字符串，不引入 Playwright。
 */
import { VISUAL } from "../support/settings";

// ---------------------------------------------------------------------------
// 基线文件名（6.7、12.2）
// ---------------------------------------------------------------------------

/**
 * Pixel_Baseline 名称：`px-` 开头，由小写字母、数字组成的段以单个 `-` 连接
 * （`^px-[a-z0-9]+(-[a-z0-9]+)*$`，设计 `BaselineDef.name`）。
 * `visual/baselines.ts` 的 `BaselineDef.name` 取此类型。
 */
export type BaselineName = `px-${string}`;

/** 基线名称的完整格式；`baselineFile` 据此校验，属性测试据此生成名称。 */
export const BASELINE_NAME_PATTERN = /^px-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 平台标识的格式：非空，只含小写字母与数字，因而不含 `-`。
 * 覆盖 `process.platform` 的全部取值（`win32`、`linux`、`darwin` 等）。
 * 名称与平台之间以最后一个 `-` 分隔，平台不含 `-` 是文件名可逆的前提（设计 Property 5）。
 */
export const PLATFORM_PATTERN = /^[a-z0-9]+$/;

/** `pathTemplate` 的 `{ext}`：`toHaveScreenshot(`${name}.png`)` 取得的扩展名，含前导点。 */
export const BASELINE_EXT = ".png";

/**
 * 解析用：名称组贪婪匹配，但平台组不含 `-`，因此回溯后名称组止于最后一个 `-` 之前，
 * 分法唯一。
 */
const BASELINE_FILE_PATTERN = /^(px-[a-z0-9]+(?:-[a-z0-9]+)*)-([a-z0-9]+)\.png$/;

/** `parseBaselineFile` 的结果。 */
export interface ParsedBaselineFile {
  name: BaselineName;
  platform: string;
}

/**
 * 基线文件名（不含目录）：`<name>-<platform>.png`，与 `pathTemplate` 的
 * `{arg}-{platform}{ext}` 等价。本机调用 `baselineFile("px-shelf-desktop", process.platform)`
 * 得到 `px-shelf-desktop-win32.png`。
 *
 * 名称不符合 `BASELINE_NAME_PATTERN` 或平台不符合 `PLATFORM_PATTERN` 时抛 `RangeError`：
 * 这类输入生成的文件名无法唯一解析回原值，宁可在定义处报错。
 */
export function baselineFile(name: string, platform: string): string {
  if (!BASELINE_NAME_PATTERN.test(name)) {
    throw new RangeError(
      `Pixel_Baseline 名称不合法：${JSON.stringify(name)}，须匹配 ${BASELINE_NAME_PATTERN.source}`,
    );
  }
  if (!PLATFORM_PATTERN.test(platform)) {
    throw new RangeError(
      `平台标识不合法：${JSON.stringify(platform)}，须匹配 ${PLATFORM_PATTERN.source}`,
    );
  }
  return `${name}-${platform}${BASELINE_EXT}`;
}

/**
 * 基线文件相对仓库根的路径：`${VISUAL.baselineDir}/<baselineFile(name, platform)>`，
 * 以 `/` 分隔，与 `pathTemplate` 的写法一致。12.6 的报错信息与缺失检查用它。
 */
export function baselinePath(name: string, platform: string): string {
  return `${VISUAL.baselineDir}/${baselineFile(name, platform)}`;
}

/**
 * 把基线目录中的文件名（不含目录）解析回名称与平台；不是 `baselineFile` 可能产生的
 * 文件名时返回 `null`，从不抛错。目录核对据此把无法识别的文件报为多余文件。
 *
 * 对任意合法的 (n, p)，`parseBaselineFile(baselineFile(n, p))` 等于 `{ name: n, platform: p }`，
 * 因而 `baselineFile` 是单射（设计 Property 5）。
 */
export function parseBaselineFile(fileName: string): ParsedBaselineFile | null {
  if (typeof fileName !== "string") return null;
  const m = BASELINE_FILE_PATTERN.exec(fileName);
  if (m === null) return null;
  return { name: m[1] as BaselineName, platform: m[2] };
}

// ---------------------------------------------------------------------------
// 遮罩面积（12.3）
// ---------------------------------------------------------------------------

/**
 * 一个遮罩元素的边框，单位 CSS 像素，原点在视口左上角。
 * 与 Playwright `locator.boundingBox()` 的返回值同形（该方法返回 `null` 时由调用方处理）。
 */
export interface MaskBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 视口尺寸，与 `page.viewportSize()` 及 `VIEWPORTS` 的元素同形。 */
export interface ViewportSize {
  width: number;
  height: number;
}

/** 框在一个轴上落入 [0, limit) 的长度；负宽高视为空框。 */
function clippedLength(start: number, size: number, limit: number): number {
  const lo = Math.max(start, 0);
  const hi = Math.min(start + Math.max(size, 0), limit);
  return Math.max(hi - lo, 0);
}

/**
 * 遮罩合计面积占截图（即视口，12.9）面积的比例：各框裁剪到视口后的面积之和除以
 * `width × height`（设计 Property 6）。
 *
 * - 框可越出视口，越出部分不计；完全在视口外的框计 0；宽或高为负的框视为空框。
 * - 重叠部分按框分别计入，不取并集，所以结果可能大于 1。这与 12.3 的"遮罩合计面积"一致，
 *   也只会让超限判定偏严。
 * - 整数框的结果等于逐像素栅格计数（每个框覆盖的视口内像素数之和）除以 `width × height`；
 *   `boundingBox()` 给出的小数框按连续面积计。
 *
 * 视口宽高须为正的有限数，框的各字段须为有限数，否则抛 `RangeError`：`NaN` 参与比较
 * 恒为 `false`，若放过会让超限判定静默通过。
 */
export function maskAreaRatio(boxes: readonly MaskBox[], viewport: ViewportSize): number {
  const { width: vw, height: vh } = viewport;
  if (!(Number.isFinite(vw) && vw > 0 && Number.isFinite(vh) && vh > 0)) {
    throw new RangeError(`视口尺寸不合法：${vw}×${vh}，宽高须为正的有限数`);
  }

  let area = 0;
  boxes.forEach((box, i) => {
    const { x, y, width, height } = box;
    if (![x, y, width, height].every(Number.isFinite)) {
      throw new RangeError(`第 ${i} 个遮罩框含非有限值：${JSON.stringify(box)}`);
    }
    area += clippedLength(x, width, vw) * clippedLength(y, height, vh);
  });
  return area / (vw * vh);
}

/**
 * 遮罩面积比是否超出 12.3 的上限：当且仅当 `ratio > VISUAL.maxMaskRatio`（等于上限不算超限）。
 * `visual.spec.ts` 以 `maskAreaOverLimit(maskAreaRatio(boxes, viewport))` 判定并使用例失败。
 */
export function maskAreaOverLimit(ratio: number): boolean {
  return ratio > VISUAL.maxMaskRatio;
}

// ---------------------------------------------------------------------------
// 用例标题（visual.spec.ts ↔ Run_Summary 的"视觉回归"一节）
// ---------------------------------------------------------------------------

/** 用例标题中基线名之前的前缀。 */
const VISUAL_TITLE_PREFIX = "12.2 ";

/** 用例标题中基线名与说明之间的分隔符（全角冒号）。 */
const VISUAL_TITLE_SEPARATOR = "：";

const VISUAL_TITLE_PATTERN = /^12\.2 (px-[a-z0-9]+(?:-[a-z0-9]+)*)：/;

/**
 * `visual.spec.ts` 的用例标题：`12.2 <基线名>：<说明>`，如
 * `12.2 px-reader-dark：桌面 1280×800，主题 dark`。reporter 以 `baselineNameOfTitle` 取回基线名。
 */
export function visualTestTitle(name: BaselineName, detail: string): string {
  return `${VISUAL_TITLE_PREFIX}${name}${VISUAL_TITLE_SEPARATOR}${detail}`;
}

/** 从 `visualTestTitle` 产生的标题取回基线名；标题不是这种形式时为 null。 */
export function baselineNameOfTitle(title: string): BaselineName | null {
  const m = VISUAL_TITLE_PATTERN.exec(title);
  return m === null ? null : (m[1] as BaselineName);
}

// ---------------------------------------------------------------------------
// 缺失基线（12.6）
// ---------------------------------------------------------------------------

/** 基线更新命令原文（12.6 的失败信息给出它；即 `package.json` 的 `e2e:update` 入口）。 */
export const UPDATE_COMMAND = "npm run e2e:update";

/**
 * 非更新运行中基线文件不存在时 `visual.spec.ts` 第 6 步抛出的信息（12.6）：
 * `缺少 Pixel_Baseline e2e/baselines/<file>；运行 npm run e2e:update`。
 */
export function missingBaselineMessage(relativePath: string): string {
  return `缺少 Pixel_Baseline ${relativePath}；运行 ${UPDATE_COMMAND}`;
}

/** `parseMissingBaseline` 的结果：信息中的基线路径与更新命令。 */
export interface MissingBaseline {
  file: string;
  command: string;
}

const MISSING_BASELINE_PATTERN = /缺少 Pixel_Baseline ([^\s；]+)；运行 ([^\r\n]+)/;

/** 从报错中找出 `missingBaselineMessage` 产生的信息；没有时为 null。 */
export function parseMissingBaseline(message: string): MissingBaseline | null {
  const m = MISSING_BASELINE_PATTERN.exec(stripAnsi(message));
  return m === null ? null : { file: m[1], command: m[2].trim() };
}

// ---------------------------------------------------------------------------
// toHaveScreenshot 的报错（12.5）
// ---------------------------------------------------------------------------

/** 图像宽高（像素）。 */
export type ImageSize = ViewportSize;

/** Playwright 报告的差异像素数，以及它给出的占比（见 `parseScreenshotFailure`）。 */
export interface PixelDiff {
  count: number;
  /**
   * Playwright 原文中的 `ratio`：差异像素数 ÷ 比对尺寸的像素数，**向上**取整到两位小数。比对尺寸在
   * 两图尺寸相同时即基线宽高，不同时为两图补齐后的宽高（见 `parseScreenshotFailure`）。
   */
  ratio: number;
}

/**
 * `parseScreenshotFailure` 的结果：
 *
 * - `pixels`：尺寸相同，差异像素超出容差。
 * - `size`：尺寸不同；`pixels` 为同一条报错中的差异像素（Playwright 把两图补齐到较大的宽高后逐像素
 *   比对，未超出容差时不报告，此时为 null）。
 * - `unknown`：两种句式都没有出现（如"Failed to take two consecutive stable screenshots."、超时）；
 *   `detail` 为报错正文中第一条有内容的行，没有时为 null。
 */
export type ScreenshotFailure =
  | ({ kind: "pixels" } & PixelDiff)
  | { kind: "size"; expected: ImageSize; actual: ImageSize; pixels: PixelDiff | null }
  | { kind: "unknown"; detail: string | null };

const ANSI_CSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

/** `compareImages` 的尺寸句（见 `parseScreenshotFailure`）。 */
const SIZE_MISMATCH_PATTERN = /Expected an image (\d+)px by (\d+)px, received (\d+)px by (\d+)px\./;

/** `compareImages` 的像素句（见 `parseScreenshotFailure`）。 */
const PIXELS_MISMATCH_PATTERN = /(\d+) pixels \(ratio (\d+(?:\.\d+)?) of all image pixels\) are different\./;

/** `Call log:` 一行：其后是比对过程的日志，其中也可能有像素句（连拍两张之间的比对）。 */
const CALL_LOG_LINE = /^[ \t]*Call log:[ \t]*$/m;

/** 报错首行 `expect(page).toHaveScreenshot(expected) failed` 与头部的 `Locator:` / `Timeout:` 等标注行。 */
const NON_DETAIL_LINE = /^(?:(?:Error: )?expect\(.*\)\S*\.toHaveScreenshot\(.*\) failed$|(?:Locator|Timeout|Snapshot):)/;

/**
 * 从 `toHaveScreenshot` 的报错（`TestError.message`，可含 ANSI 转义）取差异像素数与占比，尺寸不符时
 * 取两组宽高（12.5）。纯函数，从不抛错。
 *
 * 报错格式录自锁定版本 `@playwright/test` 1.62.1 的源码：
 *
 * - 句子由 `node_modules/playwright-core/lib/coreBundle.js` 的 `compareImages` 生成：
 *   尺寸不同时先有 `Expected an image ${expected.width}px by ${expected.height}px, received
 *   ${actual.width}px by ${actual.height}px. `，随后两图被补齐到较大的宽与较大的高再逐像素比对；
 *   差异像素数超过 `maxDiffPixels`（此处为比对宽 × 高 × `maxDiffPixelRatio`）时接 `${count} pixels
 *   (ratio ${ratio.toFixed(2)} of all image pixels) are different.`，其中
 *   `ratio = Math.ceil(count / (比对宽 × 高) * 100) / 100`。比对宽高在尺寸相同时即基线宽高，尺寸不同时
 *   是补齐后的宽高，不是基线宽高（录取的样例：基线 1280×800、实际 1280×810、20600 个差异像素，
 *   原文 ratio 为 0.02，按基线面积算应为 0.03）。两句同在一行，尺寸句在前；尺寸句末尾的空格在
 *   像素句缺席时保留。
 * - 整条报错由 `node_modules/playwright/lib/matchers/expect.js` 的 `SnapshotHelper.handleDifferent`
 *   拼成：`formatMatcherMessage` 的头部（`expect(page).toHaveScreenshot(expected) failed`、空行，
 *   超时时另有 `Timeout: <n>ms`），缩进两格的上述句子，空行与 `  Snapshot: <name>.png`，最后是
 *   `Call log:` 与比对日志。
 *
 * 只在 `Call log:` 之前的部分查找：日志里记着稳定截图时相邻两张的比对结果（同样是像素句），
 * 不是与基线的比对。
 *
 * 注意 `ratio` 向上取整到两位小数，差异像素只要不为 0 就至少是 0.01（1%），远粗于 12.4 的 0.1%
 * 上限；精确占比须以 `count` 除以比对尺寸的像素数计算（`visual/report.ts`）。
 */
export function parseScreenshotFailure(message: string): ScreenshotFailure {
  const text = stripAnsi(String(message)).replace(/\r\n?/g, "\n");
  const head = text.split(CALL_LOG_LINE)[0];

  const px = PIXELS_MISMATCH_PATTERN.exec(head);
  const pixels: PixelDiff | null = px === null ? null : { count: Number(px[1]), ratio: Number(px[2]) };

  const size = SIZE_MISMATCH_PATTERN.exec(head);
  if (size !== null) {
    return {
      kind: "size",
      expected: { width: Number(size[1]), height: Number(size[2]) },
      actual: { width: Number(size[3]), height: Number(size[4]) },
      pixels,
    };
  }
  if (pixels !== null) return { kind: "pixels", ...pixels };

  const detail = head
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !NON_DETAIL_LINE.test(line));
  return { kind: "unknown", detail: detail ?? null };
}
