/**
 * 阅读器：排版设置（需求 10.7、10.8；风险 R6；reader-defect-fixes 需求 5.1、5.3、6.1、6.3、6.4、14.3）。
 * `fixture` 项目（:4611，Opaque_Mode），桌面视口，默认主题（不 `seedTheme`），不装 Controlled_Clock
 * （不涉及时长）。
 *
 * ## 用书
 *
 * `lib.role("volumes")`，不带 `?ch=` 打开（首个正文章节）。期望值不依赖书的内容，只要该章有正文段落。
 *
 * ## 用例划分（设计"补充场景"10.7 / 10.8；16.7；reader-defect-fixes 需求 14.3）
 *
 * 设置抽屉的 5 个滑杆都按可访问名称定位（`settingsDrawer(page)` 的 `*Slider`）：字号、行高、版心宽度
 * 三个的说明文字是关联的 `<label>`（reader-defect-fixes 需求 6.1），字间距与缓存上限带 `aria-label`。
 * 滑杆是 `INPUT`，聚焦后按方向键由滑杆自己处理，阅读器快捷键不接管。
 *
 * - 用例 A（普通断言）：字号经"A+"点击 2 次、字间距经 `getByLabel("字间距")` 聚焦后按 `ArrowRight`
 *   3 次、字体依次点击三个选项并停在初始选项以外的最后一个；断言 10.7 的 font-size、letter-spacing、
 *   三个 font-family 两两不同，重载后断言这三项计算样式、两个显示值与选中项不变（10.8）。
 * - 用例 B（行高、版心宽度）："行高间距"滑杆按 `ArrowRight` 5 次、"内容版心宽度"滑杆按 `ArrowRight`
 *   3 次（区间与步长取自滑杆的 `min`、`max`、`step` 属性，目标值须与初始值不同且不在端点）；断言 10.7
 *   的段落 line-height 与"字号 × 抽屉显示的行高倍数"相差 ≤ 0.5 px、版心容器的计算 `max-width` 等于
 *   抽屉显示的版心宽度，重载后断言这两项计算样式与两个显示值不变（10.8）。历史：EV 验收时这两个滑杆
 *   没有可访问名称（旁边的文字是 `<span>`），按 role 名称与 label 都定位不到，本用例只核对了定位缺口
 *   并以 `[16.4 F-003]` 跳过（Findings_Log F-003，已修复（reader-defect-fixes））。
 * - 10.7 的行高一项（原 F-004 预期失败，已修复（reader-defect-fixes））：修复前正文 `<p>` 带
 *   `leading-relaxed`（`line-height: 1.625`），覆盖了 `<article>` 上按设置写入的行高；现在段落继承
 *   `<article>` 的行高。用例写于行高滑杆尚无可访问名称时，沿用当时的做法：字号经"A+"调整，行高倍数
 *   保持初始显示值，核对段落行高与"字号 × 抽屉显示的行高倍数"相差 ≤ 0.5 px。与其余断言无关，单列一个
 *   用例（16.7）。
 * - RDF 5.1：字号 {14, 19, 36} × 行高 {1.4, 1.85, 2.1, 2.5}，每个字号一个用例。各组合在重载前写入
 *   localStorage 的设置键（只改 `fontSize`、`lineHeight`，其余字段原样保留），重载后先核对设置抽屉
 *   显示的正是 (f, h)，再断言每个正文段落的计算 `line-height` 与 f × h px 相差 ≤ 0.5 px。经抽屉控件
 *   调整的路径由 10.7 / 10.8 与 RDF 5.3 覆盖。
 * - RDF 5.3：经"行高间距"滑杆（按可访问名称定位，需求 6.1）依次按 `End`、`Home`、`ArrowRight` ×14，
 *   把行高调到 2.5、1.4、2.1；每次等正文段落的行高变为"字号 × 新行高"（说明改动已生效）后，断言
 *   `<h1>` 与"第 N / M 章"的计算 `line-height` 与调整前完全相同。
 * - RDF 6.1 / 6.3：字号、行高、版心宽度三个滑杆的可访问名称等于其 `<label>` 的可见文字"字号大小"
 *   "行高间距""内容版心宽度"；每个名称下 `getByRole("slider", { name, exact: true })` 与
 *   `getByLabel(name, { exact: true })` 各匹配恰好 1 个元素，且是同一个滑杆。版心宽度滑杆的 `min`、
 *   `max`、`step` 为 600、1200、20。
 * - RDF 6.4：全新上下文（每个用例的默认上下文，不 `seedTheme`）打开设置抽屉，5 个滑杆的 `value`
 *   换算为数值后等于旁边显示的数值，也等于生效值：字号、字间距取正文段落的计算 `font-size`、
 *   `letter-spacing`；行高取计算 `line-height` ÷ 计算 `font-size`（容差 0.01）；版心宽度取 `<article>`
 *   的计算 `max-width`；缓存上限取设置键中的 `cacheMaxBooks`，未存储时取默认值 10（EV 需求 4.2）。
 *
 * ## 读数怎么取（只读度量）
 *
 * - 正文段落：`reader(page).paragraphs`（`<article>` 内的 `<p>`），各项计算样式按全部段落去重，应恰为
 *   一个值。
 * - 版心容器：自首个正文段落向上找第一个计算 `max-width` 不为 `none` 的祖先（当前为 `<article>`，
 *   其内联样式写 `maxWidth: <contentWidth>px`），并核对它包含全部正文段落。只在注解里记录。
 * - 显示值：`settingsDrawer(page)` 的 `fontSizeValue` 等（整段文本，strict 匹配，多于 1 个即报错）。
 * - 选中的字体选项：三个字体按钮中计算 `background-color` 不是透明色的唯一一个（选中项带
 *   `bg-blue-500/10`，其余没有背景类）。设计原写以 `font-weight` 判定，但实测三个按钮的字重都是 500：
 *   选中项的 class 同时有 `font-medium` 与 `font-bold`，样式表中 `.font-medium` 排在后面，胜出。
 *   按钮带 `transition-all`，切换后约 150 ms 内新旧两项的背景都不透明，等到恰好一项不透明再判定。
 * - `<article>` 带 `transition-all duration-150`，字号与字间距改变后约 150 ms 内段落读到的是过渡中间值，
 *   比较一律用 `expect.poll` 等到相等（等待只依据可观测条件，6.5）。
 *
 * 读数（初始显示值、各字体选项的 font-family、调整后与重载后的计算样式、版心容器）记在注解
 * `typography-initial`、`typography-fonts`、`typography-reading` 里；RDF 5.1 各组合的段落行高记在
 * `rdf-line-height`，RDF 5.3 每次调整前后的标题区计算样式记在 `rdf-title-area`；RDF 6.1 的名称与属性
 * 记在 `rdf-slider-names`，RDF 6.4 的三方读数记在 `rdf-slider-values`。
 */
