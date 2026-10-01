/**
 * 阅读器：排版设置（需求 10.7、10.8；可测性缺口 16.4、风险 R6）。`fixture` 项目（:4611，Opaque_Mode），
 * 桌面视口，默认主题（不 `seedTheme`），不装 Controlled_Clock（不涉及时长）。
 *
 * ## 用书
 *
 * `lib.role("volumes")`，不带 `?ch=` 打开（首个正文章节）。期望值不依赖书的内容，只要该章有正文段落。
 *
 * ## 用例划分（设计"补充场景"10.7 / 10.8；16.4、16.7）
 *
 * 设置抽屉里只有"字间距"与"离线缓存本数上限"两个滑杆带可访问名称；字号、行高、版心宽度三个滑杆
 * 没有 `aria-label`，旁边的文字是 `<span>`，不是关联的 `<label>`（`src/components/SettingDrawer.tsx`）。
 * 字号另有"A+""A-"按钮可用，行高与版心宽度没有替代控件。因此：
 *
 * - 用例 A（普通断言）：字号经"A+"点击 2 次、字间距经 `getByLabel("字间距")` 聚焦后按 `ArrowRight`
 *   3 次（滑杆是 `INPUT`，阅读器快捷键不接管）、字体依次点击三个选项并停在初始选项以外的最后一个；
 *   断言 10.7 的 font-size、letter-spacing、三个 font-family 两两不同，重载后断言这三项计算样式、
 *   两个显示值与选中项不变（10.8）。
 * - 用例 B（行高、版心宽度）：先确认两个滑杆已渲染（旁边的字样与显示值可见，度量上各有一个可见的
 *   range 输入框；截图与 DOM 摘录附在用例上），再确认按 role 名称与 label 都定位不到它们、不带名称的
 *   `slider` 匹配多于 1 个（16.4 的"每种定位写法都匹配到 0 个或多于 1 个"），然后以
 *   `[16.4 F-003]` 跳过。不用 Tab 序或 DOM 层级兜底（D8）。若将来滑杆有了可访问名称，这一步会失败，
 *   提示把跳过换成真实断言。
 * - F-004（预期失败）：正文 `<p>` 带 `leading-relaxed`（`line-height: 1.625`），覆盖了 `<article>` 上
 *   按设置写入的行高，所以段落行高与"字号 × 抽屉显示的行高倍数"不符。行高滑杆定位不到（F-003），
 *   这里用未调整的显示倍数核对 10.7 的行高一项；字号仍经"A+"调整。与其余断言无关，单列一个用例（16.7）。
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
 * `typography-initial`、`typography-fonts`、`typography-reading` 里；F-003 的证据写在用例输出目录的
 * `sliders-dom.json`、`sliders.png` 并附在用例上。
 */
import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { FONT_BUTTON_NAMES, NAMES, reader, settingsDrawer, type FontKey } from "../../support/locators";
import { bookUnderTest, openReader, type BookUnderTest } from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 字号的取值区间（`SettingDrawer` 的字号滑杆 `min` / `max`，"A-""A+"按钮同样夹在其中）。字号滑杆没有
 * 可访问名称，读不到它的属性，只能在此写明。
 */
const FONT_MIN_PX = 14;
const FONT_MAX_PX = 36;

/** 用例 A：点击"A+"的次数（步长 1 px）。 */
const FONT_CLICKS = 2;

/** 用例 A：字间距滑杆上按 `ArrowRight` 的次数（每次一个 `step`）。 */
const LETTER_SPACING_PRESSES = 3;

/** 10.7：段落 `line-height` 与"字号 × 行高倍数"的容差。 */
const LINE_HEIGHT_TOLERANCE_PX = 0.5;

/** 三个字体选项，按设置抽屉的呈现顺序。 */
const FONT_KEYS = Object.keys(FONT_BUTTON_NAMES) as FontKey[];

/** 用例 B 的跳过原因（16.4；Finding 见 Findings_Log）。 */
const SLIDER_GAP_REASON =
  "[16.4 F-003] 行高与版心宽度滑杆无可访问名称：无 aria-label，旁边的“行高间距”“内容版心宽度”是 <span> 而非关联的 <label>，" +
  "按 role 名称、label 或可见文本都定位不到（D8，不用 Tab 序或 DOM 层级兜底）";

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

