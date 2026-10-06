/**
 * 站点标识的单一来源（需求 9.2 / 9.3，差异表 C22）。
 *
 * ## 一份配置，两个消费者
 *
 * 需求 9.2 的四个值（站点名、简介、关键词、favicon）要同时出现在两处，且两处的时机不同：
 *
 * 1. **`index.html` 的 `<head>`**——`<title>` / `<meta description|keywords>` / `<link rel=icon>`
 *    必须在 JS 跑起来之前就是最终值：爬虫不执行脚本，首帧标签页与图标也不该先闪一下默认值。
 *    这要求构建期把值写进 HTML 文本，运行时改 DOM 做不到。
 * 2. **运行时**——需求 9.3 要"返回书架时恢复为站点名称"，那一刻已经没有 HTML 可读了
 *    （BrowserRouter 不重新加载文档），站点名必须在 JS 里拿得到。
 *
 * 两个消费者，但**只有一份真相**：本模块的 `DEFAULT_SITE_CONFIG` 是内置默认值，
 * 可选的 `site.config.json` 覆盖其中任意字段。`vite.config.ts` 的 `site-config` 插件
 * 读这个文件一次，然后
 * - 用 `siteHtmlPlaceholders()` 把 `index.html` 里的 `%SITE_*%` 占位符替换掉（消费者 1）；
 * - 用 `define` 把整份解析结果注入成 `__SITE_CONFIG__`，由 `utils/site.ts` 读出（消费者 2）。
 *
 * 所以本模块**同时被构建期（Node）与运行时（浏览器）导入**，因此必须是纯的：不碰
 * `document`、不碰 `fs`、不读环境变量。读盘那一步留在插件里，它也是唯一知道
 * "文件可能不存在"的地方。
 *
 * ## 为什么是 JSON + `fs.readFileSync`，而不是 `import`
 *
 * 配置文件是**可选**的（需求 9.2 明确"缺失时用内置默认值"）。`import site from
 * "../site.config.json"` 在文件缺失时是一个解析错误，整个构建当场失败——恰好是需求
 * 禁止的行为。而 `fs.existsSync` + `readFileSync` 能把"没有这个文件"表达成一条正常分支。
 * JSON 而非 `.ts`/`.js`：配置是数据，不该有执行语义，站主改一行站点名不必懂模块系统。
 *
 * ## 为什么用 `define` 注入，而不是 `.env` / `import.meta.env`
 *
 * Vite 原生支持在 HTML 里替换 `%VITE_FOO%`，但只认 `.env` 文件里的变量——那意味着配置
 * 只能是扁平的字符串（关键词这种列表得自己约定分隔符），且 `.env` 按惯例是 gitignore
 * 的本机文件，CI 构建时拿不到。`define` 一次注入整个对象，类型由本模块的 `SiteConfig`
 * 钉住，HTML 与运行时共用同一份解析结果。
 *
 * ## 校验策略：逐字段回落，不整份丢弃
 *
 * `resolveSiteConfig` 对每个字段单独判定，坏字段各自回落到默认值并记一条告警。理由是
 * 一个手写 JSON 里最常见的错误是某一个键拼错或类型写错（`keywords` 写成字符串），
 * 若整份配置作废，站主会看到站点名也变了——错误的表现与原因相距太远。真正无法解释的
 * 情形只有一种（顶层不是对象），那时才整份回落。
 *
 * 告警不吞：插件会把它们打到构建日志里。静默回落的代价是站主改完配置看不出哪一行没生效。
 *
 * ## 书架文案（`tagline` / `banner`）
 *
 * 顶栏品牌名下的副标题与书架 Banner 的文案也走这份配置。它们只有运行时一个消费者
 * （书架页从 `SITE` 读），不进 `index.html`，因此没有对应的 `%SITE_*%` 占位符。
 *
 * 其中纯装饰性的三项（`tagline`、`banner.badge`、`banner.description`）允许显式写成
 * 空字符串，表示"不显示这一块"——与 `keywords: []` 表示"不要关键词"同一个思路。
 * `banner.title` 是书架页唯一的 `<h1>`、`banner.countLabel` 是藏书数字的说明，
 * 两者缺了页面就不成立，所以空白仍按写错处理、回落默认值。
 */