import type { Locator, Page } from "@playwright/test";
import { READER_SETTINGS_KEY, expect, test, type BookLog, type Lib } from "../../support/fixtures";
import {
  FONT_BUTTON_NAMES,
  NAMES,
  normalizeWhiteSpace,
  reader,
  settingsDrawer,
  type FontKey,
} from "../../support/locators";
import { bookUnderTest, openReader, type BookUnderTest } from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 字号的取值区间（`SettingDrawer` 的字号滑杆 `min` / `max`，"A-""A+"按钮同样夹在其中）。用例 A 经
 * "A+"调整字号，前置核对用这里的字面量；滑杆本身的属性由 RDF 6.4 一并读出。
 */
const FONT_MIN_PX = 14;
const FONT_MAX_PX = 36;

/** 用例 A：点击"A+"的次数（步长 1 px）。 */
const FONT_CLICKS = 2;

/** 用例 A：字间距滑杆上按 `ArrowRight` 的次数（每次一个 `step`）。 */
const LETTER_SPACING_PRESSES = 3;

/** 用例 B：行高滑杆上按 `ArrowRight` 的次数（默认 1.85 起，步长 0.05 → 2.1）。 */
const LINE_HEIGHT_PRESSES = 5;

/** 用例 B：版心宽度滑杆上按 `ArrowRight` 的次数（默认 820 起，步长 20 → 880）。 */
const CONTENT_WIDTH_PRESSES = 3;

/** 10.7、RDF 5.1：段落 `line-height` 与"字号 × 行高倍数"的容差。 */
const LINE_HEIGHT_TOLERANCE_PX = 0.5;

/** RDF 6.4：行高的生效值（计算 `line-height` ÷ 计算 `font-size`）与滑杆值的容差。 */
const LINE_HEIGHT_RATIO_TOLERANCE = 0.01;

/** RDF 6.4：缓存上限未存储时的默认值（EV 需求 4.2）。 */
const DEFAULT_CACHE_MAX_BOOKS = 10;

/** RDF 6.3：版心宽度滑杆的 `min`、`max`、`step`（D4）。 */
const CONTENT_WIDTH_RANGE = { min: "600", max: "1200", step: "20" } as const;

/** 三个字体选项，按设置抽屉的呈现顺序。 */
const FONT_KEYS = Object.keys(FONT_BUTTON_NAMES) as FontKey[];

/** `expect.poll` 比较结果为相等时的取值。 */
const MATCH = "相等";

// ---------------------------------------------------------------------------
// 读数
// ---------------------------------------------------------------------------

/** 设置抽屉显示的四个数值。 */
interface DrawerValues {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  contentWidth: number;
}

async function readDisplay(text: Promise<string | null>, pattern: RegExp, what: string): Promise<number> {
  const raw = ((await text) ?? "").trim();
  const match = pattern.exec(raw);
  if (match === null) throw new Error(`无法解析${what}显示值 ${JSON.stringify(raw)}`);
  return Number(match[1]);
}

/** 读设置抽屉显示的字号、行高倍数、字间距与版心宽度（各自的定位应恰好匹配 1 个元素）。 */
async function readDrawerValues(page: Page): Promise<DrawerValues> {
  const d = settingsDrawer(page);
  return {
    fontSize: await readDisplay(d.fontSizeValue.textContent(), /^(\d+)px$/, "字号"),
    lineHeight: await readDisplay(d.lineHeightValue.textContent(), /^(\d(?:\.\d+)?)x$/, "行高"),
    letterSpacing: await readDisplay(d.letterSpacingValue.textContent(), /^(\d(?:\.\d+)?)px$/, "字间距"),
    contentWidth: await readDisplay(d.contentWidthValue.textContent(), /^(\d{3,4})px$/, "版心宽度"),
  };
}

function describeValues(v: DrawerValues): string {
  return `字号 ${v.fontSize}px、行高 ${v.lineHeight}x、字间距 ${v.letterSpacing}px、版心 ${v.contentWidth}px`;
}

/** Chromium 对完全透明背景的计算值序列化。 */
const TRANSPARENT = "rgba(0, 0, 0, 0)";

/** 三个字体按钮的计算 `background-color`（度量）。 */
async function readFontBackgrounds(page: Page): Promise<Record<FontKey, string>> {
  const d = settingsDrawer(page);
  const backgrounds = {} as Record<FontKey, string>;
  for (const key of FONT_KEYS) {
    backgrounds[key] = await d.fontFamily(key).evaluate((el) => getComputedStyle(el).backgroundColor);
  }
  return backgrounds;
}

/** 选中的字体选项：恰好一个按钮的背景不透明（过渡已结束）；判定不出时为 null。 */
function selectedFontOf(backgrounds: Record<FontKey, string>): FontKey | null {
  const filled = FONT_KEYS.filter((k) => backgrounds[k].replace(/\s+/g, " ").trim() !== TRANSPARENT);
  return filled.length === 1 ? filled[0] : null;
}

async function readSelectedFont(page: Page): Promise<FontKey | null> {
  return selectedFontOf(await readFontBackgrounds(page));
}

async function expectSelectedFont(page: Page, key: FontKey, message: string): Promise<void> {
  await expect.poll(() => readSelectedFont(page), { message }).toBe(key);
}

/** 正文段落与版心容器的一次计算样式读数（只读）。 */
interface TypographyReading {
  /** 正文段落数。 */
  paragraphs: number;
  /** 各项计算样式在全部正文段落中的不同取值。 */
  fontSize: string[];
  lineHeight: string[];
  letterSpacing: string[];
  fontFamily: string[];
  /** 版心容器：首个正文段落最近的、计算 `max-width` 不为 `none` 的祖先；没有时为 null。 */
  container: {
    tag: string;
    maxWidth: string;
    fontSize: string;
    lineHeight: string;
    /** 是否包含全部正文段落。 */
    containsAll: boolean;
  } | null;
}

function readTypography(page: Page): Promise<TypographyReading> {
  return reader(page).paragraphs.evaluateAll((ps) => {
    const styles = ps.map((p) => getComputedStyle(p));
    const distinct = (pick: (s: CSSStyleDeclaration) => string): string[] => [...new Set(styles.map(pick))];
    let container: TypographyReading["container"] = null;
    for (let el = ps[0]?.parentElement ?? null; el !== null; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.maxWidth !== "none") {
        const holder = el;
        container = {
          tag: holder.tagName.toLowerCase(),
          maxWidth: s.maxWidth,
          fontSize: s.fontSize,
          lineHeight: s.lineHeight,
          containsAll: ps.every((p) => holder.contains(p)),
        };
        break;
      }
    }
    return {
      paragraphs: ps.length,
      fontSize: distinct((s) => s.fontSize),
      lineHeight: distinct((s) => s.lineHeight),
      letterSpacing: distinct((s) => s.letterSpacing),
      fontFamily: distinct((s) => s.fontFamily),
      container,
    };
  });
}