/**
 * 字间距滑杆聚焦后按 `ArrowRight` `LETTER_SPACING_PRESSES` 次；区间与步长取自滑杆的 `min`、`max`、
 * `step` 属性（度量）。目标值须与初始值不同且不在区间端点。返回目标值。
 */
async function increaseLetterSpacing(page: Page, initial: number): Promise<number> {
  const slider = settingsDrawer(page).letterSpacingSlider;
  const range = await step("读字间距滑杆的 min / max / step", async () => {
    const read = async (name: string): Promise<number> => {
      const value = Number(await slider.getAttribute(name));
      expect(Number.isFinite(value), `字间距滑杆的 ${name} 应为数字`).toBe(true);
      return value;
    };
    return { min: await read("min"), max: await read("max"), step: await read("step") };
  });
  const target = initial + LETTER_SPACING_PRESSES * range.step;
  await step(`前提：字间距 ${initial}px → ${target}px 不在区间端点 ${range.min}/${range.max}px`, async () => {
    expect(target, "目标字间距应大于下端点").toBeGreaterThan(range.min);
    expect(target, "目标字间距应小于上端点").toBeLessThan(range.max);
  });
  const d = settingsDrawer(page);
  await step(`字间距滑杆按 ArrowRight ${LETTER_SPACING_PRESSES} 次：显示值 ${initial}px → ${target}px`, async () => {
    for (let i = 1; i <= LETTER_SPACING_PRESSES; i++) {
      await slider.press("ArrowRight");
      await expect(d.letterSpacingValue).toHaveText(`${initial + i * range.step}px`);
    }
  });
  return target;
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
// 用例 B：行高与版心宽度（R6；16.4 跳过）
// ---------------------------------------------------------------------------

/** 某个设置项旁边的滑杆（从其字样出发的度量）：所在区块的 DOM 摘录与滑杆的命名相关属性。 */
interface SliderEvidence {
  label: string;
  /** 找到的 range 输入框；字样所在区块里没有恰好 1 个时为 null。 */
  input: {
    visible: boolean;
    width: number;
    height: number;
    min: string | null;
    max: string | null;
    step: string | null;
    value: string;
    id: string;
    ariaLabel: string | null;
    ariaLabelledby: string | null;
    title: string;
    /** `HTMLInputElement.labels` 的个数（关联的 `<label>`）。 */
    labels: number;
  } | null;
  /** 包含字样与滑杆的最小区块的 `outerHTML`。 */
  html: string | null;
}

/**
 * 从设置项的字样向上找第一个恰好包含 1 个 `input[type=range]` 的祖先，读该输入框（只读度量，不用于
 * 定位要操作的元素）。遇到包含多于 1 个的祖先即停（说明已越过该设置项的区块）。
 */
function readSliderEvidence(page: Page, label: "lineHeight" | "contentWidth"): Promise<SliderEvidence> {
  const d = settingsDrawer(page);
  const anchor = label === "lineHeight" ? d.lineHeightLabel : d.contentWidthLabel;
  return anchor.evaluate((el) => {
    const text = (el.textContent ?? "").trim();
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const inputs = node.querySelectorAll<HTMLInputElement>('input[type="range"]');
      if (inputs.length > 1) break;
      if (inputs.length === 1) {
        const input = inputs[0];
        const box = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        return {
          label: text,
          input: {
            visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none",
            width: box.width,
            height: box.height,
            min: input.getAttribute("min"),
            max: input.getAttribute("max"),
            step: input.getAttribute("step"),
            value: input.value,
            id: input.id,
            ariaLabel: input.getAttribute("aria-label"),
            ariaLabelledby: input.getAttribute("aria-labelledby"),
            title: input.title,
            labels: input.labels?.length ?? 0,
          },
          html: node.outerHTML,
        };
      }
    }
    return { label: text, input: null, html: null };
  });
}