/** 可选配置文件的文件名，位于仓库根目录（与 `index.html`、`vite.config.ts` 同级）。 */
export const SITE_CONFIG_FILE = "site.config.json";

/**
 * 书架页 Banner 的文案。藏书数字本身来自书库目录（`books.json` 的 `count`），不可配置。
 */
export interface SiteBanner {
  /** 标题上方的小标签。空字符串表示不显示。 */
  readonly badge: string;
  /** 主标题，也是书架页的 `<h1>`。不可为空。 */
  readonly title: string;
  /** 标题下的说明文字。空字符串表示不显示。 */
  readonly description: string;
  /** 藏书数字下方的说明，如"精校藏书"。不可为空。 */
  readonly countLabel: string;
}

/**
 * 站点标识与书架文案。运行时由 `utils/site.ts` 提供，构建期由插件解析后注入。
 *
 * 前四项（`name` / `description` / `keywords` / `favicon`）同时进 `index.html` 与运行时；
 * `tagline` / `banner` 只在运行时由书架页使用。
 */
export interface SiteConfig {
  /** 站点名称。标签页标题、书架顶栏的品牌名都用它。 */
  readonly name: string;
  /** 一句话简介，写进 `<meta name="description">`。 */
  readonly description: string;
  /** 关键词列表，写进 `<meta name="keywords">`（输出时以 `,` 连接）。 */
  readonly keywords: readonly string[];
  /**
   * favicon 的地址。三种写法见 `faviconPublicPath`：
   * data URI / 绝对 URL 原样使用，其余一律当作 `public/` 下的相对路径。
   */
  readonly favicon: string;
  /** 顶栏品牌名下方的一行副标题。空字符串表示不显示。 */
  readonly tagline: string;
  /** 书架页 Banner 的文案。配置里可以只写其中几项，其余保持默认。 */
  readonly banner: SiteBanner;
}

/**
 * 内置默认值（需求 9.2 的"缺失时使用内置默认值"）。
 *
 * 站点名、简介、关键词取值与改造前 `index.html` 里硬编码的那一份一致（站点名去掉了原先的
 * " - Web Reader" 后缀——它是标题的装饰，不是站点名，而现在这个值还要用在书架顶栏与
 * 书籍标题的后缀里）。配置文件因此是纯增量能力，不是新的必填项。
 *
 * 默认 favicon 是仓库自带的 `public/favicon.svg`（读书的蓝猫，已纳入版本控制）。它同时
 * 是书架顶栏的图标，标签页与顶栏用同一个地址，浏览器只取一次。这个文件若被删掉，构建会
 * 在 `site-config` 插件的 `generateBundle` 里明确报错，而不是带着一个 404 图标上线。
 */
export const DEFAULT_SITE_CONFIG: SiteConfig = {
  name: "云端小说书架",
  description:
    "纯静态的 Web 小说书库：单书 Gzip 压缩存储，浏览器流式解压，章节化阅读与精确续读。",
  keywords: ["小说", "在线阅读", "电子书", "静态网站", "Cloudflare Pages"],
  favicon: "/favicon.svg",
  // 以下文案取值与改为可配置之前 BookshelfPage 里硬编码的一致，零配置时页面不变。
  tagline: "Cloudflare Pages + Gzip 静态阅读器",
  banner: {
    badge: "Pure Cloudflare Pages 架构",
    title: "轻量、丝滑且无限制的 Web 电子书库",
    description:
      "采用单书原生 Gzip 压缩存储，通过浏览器 DecompressionStream 内存流解压，配合分级正则状态机与绝对字符偏移断章，彻底告别切片乱码与文件数超限。",
    countLabel: "精校藏书",
  },
};