function describeReading(r: TypographyReading): string {
  const c = r.container;
  return (
    `${r.paragraphs} 段；font-size [${r.fontSize.join(" | ")}]；line-height [${r.lineHeight.join(" | ")}]；` +
    `letter-spacing [${r.letterSpacing.join(" | ")}]；font-family [${r.fontFamily.join(" | ")}]；版心容器 ` +
    (c === null
      ? "（无计算 max-width 不为 none 的祖先）"
      : `<${c.tag}> max-width ${c.maxWidth}、font-size ${c.fontSize}、line-height ${c.lineHeight}` +
        `${c.containsAll ? "" : "（未包含全部正文段落）"}`)
  );
}

/** `"21px"` → 21；不是 px 长度时为 NaN。 */
function px(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match === null ? Number.NaN : Number(match[1]);
}

/** 用例 A 对正文段落的期望。 */
interface CaseAWant {
  fontSizePx: number;
  letterSpacingPx: number;
  fontFamily: string;
}

/** 正文段落计算样式与期望的比较结论：相等时为 `MATCH`，否则为可读的说明。 */
function caseAVerdict(r: TypographyReading, want: CaseAWant): string {
  if (r.paragraphs === 0) return "<article> 内没有正文段落";
  const problems: string[] = [];
  const one = (values: string[], what: string): string | null => {
    if (values.length === 1) return values[0];
    problems.push(`${what} 在各段落中不一致：[${values.join(" | ")}]`);
    return null;
  };
  const fontSize = one(r.fontSize, "font-size");
  const letterSpacing = one(r.letterSpacing, "letter-spacing");
  const fontFamily = one(r.fontFamily, "font-family");
  if (fontSize !== null && px(fontSize) !== want.fontSizePx) {
    problems.push(`font-size ${fontSize} ≠ ${want.fontSizePx}px`);
  }
  if (letterSpacing !== null && px(letterSpacing) !== want.letterSpacingPx) {
    problems.push(`letter-spacing ${letterSpacing} ≠ ${want.letterSpacingPx}px`);
  }
  if (fontFamily !== null && fontFamily !== want.fontFamily) {
    problems.push(`font-family「${fontFamily}」≠「${want.fontFamily}」`);
  }
  return problems.length === 0 ? MATCH : problems.join("；");
}

/** 等到正文段落计算样式满足 `want`，返回此时的读数。 */
async function expectCaseA(page: Page, want: CaseAWant, message: string): Promise<TypographyReading> {
  await expect.poll(async () => caseAVerdict(await readTypography(page), want), { message }).toBe(MATCH);
  const reading = await readTypography(page);
  // 过渡结束后不再变化，按同一结论复读一次
  expect(caseAVerdict(reading, want), `${message}（复读）`).toBe(MATCH);
  return reading;
}