test("10.7 / 10.8 行高与版心宽度：调到非端点的新值后段落 line-height ≈ 字号 × 行高倍数、版心容器 max-width 等于显示值，重载后不变", async ({
  page,
  lib,
  bookLog,
}) => {
  await openTypographyBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  const d = settingsDrawer(page);

  const evidence = await step("确认已渲染：“行高间距”“内容版心宽度”字样与显示值可见，旁边各有一个可见的滑杆（度量）", async () => {
    await expect(d.lineHeightLabel).toBeVisible();
    await expect(d.contentWidthLabel).toBeVisible();
    await expect(d.lineHeightValue).toBeVisible();
    await expect(d.contentWidthValue).toBeVisible();
    const items = [await readSliderEvidence(page, "lineHeight"), await readSliderEvidence(page, "contentWidth")];
    for (const item of items) {
      expect(item.input, `“${item.label}”所在区块应恰有 1 个 range 输入框`).not.toBeNull();
      expect(item.input?.visible, `“${item.label}”的滑杆应可见`).toBe(true);
    }
    return items;
  });

  const aria = await step("16.4 按 role 名称与 label 都定位不到这两个滑杆，不带名称的 slider 匹配多于 1 个", async () => {
    for (const name of [NAMES.lineHeight, NAMES.contentWidth]) {
      const hint = `（若已有可访问名称，F-003 已修复：把本用例的跳过换成真实断言）`;
      await expect(page.getByRole("slider", { name, exact: true }), `getByRole("slider", { name: "${name}" })${hint}`).toHaveCount(0);
      await expect(page.getByLabel(name, { exact: true }), `getByLabel("${name}")${hint}`).toHaveCount(0);
    }
    const sliders = await page.getByRole("slider").all();
    expect(sliders.length, "不带名称的 getByRole(\"slider\") 应匹配多于 1 个").toBeGreaterThan(1);
    // 度量：各滑杆的 ARIA 快照（名称、当前值），作为证据
    const snapshots: string[] = [];
    for (const s of sliders) snapshots.push((await s.ariaSnapshot()).trim());
    return snapshots;
  });

  await step("附证据：各滑杆的 ARIA 快照与两个滑杆所在区块的 DOM 摘录、抽屉打开时的截图", async () => {
    const info = test.info();
    const json = info.outputPath("sliders-dom.json");
    await writeFile(json, `${JSON.stringify({ url: page.url(), ariaSnapshots: aria, sliders: evidence }, null, 2)}\n`, "utf8");
    await info.attach("sliders-dom", { path: json, contentType: "application/json" });
    const png = info.outputPath("sliders.png");
    await page.screenshot({ path: png });
    await info.attach("sliders-screenshot", { path: png, contentType: "image/png" });
    annotate(
      "typography-gap",
      `ARIA：${aria.join(" / ")}；` +
        evidence
          .map(
            (e) =>
              `“${e.label}”滑杆 min ${e.input?.min} max ${e.input?.max} step ${e.input?.step} value ${e.input?.value}，` +
              `aria-label ${JSON.stringify(e.input?.ariaLabel)}、aria-labelledby ${JSON.stringify(e.input?.ariaLabelledby)}、` +
              `title ${JSON.stringify(e.input?.title)}、关联 <label> ${e.input?.labels} 个`,
          )
          .join("；"),
    );
  });

  test.skip(true, SLIDER_GAP_REASON);
});

// ---------------------------------------------------------------------------
// F-004：正文段落的行高不随设置变化（预期失败）
// ---------------------------------------------------------------------------

test("10.7 F-004 字号经 A+ 调整后，正文段落的计算 line-height 与「字号 × 抽屉显示的行高倍数」相差 ≤ 0.5 px", async ({
  page,
  lib,
  bookLog,
}) => {
  test.fail(
    true,
    "F-004 正文 <p> 带 leading-relaxed（line-height: 1.625），覆盖了 <article> 上按设置写入的行高，段落行高恒为 1.625 × 字号",
  );
  await openTypographyBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  const initial = await readInitialState(page);
  // 行高滑杆定位不到（F-003），行高倍数保持初始显示值；字号经 A+ 调整
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