/** `resolveSiteConfig` 的产物：解析结果 + 给构建日志的告警。 */
export interface ResolvedSiteConfig {
  readonly config: SiteConfig;
  /** 逐条可读的问题描述，空数组表示配置完全可用。调用方负责打印。 */
  readonly warnings: readonly string[];
}

/** 配置文件里认得的键。其余键一律告警后忽略——拼错键名是手写 JSON 的头号错误。 */
const KNOWN_KEYS: readonly (keyof SiteConfig)[] = [
  "name",
  "description",
  "keywords",
  "favicon",
  "tagline",
  "banner",
];

/** `banner` 对象里认得的键，同样对拼错的键告警。 */
const KNOWN_BANNER_KEYS: readonly (keyof SiteBanner)[] = [
  "badge",
  "title",
  "description",
  "countLabel",
];

/**
 * 判定 favicon 是"外部地址"而非 `public/` 下的文件：带协议（`data:`、`https:`）或
 * 协议相对（`//cdn/...`）。这类地址原样写进 `href`，构建期不碰文件系统。
 */
const EXTERNAL_FAVICON_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * 解析一份已读入内存的配置对象（`JSON.parse` 的结果）。
 *
 * 纯函数：不读盘、不抛异常。文件缺失由调用方（插件）表达为"不调用本函数，直接用默认值"；
 * JSON 语法错误同样在插件那一层——那是一个必须让站主看见的硬错误，不是可回落的字段问题。
 */
export function resolveSiteConfig(raw: unknown): ResolvedSiteConfig {
  const warnings: string[] = [];

  if (!isPlainObject(raw)) {
    warnings.push(
      `${SITE_CONFIG_FILE} 的顶层必须是一个 JSON 对象，实际是 ${describeType(raw)}；本次全部字段用内置默认值`,
    );
    return { config: DEFAULT_SITE_CONFIG, warnings };
  }

  for (const key of Object.keys(raw)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      warnings.push(`未知字段 "${key}" 已忽略；可用字段：${KNOWN_KEYS.join("、")}`);
    }
  }

  return {
    config: {
      name: readText(raw.name, "name", DEFAULT_SITE_CONFIG.name, warnings),
      description: readText(
        raw.description,
        "description",
        DEFAULT_SITE_CONFIG.description,
        warnings,
      ),
      keywords: readKeywords(raw.keywords, warnings),
      favicon: readFavicon(raw.favicon, warnings),
      tagline: readOptionalText(
        raw.tagline,
        "tagline",
        DEFAULT_SITE_CONFIG.tagline,
        warnings,
      ),
      banner: readBanner(raw.banner, warnings),
    },
    warnings,
  };
}

/**
 * 标签页标题（需求 9.3）。
 *
 * 形态是 `书名 - 站点名`，没有书名时只剩站点名。书名在**前**：标签页宽度有限，被截断时
 * 留在屏幕上的应该是读者用来分辨标签的那个词，而站点名在自己的站里是冗余信息。
 *
 * 纯函数，两个页面的标题都由它算出来（见 `hooks/useDocumentTitle.ts`），所以"返回书架
 * 恢复为站点名"与"打开书籍反映书名"是同一个表达式的两个分支，不可能各自漂移。
 *
 * 站点名为空白（配置被改坏且绕过了校验）时兜回默认站名：标签页标题不该是一个空串。
 */
export function documentTitleFor(siteName: string, bookTitle?: string | null): string {
  const site = siteName.trim() || DEFAULT_SITE_CONFIG.name;
  const book = (bookTitle ?? "").trim();
  return book ? `${book} - ${site}` : site;
}