function annotate(type: string, description: string): void {
  test.info().annotations.push({ type, description });
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function openTypographyBook(page: Page, lib: Lib, bookLog: BookLog): Promise<BookUnderTest> {
  const book = await bookUnderTest(lib, lib.role("volumes"));
  await openReader(page, bookLog, book);
  await step("前提：正文章节有正文段落", async () => {
    await expect(reader(page).paragraphs.first()).toBeVisible();
  });
  return book;
}

/** 点顶栏"阅读设置 (快捷键: S)"打开设置抽屉，等标题与四个显示值出现。 */
async function openSettingsDrawer(page: Page): Promise<void> {
  const d = settingsDrawer(page);
  await step("点击顶栏“阅读设置”打开设置抽屉", async () => {
    await reader(page).settingsButton.click();
    await expect(d.marker).toBeVisible();
    await expect(d.fontSizeValue).toBeVisible();
    await expect(d.lineHeightValue).toBeVisible();
    await expect(d.letterSpacingValue).toBeVisible();
    await expect(d.contentWidthValue).toBeVisible();
  });
}

/** 初始显示值与选中的字体选项。 */
interface InitialState {
  values: DrawerValues;
  font: FontKey;
}

async function readInitialState(page: Page): Promise<InitialState> {
  return step("读设置抽屉的初始显示值与选中的字体选项", async () => {
    const values = await readDrawerValues(page);
    await expect
      .poll(() => readSelectedFont(page), { message: "初始选中的字体选项应可判定（恰好一个按钮背景不透明）" })
      .not.toBeNull();
    const backgrounds = await readFontBackgrounds(page);
    const font = selectedFontOf(backgrounds);
    if (font === null) {
      throw new Error(`初始选中的字体选项在复读时判定不出：${JSON.stringify(backgrounds)}`);
    }
    annotate(
      "typography-initial",
      `${describeValues(values)}；字体 ${font}（${FONT_BUTTON_NAMES[font]}）；` +
        `字体按钮背景 ${FONT_KEYS.map((k) => `${k}: ${backgrounds[k]}`).join("、")}`,
    );
    return { values, font };
  });
}

/** 点击"A+" `FONT_CLICKS` 次；目标字号须与初始值不同且不在区间端点。返回目标字号。 */
async function increaseFontSize(page: Page, initial: number): Promise<number> {
  const target = initial + FONT_CLICKS;
  await step(`前提：字号 ${initial}px → ${target}px 不在区间端点 ${FONT_MIN_PX}/${FONT_MAX_PX}px`, async () => {
    expect(target, "目标字号应大于下端点").toBeGreaterThan(FONT_MIN_PX);
    expect(target, "目标字号应小于上端点").toBeLessThan(FONT_MAX_PX);
  });
  const d = settingsDrawer(page);
  await step(`点击“A+” ${FONT_CLICKS} 次：显示值 ${initial}px → ${target}px`, async () => {
    for (let i = 1; i <= FONT_CLICKS; i++) {
      await d.fontIncrease.click();
      await expect(d.fontSizeValue).toHaveText(`${initial + i}px`);
    }
  });
  return target;
}

/** 设置抽屉里一个可按名称定位的滑杆，连同旁边的显示值。 */
interface SliderControl {
  /** 设置项的称呼（用于步骤名与消息）。 */
  what: string;
  slider: Locator;
  /** 旁边的显示值。 */
  value: Locator;
  /** 数值 → 显示值的原文（如 `2.1` → `"2.1x"`）。 */
  format: (n: number) => string;
}

function letterSpacingControl(page: Page): SliderControl {
  const d = settingsDrawer(page);
  return { what: "字间距", slider: d.letterSpacingSlider, value: d.letterSpacingValue, format: (n) => `${n}px` };
}

function lineHeightControl(page: Page): SliderControl {
  const d = settingsDrawer(page);
  return { what: "行高", slider: d.lineHeightSlider, value: d.lineHeightValue, format: (n) => `${n}x` };
}

function contentWidthControl(page: Page): SliderControl {
  const d = settingsDrawer(page);
  return { what: "版心宽度", slider: d.contentWidthSlider, value: d.contentWidthValue, format: (n) => `${n}px` };
}

/** 十进制字面量的小数位数（`0.05` → 2，`20` → 0）。 */
function decimalsOf(n: number): number {
  return (String(n).split(".")[1] ?? "").length;
}

/**
 * `initial + n × step`，按两者中较多的小数位数取整，消除浮点尾差（`1.85 + 5 × 0.05` 得到 `2.1`），
 * 与滑杆 `value` 的十进制写法一致。
 */
function stepped(initial: number, n: number, stepSize: number): number {
  return Number((initial + n * stepSize).toFixed(Math.max(decimalsOf(initial), decimalsOf(stepSize))));
}

/**
 * 滑杆聚焦后按 `ArrowRight` `presses` 次，每次等显示值变为下一个网格值；区间与步长取自滑杆的 `min`、
 * `max`、`step` 属性（度量）。目标值须与初始值不同且不在区间端点。返回目标值。
 */
async function pressSliderRight(control: SliderControl, initial: number, presses: number): Promise<number> {
  const { what, slider, format } = control;
  const range = await step(`读${what}滑杆的 min / max / step`, async () => {
    const read = async (name: string): Promise<number> => {
      const value = Number(await slider.getAttribute(name));
      expect(Number.isFinite(value), `${what}滑杆的 ${name} 应为数字`).toBe(true);
      return value;
    };
    return { min: await read("min"), max: await read("max"), step: await read("step") };
  });
  const target = stepped(initial, presses, range.step);
  await step(
    `前提：${what} ${format(initial)} → ${format(target)} 不在区间端点 ${format(range.min)}/${format(range.max)}`,
    async () => {
      expect(target, `目标${what}应与初始值不同`).not.toBe(initial);
      expect(target, `目标${what}应大于下端点`).toBeGreaterThan(range.min);
      expect(target, `目标${what}应小于上端点`).toBeLessThan(range.max);
    },
  );
  await step(`${what}滑杆按 ArrowRight ${presses} 次：显示值 ${format(initial)} → ${format(target)}`, async () => {
    for (let i = 1; i <= presses; i++) {
      await slider.press("ArrowRight");
      await expect(control.value).toHaveText(format(stepped(initial, i, range.step)));
    }
  });
  return target;
}

/** 字间距滑杆按 `ArrowRight` `LETTER_SPACING_PRESSES` 次（用例 A）。返回目标值。 */
function increaseLetterSpacing(page: Page, initial: number): Promise<number> {
  return pressSliderRight(letterSpacingControl(page), initial, LETTER_SPACING_PRESSES);
}

/**
 * 依次点击三个字体选项（先点初始选项，最后停在其余选项中的最后一个），每次等选中项切换后记下正文段落的
 * 计算 `font-family`。返回各选项的 font-family 与最后选中的选项。
 */
async function selectEachFont(
  page: Page,
  initial: FontKey,
): Promise<{ families: Record<FontKey, string>; final: FontKey }> {
  const order = [initial, ...FONT_KEYS.filter((k) => k !== initial)];
  const families = {} as Record<FontKey, string>;
  const d = settingsDrawer(page);
  for (const key of order) {
    families[key] = await step(`点击字体选项“${FONT_BUTTON_NAMES[key]}”，记下正文段落的 font-family`, async () => {
      await d.fontFamily(key).click();
      await expectSelectedFont(page, key, `点击后选中项应为 ${key}（${FONT_BUTTON_NAMES[key]}）`);
      const r = await readTypography(page);
      expect(r.paragraphs, "正文段落数").toBeGreaterThan(0);
      expect(r.fontFamily, `选中 ${key} 时各段落的 font-family 应一致`).toHaveLength(1);
      return r.fontFamily[0];
    });
  }
  annotate(
    "typography-fonts",
    FONT_KEYS.map((k) => `${k}（${FONT_BUTTON_NAMES[k]}）: ${families[k]}`).join("；"),
  );
  return { families, final: order[order.length - 1] };
}

async function reloadReader(page: Page, bookLog: BookLog, book: BookUnderTest): Promise<void> {
  await step("重新加载页面，等正文加载完成", async () => {
    const since = bookLog.count;
    await page.reload();
    await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
    await expect(reader(page).chapterHeading).toBeVisible();
    await expect(reader(page).paragraphs.first()).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// 用例 A：字号、字间距与字体（10.7、10.8）
// ---------------------------------------------------------------------------

test("10.7 / 10.8 字号（A+ ×2）、字间距（ArrowRight ×3）与字体：正文段落计算样式等于抽屉显示值、三个字体两两不同，重载后计算样式、显示值与选中项不变", async ({
  page,
  lib,
  bookLog,
}) => {
  const book = await openTypographyBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  const initial = await readInitialState(page);

  const fontSize = await increaseFontSize(page, initial.values.fontSize);
  const letterSpacing = await increaseLetterSpacing(page, initial.values.letterSpacing);
  const { families, final } = await selectEachFont(page, initial.font);

  await step(`10.7 三个字体选项各自的计算 font-family 两两不同`, async () => {
    const pairs: string[] = [];
    for (let i = 0; i < FONT_KEYS.length; i++) {
      for (let j = i + 1; j < FONT_KEYS.length; j++) {
        const [a, b] = [FONT_KEYS[i], FONT_KEYS[j]];
        if (families[a] === families[b]) pairs.push(`${a} 与 ${b} 同为「${families[a]}」`);
      }
    }
    expect(pairs, "font-family 相同的选项对").toEqual([]);
  });

  const displayed = await step("读调整后设置抽屉的显示值", async () => {
    const values = await readDrawerValues(page);
    expect(values.fontSize, "字号显示值").toBe(fontSize);
    expect(values.letterSpacing, "字间距显示值").toBe(letterSpacing);
    return values;
  });

  const want: CaseAWant = {
    fontSizePx: displayed.fontSize,
    letterSpacingPx: displayed.letterSpacing,
    fontFamily: families[final],
  };
  const before = await step(
    `10.7 正文段落：font-size ${want.fontSizePx}px、letter-spacing ${want.letterSpacingPx}px、font-family 为“${FONT_BUTTON_NAMES[final]}”的取值`,
    () => expectCaseA(page, want, "10.7 正文段落的计算样式应等于设置抽屉的显示值"),
  );
  annotate("typography-reading", `调整后：${describeValues(displayed)}；字体 ${final}；${describeReading(before)}`);

  await reloadReader(page, bookLog, book);

  const after = await step("10.8 重载后正文段落的 font-size、letter-spacing、font-family 与重载前相同", async () => {
    const r = await expectCaseA(page, want, "10.8 重载后正文段落的计算样式应与重载前相同");
    expect(r.fontSize, "font-size 原文").toEqual(before.fontSize);
    expect(r.letterSpacing, "letter-spacing 原文").toEqual(before.letterSpacing);
    expect(r.fontFamily, "font-family 原文").toEqual(before.fontFamily);
    return r;
  });

  await openSettingsDrawer(page);
  const reloaded = await step("10.8 重载后设置抽屉显示的字号与字间距与重载前相同", async () => {
    const values = await readDrawerValues(page);
    expect(values.fontSize, "字号显示值").toBe(displayed.fontSize);
    expect(values.letterSpacing, "字间距显示值").toBe(displayed.letterSpacing);
    return values;
  });
  await step(`10.8 重载后选中的字体选项仍为“${FONT_BUTTON_NAMES[final]}”`, async () => {
    await expectSelectedFont(page, final, `10.8 重载后选中项应为 ${final}`);
  });
  annotate("typography-reading", `重载后：${describeValues(reloaded)}；${describeReading(after)}`);
});

// ---------------------------------------------------------------------------
// 用例 B：行高与版心宽度（10.7、10.8；原 [16.4 F-003] 跳过，已修复（reader-defect-fixes））
// ---------------------------------------------------------------------------

/** 用例 B 对正文段落与版心容器的期望。 */
interface CaseBWant {
  /** 段落 `line-height` 的期望值：字号 × 抽屉显示的行高倍数（px）。 */
  lineHeightPx: number;
  /** 版心容器计算 `max-width` 的期望原文：抽屉显示的版心宽度（如 `"880px"`）。 */
  maxWidth: string;
}

/** 正文段落行高与版心容器宽度和期望的比较结论：相符时为 `MATCH`，否则为可读的说明。 */
function caseBVerdict(r: TypographyReading, want: CaseBWant): string {
  if (r.paragraphs === 0) return "<article> 内没有正文段落";
  const problems: string[] = [];
  if (r.lineHeight.length !== 1) {
    problems.push(`line-height 在各段落中不一致：[${r.lineHeight.join(" | ")}]`);
  } else if (!(Math.abs(px(r.lineHeight[0]) - want.lineHeightPx) <= LINE_HEIGHT_TOLERANCE_PX)) {
    // 写成"不满足 ≤"，使解析不出 px 值（NaN）时也计入
    problems.push(
      `line-height ${r.lineHeight[0]} 与 ${want.lineHeightPx.toFixed(3)}px 相差超过 ${LINE_HEIGHT_TOLERANCE_PX}px`,
    );
  }
  const c = r.container;
  if (c === null) {
    problems.push("首个正文段落没有计算 max-width 不为 none 的祖先（版心容器）");
  } else {
    if (!c.containsAll) problems.push(`版心容器 <${c.tag}> 未包含全部正文段落`);
    if (c.maxWidth !== want.maxWidth) problems.push(`版心容器 <${c.tag}> max-width ${c.maxWidth} ≠ ${want.maxWidth}`);
  }
  return problems.length === 0 ? MATCH : problems.join("；");
}

/** 等到正文段落行高与版心容器宽度满足 `want`（`<article>` 的过渡结束），返回此时的读数。 */
async function expectCaseB(page: Page, want: CaseBWant, message: string): Promise<TypographyReading> {
  await expect.poll(async () => caseBVerdict(await readTypography(page), want), { message }).toBe(MATCH);
  const reading = await readTypography(page);
  expect(caseBVerdict(reading, want), `${message}（复读）`).toBe(MATCH);
  return reading;
}

test("10.7 / 10.8 行高（ArrowRight ×5）与版心宽度（ArrowRight ×3）：调到非端点的新值后段落 line-height 与「字号 × 行高倍数」相差 ≤ 0.5 px、版心容器 max-width 等于显示值，重载后计算样式与显示值不变", async ({
  page,
  lib,
  bookLog,
}) => {
  const book = await openTypographyBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  const initial = await readInitialState(page);

  const lineHeight = await pressSliderRight(lineHeightControl(page), initial.values.lineHeight, LINE_HEIGHT_PRESSES);
  const contentWidth = await pressSliderRight(
    contentWidthControl(page),
    initial.values.contentWidth,
    CONTENT_WIDTH_PRESSES,
  );

  const displayed = await step("读调整后设置抽屉的显示值", async () => {
    const values = await readDrawerValues(page);
    expect(values.lineHeight, "行高显示值").toBe(lineHeight);
    expect(values.contentWidth, "版心宽度显示值").toBe(contentWidth);
    expect(values.fontSize, "字号显示值（本用例不调整）").toBe(initial.values.fontSize);
    return values;
  });

  const want: CaseBWant = {
    lineHeightPx: displayed.fontSize * displayed.lineHeight,
    maxWidth: `${displayed.contentWidth}px`,
  };
  const before = await step(
    `10.7 正文段落 line-height 与 ${displayed.fontSize}px × ${displayed.lineHeight} = ${want.lineHeightPx.toFixed(3)}px ` +
      `相差 ≤ ${LINE_HEIGHT_TOLERANCE_PX}px；版心容器 max-width 为 ${want.maxWidth}`,
    () => expectCaseB(page, want, "10.7 正文段落的行高与版心容器的宽度应符合设置抽屉的显示值"),
  );
  annotate("typography-reading", `调整后：${describeValues(displayed)}；${describeReading(before)}`);

  await reloadReader(page, bookLog, book);

  const after = await step("10.8 重载后正文段落的 line-height 与版心容器的 max-width 与重载前相同", async () => {
    const r = await expectCaseB(page, want, "10.8 重载后正文段落的行高与版心容器的宽度应与重载前相同");
    expect(r.lineHeight, "line-height 原文").toEqual(before.lineHeight);
    expect(r.container?.maxWidth, "版心容器 max-width 原文").toBe(before.container?.maxWidth);
    return r;
  });

  await openSettingsDrawer(page);
  const reloaded = await step("10.8 重载后设置抽屉显示的行高与版心宽度与重载前相同", async () => {
    const values = await readDrawerValues(page);
    expect(values.lineHeight, "行高显示值").toBe(displayed.lineHeight);
    expect(values.contentWidth, "版心宽度显示值").toBe(displayed.contentWidth);
    return values;
  });
  annotate("typography-reading", `重载后：${describeValues(reloaded)}；${describeReading(after)}`);
});

// ---------------------------------------------------------------------------
// 10.7 的行高一项（原 F-004 预期失败，已修复（reader-defect-fixes））
// ---------------------------------------------------------------------------

test("10.7 字号经 A+ 调整后，正文段落的计算 line-height 与「字号 × 抽屉显示的行高倍数」相差 ≤ 0.5 px", async ({
  page,
  lib,
  bookLog,
}) => {
  await openTypographyBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  const initial = await readInitialState(page);
  // 行高倍数保持初始显示值，字号经 A+ 调整（用例写于行高滑杆尚无可访问名称时，见文件头）
  const fontSize = await increaseFontSize(page, initial.values.fontSize);

  const { values, reading } = await step(`等正文段落 font-size 为 ${fontSize}px，读显示值与计算样式`, async () => {
    await expect
      .poll(async () => (await readTypography(page)).fontSize, { message: "正文段落的 font-size" })
      .toEqual([`${fontSize}px`]);
    const r = await readTypography(page);
    const v = await readDrawerValues(page);
    annotate("typography-reading", `${describeValues(v)}；${describeReading(r)}`);
    return { values: v, reading: r };
  });

  const expected = values.fontSize * values.lineHeight;
  await step(
    `10.7 正文段落 line-height 与 ${values.fontSize}px × ${values.lineHeight} = ${expected.toFixed(3)}px 相差 ≤ ${LINE_HEIGHT_TOLERANCE_PX}px`,
    async () => {
      expect(reading.lineHeight, "各段落的 line-height 应一致").toHaveLength(1);
      const actual = px(reading.lineHeight[0]);
      expect(
        Math.abs(actual - expected),
        `段落 line-height ${reading.lineHeight[0]} 与 ${expected.toFixed(3)}px 之差（版心容器 line-height ${reading.container?.lineHeight ?? "未知"}）`,
      ).toBeLessThanOrEqual(LINE_HEIGHT_TOLERANCE_PX);
    },
  );
});

// ---------------------------------------------------------------------------
// RDF 5.1 / 5.3 的读数与操作
// ---------------------------------------------------------------------------

/** 一个元素的计算 `font-size` 与 `line-height`（原文）。 */
interface LineMetrics {
  fontSize: string;
  lineHeight: string;
}

/** 每个正文段落的计算 `font-size` 与 `line-height`，按文档顺序（只读）。 */
function readParagraphMetrics(page: Page): Promise<LineMetrics[]> {
  return reader(page).paragraphs.evaluateAll((ps) =>
    ps.map((p) => {
      const s = getComputedStyle(p);
      return { fontSize: s.fontSize, lineHeight: s.lineHeight };
    }),
  );
}

/** 违规段落在说明中最多列出的个数。 */
const OFFENDER_SAMPLE = 5;

/** 每个正文段落的计算 `line-height` 与 `expectedPx` 相差 ≤ 容差时为 `MATCH`，否则为可读的说明。 */
function lineHeightVerdict(ps: LineMetrics[], expectedPx: number): string {
  if (ps.length === 0) return "<article> 内没有正文段落";
  const offenders = ps
    .map((m, index) => ({ index, ...m }))
    // 写成"不满足 ≤"，使解析不出 px 值（NaN）的段落也计入违规
    .filter((m) => !(Math.abs(px(m.lineHeight) - expectedPx) <= LINE_HEIGHT_TOLERANCE_PX));
  if (offenders.length === 0) return MATCH;
  const sample = offenders
    .slice(0, OFFENDER_SAMPLE)
    .map((m) => `第 ${m.index} 段 line-height ${m.lineHeight}（font-size ${m.fontSize}）`)
    .join("；");
  return (
    `${ps.length} 段中有 ${offenders.length} 段与 ${expectedPx.toFixed(3)}px 相差超过 ${LINE_HEIGHT_TOLERANCE_PX}px：` +
    `${sample}${offenders.length > OFFENDER_SAMPLE ? "……" : ""}`
  );
}

/**
 * 等到每个正文段落的计算 `line-height` 与 `expectedPx` 相差 ≤ 容差（`<article>` 的过渡结束），复读一次
 * 核对同一结论，返回此时的读数。
 */
async function expectParagraphLineHeights(page: Page, expectedPx: number, message: string): Promise<LineMetrics[]> {
  await expect
    .poll(async () => lineHeightVerdict(await readParagraphMetrics(page), expectedPx), { message })
    .toBe(MATCH);
  const ps = await readParagraphMetrics(page);
  expect(lineHeightVerdict(ps, expectedPx), `${message}（复读）`).toBe(MATCH);
  return ps;
}

function distinctLineHeights(ps: LineMetrics[]): string {
  return [...new Set(ps.map((m) => m.lineHeight))].join(" | ");
}

/**
 * 把设置键中的字号与行高写为 (f, h)，其余字段原样保留（重载后由 `getStoredSettings()` 读出）。键不存在
 * 或不是 JSON 对象时只写这两项，其余按应用默认值补齐。
 */
async function writeStoredTypography(page: Page, f: number, h: number): Promise<void> {
  await page.evaluate(
    ({ key, fontSize, lineHeight }) => {
      let stored: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
        if (typeof parsed === "object" && parsed !== null) stored = parsed as Record<string, unknown>;
      } catch {
        // 不是 JSON：整键改写
      }
      window.localStorage.setItem(key, JSON.stringify({ ...stored, fontSize, lineHeight }));
    },
    { key: READER_SETTINGS_KEY, fontSize: f, lineHeight: h },
  );
}

/** 章节标题区：`<h1>` 与"第 N / M 章"的计算样式。 */
interface TitleAreaReading {
  heading: LineMetrics;
  position: LineMetrics;
}

function readLineMetrics(locator: Locator): Promise<LineMetrics> {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fontSize: s.fontSize, lineHeight: s.lineHeight };
  });
}

async function readTitleArea(page: Page): Promise<TitleAreaReading> {
  const view = reader(page);
  return { heading: await readLineMetrics(view.chapterHeading), position: await readLineMetrics(view.chapterPosition) };
}

function describeTitleArea(t: TitleAreaReading): string {
  return (
    `<h1> line-height ${t.heading.lineHeight}（font-size ${t.heading.fontSize}）、` +
    `“第 N / M 章” line-height ${t.position.lineHeight}（font-size ${t.position.fontSize}）`
  );
}

// ---------------------------------------------------------------------------
// RDF 5.1：字号 × 行高的全部组合下，正文段落行高为"字号 × 行高"
// ---------------------------------------------------------------------------

/** RDF 5.1 的字号（px）：下端点、默认值、上端点。 */
const RDF_FONT_SIZES = [14, 19, 36] as const;

/** RDF 5.1 的行高倍数：下端点、默认值、网格上的非端点值、上端点。 */
const RDF_LINE_HEIGHTS = [1.4, 1.85, 2.1, 2.5] as const;

for (const fontSize of RDF_FONT_SIZES) {
  test(`RDF 5.1 字号 ${fontSize}px × 行高 {${RDF_LINE_HEIGHTS.join(", ")}}：设置抽屉显示该组合时，每个正文段落的计算 line-height 与「字号 × 行高」相差 ≤ ${LINE_HEIGHT_TOLERANCE_PX} px`, async ({
    page,
    lib,
    bookLog,
  }) => {
    const book = await openTypographyBook(page, lib, bookLog);
    const readings: string[] = [];
    for (const lineHeight of RDF_LINE_HEIGHTS) {
      await step(`写入设置：字号 ${fontSize}px、行高 ${lineHeight}x（localStorage 设置键，重载后生效）`, () =>
        writeStoredTypography(page, fontSize, lineHeight),
      );
      await reloadReader(page, bookLog, book);
      await openSettingsDrawer(page);
      await step(`前提：设置抽屉显示字号 ${fontSize}px、行高 ${lineHeight}x`, async () => {
        const d = settingsDrawer(page);
        await expect(d.fontSizeValue).toHaveText(`${fontSize}px`);
        await expect(d.lineHeightValue).toHaveText(`${lineHeight}x`);
      });
      const expected = fontSize * lineHeight;
      const ps = await step(
        `5.1 每个正文段落的 line-height 与 ${fontSize}px × ${lineHeight} = ${expected.toFixed(3)}px 相差 ≤ ${LINE_HEIGHT_TOLERANCE_PX}px`,
        () => expectParagraphLineHeights(page, expected, `5.1 (${fontSize}px, ${lineHeight}x) 正文段落的计算 line-height`),
      );
      readings.push(
        `(${fontSize}px, ${lineHeight}x) 期望 ${expected.toFixed(3)}px：${ps.length} 段，line-height [${distinctLineHeights(ps)}]`,
      );
    }
    annotate("rdf-line-height", readings.join("；"));
  });
}