/**
 * favicon 指向的 `public/` 下相对路径；外部地址（data URI / 绝对 URL）返回 `null`。
 *
 * 构建插件用它决定要不要把图标文件搬进 `dist/`：**必须搬**，因为构建开着
 * `build.copyPublicDir: false`（`public/` 下那 7000 本书不能被复制一遍，需求 11.1），
 * Vite 不再帮任何 `public/` 文件落地。图标若只躺在 `public/` 根下而没人搬，构建产物里
 * 就会缺它——dev 正常、线上 404，是最难发现的那类缺陷。
 *
 * 返回值不带前导 `/`，正好既是 `public/` 下的相对路径，也是 Rollup `emitFile` 要的
 * `fileName`；拼 `href` 时补回前导 `/`（见 `faviconHref`）。
 */
export function faviconPublicPath(favicon: string): string | null {
  if (EXTERNAL_FAVICON_RE.test(favicon)) return null;
  return favicon.replace(/^\/+/, "");
}

/** favicon 写进 `<link rel="icon" href>` 的最终值（未转义）。 */
export function faviconHref(favicon: string): string {
  const relative = faviconPublicPath(favicon);
  return relative === null ? favicon : `/${relative}`;
}

/**
 * `index.html` 里 `%SITE_*%` 占位符到最终文本的映射，值**已按 HTML 转义**。
 *
 * 占位符形式（而不是在插件里拼 `<meta>` 标签注入）是为了让 `index.html` 保持可读：
 * 打开它就能看到 head 的完整形状，谁在替换哪一个值一目了然，也不必让插件去关心标签顺序。
 *
 * 刻意不用 `VITE_` 前缀：Vite 自己有一个 `%VITE_FOO%` 的 env 替换 preHook，前缀命中
 * 而 env 里没有该键时它会打一条 "is not defined in env variables" 的告警。`%SITE_*%`
 * 不命中它的前缀，于是原样穿过那个 hook，落到本插件手里。
 */
export function siteHtmlPlaceholders(config: SiteConfig): Readonly<Record<string, string>> {
  return {
    "%SITE_NAME%": escapeHtml(config.name),
    "%SITE_DESCRIPTION%": escapeHtml(config.description),
    "%SITE_KEYWORDS%": escapeHtml(config.keywords.join(",")),
    "%SITE_FAVICON%": escapeHtml(faviconHref(config.favicon)),
  };
}

/**
 * 占位符的匹配式。插件用它做一次性替换，认不出的 `%SITE_XXX%` **原样留下**——
 * 站主在 HTML 里写错占位符名时，坏掉的标记留在产物里是看得见的，比静默变成空串好查。
 *
 * 每次调用新建一个正则：带 `g` 的正则有 `lastIndex` 状态，共享一个实例会让连续两次
 * `replace` 的第二次从上次的位置开始。
 */
export function siteHtmlPlaceholderPattern(): RegExp {
  return /%SITE_[A-Z_]+%/g;
}

/**
 * 转义会破坏 HTML 结构的字符。`<title>` 的文本内容与属性值两处共用一套：双引号属性里
 * 单引号无需转义，而 `&` / `<` / `>` / `"` 四个在两种上下文里都必须转。
 *
 * 站点名里出现 `&` 不是奇事（"张三 & 李四的书架"），不转义就会喂给浏览器一个坏实体。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 给告警文案用的类型描述，`null` 与数组要与普通对象区分开。 */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}

/** 字符串字段：缺省即默认值（不告警），类型错或去空白后为空则告警后回落。 */
function readText(
  value: unknown,
  key: string,
  fallback: string,
  warnings: string[],
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    warnings.push(`字段 "${key}" 应为字符串，实际是 ${describeType(value)}；改用默认值`);
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    warnings.push(`字段 "${key}" 是空白字符串；改用默认值`);
    return fallback;
  }
  return trimmed;
}

/**
 * 可隐藏的字符串字段：与 `readText` 的差别只在空白——这里空白表示"不显示"，返回 `""`，
 * 不告警。类型写错仍告警后回落。
 */
function readOptionalText(
  value: unknown,
  key: string,
  fallback: string,
  warnings: string[],
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    warnings.push(`字段 "${key}" 应为字符串，实际是 ${describeType(value)}；改用默认值`);
    return fallback;
  }
  return value.trim();
}