// ---------------------------------------------------------------------------
// RDF 5.3：行高改变时，章节标题区的行高不变
// ---------------------------------------------------------------------------

/**
 * RDF 5.3 在"行高间距"滑杆上的依次调整：按键、次数与调整后的行高倍数。默认行高 1.85 起，覆盖网格的两个
 * 端点与一个非端点值（1.4 + 14 × 0.05 = 2.1）。期望值写成字面量，不在测试里做浮点累加。
 */
const RDF_5_3_CHANGES: readonly { key: string; presses: number; lineHeight: number }[] = [
  { key: "End", presses: 1, lineHeight: 2.5 },
  { key: "Home", presses: 1, lineHeight: 1.4 },
  { key: "ArrowRight", presses: 14, lineHeight: 2.1 },
];

test("RDF 5.3 经“行高间距”滑杆把行高依次调到 2.5、1.4、2.1：正文段落行高随之改变，<h1> 与「第 N / M 章」的计算 line-height 保持调整前的值", async ({
  page,
  lib,
  bookLog,
}) => {
  await openTypographyBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  const initial = await readInitialState(page);
  const fontSize = initial.values.fontSize;
  const slider = settingsDrawer(page).lineHeightSlider;

  const before = await step(
    `读调整前的标题区计算样式，并确认正文段落行高为 ${fontSize}px × ${initial.values.lineHeight}`,
    async () => {
      await expect(slider, `getByRole("slider", { name: "${NAMES.lineHeight}" })`).toBeVisible();
      await expectParagraphLineHeights(
        page,
        fontSize * initial.values.lineHeight,
        "调整前正文段落的计算 line-height 应为「字号 × 初始行高」",
      );
      const t = await readTitleArea(page);
      annotate("rdf-title-area", `调整前（行高 ${initial.values.lineHeight}x）：${describeTitleArea(t)}`);
      return t;
    },
  );

  let previous = initial.values.lineHeight;
  for (const change of RDF_5_3_CHANGES) {
    const label = change.presses === 1 ? change.key : `${change.key} ×${change.presses}`;
    await step(`前提：行高 ${previous}x → ${change.lineHeight}x 是一次改变`, async () => {
      expect(change.lineHeight, "调整后的行高应与调整前不同").not.toBe(previous);
    });
    await step(`“行高间距”滑杆按 ${label}：显示值 ${previous}x → ${change.lineHeight}x`, async () => {
      for (let i = 0; i < change.presses; i++) await slider.press(change.key);
      await expect(settingsDrawer(page).lineHeightValue).toHaveText(`${change.lineHeight}x`);
    });
    const expected = fontSize * change.lineHeight;
    await step(`前提：正文段落的 line-height 已变为 ${fontSize}px × ${change.lineHeight} = ${expected.toFixed(3)}px`, () =>
      expectParagraphLineHeights(page, expected, `行高 ${change.lineHeight}x 时正文段落的计算 line-height`),
    );
    await step(`5.3 行高 ${change.lineHeight}x 时 <h1> 与“第 N / M 章”的计算 line-height 与调整前相同`, async () => {
      const after = await readTitleArea(page);
      annotate("rdf-title-area", `行高 ${change.lineHeight}x：${describeTitleArea(after)}`);
      expect(after.heading.lineHeight, "<h1> 的计算 line-height").toBe(before.heading.lineHeight);
      expect(after.position.lineHeight, "“第 N / M 章”的计算 line-height").toBe(before.position.lineHeight);
    });
    previous = change.lineHeight;
  }
});

// ---------------------------------------------------------------------------
// RDF 6.1 / 6.3：三个滑杆的可访问名称等于旁边的可见文字；版心宽度的取值网格
// ---------------------------------------------------------------------------

/** RDF 6.1 的三个滑杆：名称（即 `<label>` 的可见文字）与该文字的定位。 */
function namedSliders(page: Page): readonly { name: string; label: Locator }[] {
  const d = settingsDrawer(page);
  return [
    { name: NAMES.fontSize, label: d.fontSizeLabel },
    { name: NAMES.lineHeight, label: d.lineHeightLabel },
    { name: NAMES.contentWidth, label: d.contentWidthLabel },
  ];
}

test("RDF 6.1 / 6.3 字号、行高、版心宽度三个滑杆的可访问名称等于旁边的可见文字，按名称的 getByRole(\"slider\") 与 getByLabel 各恰好匹配 1 个且是同一滑杆；版心宽度滑杆 min 600、max 1200、step 20", async ({
  page,
  lib,
  bookLog,
}) => {
  await openTypographyBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  const readings: string[] = [];

  for (const { name, label } of namedSliders(page)) {
    const byRole = page.getByRole("slider", { name, exact: true });
    const byLabel = page.getByLabel(name, { exact: true });
    await step(`6.1 “${name}”：可见文字恰有 1 处，滑杆的可访问名称等于该文字`, async () => {
      await expect(label, `可见文字“${name}”`).toHaveCount(1);
      await expect(label, `可见文字“${name}”`).toBeVisible();
      const text = normalizeWhiteSpace((await label.textContent()) ?? "");
      expect(text, "可见文字（空白规整后）").toBe(name);
      await expect(byRole, `getByRole("slider", { name: "${name}", exact: true })`).toHaveCount(1);
      await expect(byRole, "滑杆的可访问名称应等于旁边的可见文字").toHaveAccessibleName(text);
    });
    await step(`6.1 “${name}”：getByLabel 恰好匹配 1 个元素，且与按 role 名称定位到的是同一个滑杆`, async () => {
      await expect(byLabel, `getByLabel("${name}", { exact: true })`).toHaveCount(1);
      await expect(byLabel, `getByLabel("${name}") 匹配的元素`).toHaveRole("slider");
      const [a, b] = await Promise.all([byRole.elementHandle(), byLabel.elementHandle()]);
      try {
        expect(await a.evaluate((x, y) => x === y, b), "两种定位应指向同一个元素").toBe(true);
      } finally {
        await Promise.all([a.dispose(), b.dispose()]);
      }
      readings.push((await byRole.ariaSnapshot()).trim());
    });
  }

  await step(
    `6.3 版心宽度滑杆的 min / max / step 为 ${CONTENT_WIDTH_RANGE.min} / ${CONTENT_WIDTH_RANGE.max} / ${CONTENT_WIDTH_RANGE.step}`,
    async () => {
      const slider = settingsDrawer(page).contentWidthSlider;
      const attrs = {
        min: await slider.getAttribute("min"),
        max: await slider.getAttribute("max"),
        step: await slider.getAttribute("step"),
      };
      readings.push(`版心宽度滑杆 min ${attrs.min}、max ${attrs.max}、step ${attrs.step}`);
      expect(attrs, "版心宽度滑杆的 min / max / step").toEqual({ ...CONTENT_WIDTH_RANGE });
    },
  );
  annotate("rdf-slider-names", readings.join("；"));
});