/**
 * `banner`：逐项回落，与顶层同一套规则。只写 `{ "title": "..." }` 时其余三项保持默认。
 * 整个值不是对象（比如误写成一个字符串）时，四项全部用默认值并告警。
 */
function readBanner(value: unknown, warnings: string[]): SiteBanner {
  const fallback = DEFAULT_SITE_CONFIG.banner;
  if (value === undefined) return fallback;

  if (!isPlainObject(value)) {
    warnings.push(`字段 "banner" 应为对象，实际是 ${describeType(value)}；改用默认值`);
    return fallback;
  }

  for (const key of Object.keys(value)) {
    if (!(KNOWN_BANNER_KEYS as readonly string[]).includes(key)) {
      warnings.push(
        `未知字段 "banner.${key}" 已忽略；可用字段：${KNOWN_BANNER_KEYS.join("、")}`,
      );
    }
  }

  return {
    badge: readOptionalText(value.badge, "banner.badge", fallback.badge, warnings),
    title: readText(value.title, "banner.title", fallback.title, warnings),
    description: readOptionalText(
      value.description,
      "banner.description",
      fallback.description,
      warnings,
    ),
    countLabel: readText(value.countLabel, "banner.countLabel", fallback.countLabel, warnings),
  };
}

/**
 * 关键词：数组与逗号分隔的字符串都收（含中文逗号——手写配置里出现的概率不低）。
 *
 * 显式的空数组是合法表达："这个站不要关键词"，产出空的 `content=""`，不告警。
 */
function readKeywords(value: unknown, warnings: string[]): readonly string[] {
  if (value === undefined) return DEFAULT_SITE_CONFIG.keywords;

  if (typeof value === "string") {
    return splitKeywords(value);
  }

  if (Array.isArray(value)) {
    const kept = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (kept.length !== value.length) {
      warnings.push(`字段 "keywords" 里有 ${value.length - kept.length} 项不是非空字符串，已丢弃`);
    }
    return kept;
  }

  warnings.push(
    `字段 "keywords" 应为字符串数组或逗号分隔的字符串，实际是 ${describeType(value)}；改用默认值`,
  );
  return DEFAULT_SITE_CONFIG.keywords;
}

function splitKeywords(value: string): readonly string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * favicon：先按普通字符串字段校验，再拦掉两类写不对的路径。
 *
 * - 含 `..` 的相对路径：它会指到 `public/` 之外，而 `emitFile` 的 `fileName` 也不接受
 *   这种路径。站主想引用仓库别处的图标，正确做法是把文件放进 `public/`。
 * - 反斜杠：Windows 上顺手写成 `\icon.png` 的话，dev 能歪打正着（浏览器容错），构建
 *   产物里却会出现一个名字带反斜杠的文件。统一要求正斜杠。
 */
function readFavicon(value: unknown, warnings: string[]): string {
  const text = readText(value, "favicon", DEFAULT_SITE_CONFIG.favicon, warnings);
  if (text === DEFAULT_SITE_CONFIG.favicon) return text;

  const relative = faviconPublicPath(text);
  if (relative === null) return text; // data URI / 绝对 URL，不落地成文件

  if (!relative) {
    warnings.push(`字段 "favicon" 只有斜杠，没有文件名；改用默认值`);
    return DEFAULT_SITE_CONFIG.favicon;
  }
  if (relative.split("/").includes("..")) {
    warnings.push(
      `字段 "favicon" 不能含 ".."（它必须指向 public/ 下的文件）：${text}；改用默认值`,
    );
    return DEFAULT_SITE_CONFIG.favicon;
  }
  if (relative.includes("\\")) {
    warnings.push(`字段 "favicon" 请用正斜杠分隔路径：${text}；改用默认值`);
    return DEFAULT_SITE_CONFIG.favicon;
  }

  return text;
}