// ---------------------------------------------------------------------------
// RDF 6.4：全新上下文里，滑杆位置 = 显示值 = 生效值
// ---------------------------------------------------------------------------

type SliderSettingKey = "fontSize" | "lineHeight" | "letterSpacing" | "contentWidth" | "cacheMaxBooks";

const SLIDER_SETTING_KEYS: readonly SliderSettingKey[] = [
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "contentWidth",
  "cacheMaxBooks",
];

const SLIDER_SETTING_NAMES: Readonly<Record<SliderSettingKey, string>> = {
  fontSize: "字号",
  lineHeight: "行高",
  letterSpacing: "字间距",
  contentWidth: "版心宽度",
  cacheMaxBooks: "缓存上限",
};

/** 一个 Slider_Setting 的三方读数。 */
interface SliderTriple {
  /** 滑杆 `value` 换算的数值。 */
  slider: number;
  /** 旁边显示的数值。 */
  display: number;
  /** 生效值。 */
  effective: number;
  /** 生效值的来源与原文。 */
  source: string;
}

type SliderTable = Record<SliderSettingKey, SliderTriple>;

/** 设置键原文中的 `cacheMaxBooks`；键不存在、不是 JSON 对象或该字段不是数时为 null。 */
function storedCacheMaxBooks(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as Record<string, unknown>).cacheMaxBooks;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/** 只有一个取值时为该值，否则为 null。 */
function single(values: string[]): string | null {
  return values.length === 1 ? values[0] : null;
}

/** 读 5 个滑杆的 `value`、旁边的显示值与生效值（只读）。 */
async function readSliderTable(page: Page): Promise<SliderTable> {
  const d = settingsDrawer(page);
  const sliderValue = async (slider: Locator): Promise<number> => Number(await slider.inputValue());
  const shown = await readDrawerValues(page);
  const shownMaxBooks = await readDisplay(d.cacheMaxBooksValue.textContent(), /^(\d+) 本$/, "缓存上限");
  const r = await readTypography(page);
  const articleMaxWidth = await reader(page).article.evaluate((el) => getComputedStyle(el).maxWidth);
  const storedRaw = await page.evaluate((key) => window.localStorage.getItem(key), READER_SETTINGS_KEY);
  const stored = storedCacheMaxBooks(storedRaw);

  const fontSize = single(r.fontSize);
  const lineHeight = single(r.lineHeight);
  const letterSpacing = single(r.letterSpacing);
  const all = (values: string[]): string => `[${values.join(" | ")}]`;
  return {
    fontSize: {
      slider: await sliderValue(d.fontSizeSlider),
      display: shown.fontSize,
      effective: fontSize === null ? Number.NaN : px(fontSize),
      source: `正文段落 font-size ${all(r.fontSize)}`,
    },
    lineHeight: {
      slider: await sliderValue(d.lineHeightSlider),
      display: shown.lineHeight,
      effective: fontSize === null || lineHeight === null ? Number.NaN : px(lineHeight) / px(fontSize),
      source: `正文段落 line-height ${all(r.lineHeight)} ÷ font-size ${all(r.fontSize)}`,
    },
    letterSpacing: {
      slider: await sliderValue(d.letterSpacingSlider),
      display: shown.letterSpacing,
      effective: letterSpacing === null ? Number.NaN : px(letterSpacing),
      source: `正文段落 letter-spacing ${all(r.letterSpacing)}`,
    },
    contentWidth: {
      slider: await sliderValue(d.contentWidthSlider),
      display: shown.contentWidth,
      effective: px(articleMaxWidth),
      source: `<article> max-width ${articleMaxWidth}`,
    },
    cacheMaxBooks: {
      slider: await sliderValue(d.cacheMaxBooksSlider),
      display: shownMaxBooks,
      effective: stored ?? DEFAULT_CACHE_MAX_BOOKS,
      source:
        stored !== null
          ? `设置键中的 cacheMaxBooks ${stored}`
          : `设置键${storedRaw === null ? "不存在" : "中没有数值 cacheMaxBooks"}，取默认值 ${DEFAULT_CACHE_MAX_BOOKS}`,
    },
  };
}

/** 生效值与滑杆值相符：行高按 `LINE_HEIGHT_RATIO_TOLERANCE`，其余严格相等。 */
function effectiveMatches(key: SliderSettingKey, t: SliderTriple): boolean {
  return key === "lineHeight"
    ? Math.abs(t.effective - t.slider) <= LINE_HEIGHT_RATIO_TOLERANCE
    : t.effective === t.slider;
}

function sliderTableVerdict(table: SliderTable): string {
  const problems: string[] = [];
  for (const key of SLIDER_SETTING_KEYS) {
    const t = table[key];
    const what = SLIDER_SETTING_NAMES[key];
    if (t.slider !== t.display) problems.push(`${what}：滑杆 ${t.slider} ≠ 显示 ${t.display}`);
    if (!effectiveMatches(key, t)) problems.push(`${what}：滑杆 ${t.slider} 与生效值 ${t.effective}（${t.source}）不符`);
  }
  return problems.length === 0 ? MATCH : problems.join("；");
}

function describeSliderTable(table: SliderTable): string {
  return SLIDER_SETTING_KEYS.map((key) => {
    const t = table[key];
    return `${SLIDER_SETTING_NAMES[key]} 滑杆 ${t.slider} / 显示 ${t.display} / 生效 ${t.effective}（${t.source}）`;
  }).join("；");
}

test("RDF 6.4 全新上下文中打开设置抽屉：5 个滑杆的 value 等于旁边显示的数值，也等于生效值（正文段落 font-size、line-height ÷ font-size、letter-spacing，<article> max-width，缓存上限的存储值或默认值）", async ({
  page,
  lib,
  bookLog,
}) => {
  await openTypographyBook(page, lib, bookLog);
  await step("前提：全新上下文，记下设置键的原值（未经抽屉写入时应不存在）", async () => {
    const raw = await page.evaluate((key) => window.localStorage.getItem(key), READER_SETTINGS_KEY);
    annotate("rdf-slider-values", `打开抽屉前设置键 ${READER_SETTINGS_KEY}：${raw ?? "（不存在）"}`);
  });
  await openSettingsDrawer(page);

  await step("6.4 5 个滑杆的 value = 旁边显示的数值 = 生效值（行高容差 0.01）", async () => {
    await expect
      .poll(async () => sliderTableVerdict(await readSliderTable(page)), {
        message: "6.4 滑杆位置、显示值与生效值应一致",
      })
      .toBe(MATCH);
    const table = await readSliderTable(page);
    annotate("rdf-slider-values", describeSliderTable(table));
    for (const key of SLIDER_SETTING_KEYS) {
      const t = table[key];
      const what = SLIDER_SETTING_NAMES[key];
      expect(t.slider, `${what}滑杆的 value 应为数字`).not.toBeNaN();
      expect(t.display, `${what}：滑杆 value 与显示值`).toBe(t.slider);
      expect(effectiveMatches(key, t), `${what}：滑杆 ${t.slider} 与生效值 ${t.effective}（${t.source}）`).toBe(true);
    }
  });
});
