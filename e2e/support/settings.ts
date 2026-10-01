/**
 * E2E_Suite 的全部常量只在此处定义（设计"settings.ts（超时与常量的唯一来源）"）。
 *
 * 端口、超时、worker 数、Controlled_Clock 起点、视口、取样间隔、节流、
 * 像素比对容差、Perf_Budget 与 axe 标签清单都从这里导入，其他文件不写字面量。
 */

/**
 * 超时（毫秒），需求 6.8：
 * - test：普通用例 60 s
 * - bigBookTest：涉及 gz ≥ 20 MB 的 Test_Book 的用例 180 s
 * - wait：单次等待可观测条件的上限 10 s（也是 expect.timeout）
 * - bigBookLoad：等待 gz ≥ 20 MB 的书加载完成 120 s
 * - serverRequest：服务器自检每项请求 10 s（5.10）
 * - serverShutdown：运行结束后关闭全部 E2E_Server 实例 10 s（5.14）
 * - charCountAudit：R1 审计（`charcount-audit.spec.ts`，`@audit`）解压并核对真实书库全部
 *   `.txt.gz` 的用例时限 20 min。本机实测 2.1 min（7,681 本、约 21 GiB gz、解压后约
 *   54 GiB）；冷盘要先读完 21 GiB，留出数倍余量。
 * - cacheSettle：离线缓存的判定时限 5 s（11.2 `[book-load]` 之后记录出现、11.7 每次打开后
 *   记录集合达到预期、11.8 点击"清空缓存"后记录数与"已缓存"读数归零），超出即判失败。
 * - loadError：阅读器错误页的判定时限 10 s（11.9 自访问起、11.10 / 19.1 自 `.txt.gz` 响应体
 *   接收完毕起，"书籍加载进度"进度条消失并显示错误页），超出即判失败。
 * - reporterSelftest：reporter 自检（`selftest.spec.ts`，`@selftest`）中故意超时的用例的时限
 *   2 s（设计"Testing Strategy"：`test.setTimeout(2_000)`）；Run_Summary 的超时节应写出该值。
 */
export const TIMEOUTS = {
  test: 60_000,
  bigBookTest: 180_000,
  wait: 10_000,
  bigBookLoad: 120_000,
  serverRequest: 10_000,
  serverShutdown: 10_000,
  charCountAudit: 1_200_000,
  cacheSettle: 5_000,
  loadError: 10_000,
  reporterSelftest: 2_000,
} as const;

/**
 * R1 审计同时在解压的书数。解压走 `zlib.gunzip` 的异步版本，在 libuv 线程池里执行，
 * 取线程池的默认大小 4；再高只是排队（本机实测 8 路比 4 路快不到 15%），还会多占内存
 * （最大的书 gz 约 24 MB，解压后约 65 MB，解码成字符串再占约 45 MB）。
 */
export const CHARCOUNT_AUDIT_CONCURRENCY = 4;

/**
 * 6.8 的"gz ≥ 20 MB"：`.txt.gz` 不小于该字节数的书，用例超时取 `TIMEOUTS.bigBookTest`，等待加载
 * 完成取 `TIMEOUTS.bigBookLoad`（`e2e/support/reader.ts` 的 `bookUnderTest` 据此选取）。按十进制
 * MB 计；本机 Test_Book 中《极品全能高手》与《从零开始》在此之上，其余都远小于它。
 */
export const BIG_BOOK_GZ_BYTES = 20 * 1000 * 1000;

/** 并行 worker 数固定，不随 CPU 核数变化（6.10）。 */
export const WORKERS = 2;

/** Controlled_Clock 的统一起点，带 +08:00 偏移的固定时刻（6.4）。 */
export const CLOCK_T0 = "2025-06-01T20:00:00+08:00";

/**
 * `clock.advanceUntil` 每步推进 Controlled_Clock 的时长（约一帧）。装了时钟后 rAF 也受控，
 * 按此步长推进可让每一帧的回调都执行到（设计"测试支撑"的 `clock` 一条）。推进总量的上限为
 * `TIMEOUTS.wait`。
 */
export const CLOCK_STEP_MS = 16;

/** 4 个 E2E_Server 实例的端口，集中在一处配置（5.12）。 */
export const PORTS = {
  fixtureOpaque: 4611,
  fixtureTransparent: 4612,
  realOpaque: 4621,
  realTransparent: 4622,
} as const;

/** 两个固定视口，设备像素比均为 1（6.2）。 */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

/** 11.5 两次取样之间的间隔，是 6.5 允许的唯一固定等待（取值须在 100–500 ms）。 */
export const PROGRESS_SAMPLE_MS = 250;

/**
 * 11.1 确定态进度条的取样周期（11.1：每 100–300 ms 取样一次）。取样由页面内的 `setInterval`
 * 按此周期读 `aria-valuenow`（`e2e/tests/real/load-progress-opaque.spec.ts`），测试进程不据此
 * 等待：它的等待依据仍是 6.5 所列的可观测条件（`aria-valuenow`、`[book-load]` 行、正文标题）。
 * 取区间中点，使计时器的抖动在两侧各有 100 ms 余量。
 */
export const DETERMINATE_SAMPLE_MS = 200;

/** 11.1 / 11.5 的 CDP 下行节流：4 MiB/s，24 MB 的 gz 约 6 s。 */
export const THROTTLE_BYTES_PER_SEC = 4 * 1024 * 1024;

/**
 * Visual_Regression_Check 的统一容差与基线目录（12.3、12.4）。
 * 单张基线不得覆盖 threshold 与 maxDiffPixelRatio，也不设 maxDiffPixels。
 */
export const VISUAL = {
  /** 逐像素 YIQ 色差阈值（Playwright 默认 0.2 过宽）。 */
  threshold: 0.1,
  /** 差异像素占比上限 0.1%：桌面 ≤ 1,024 个，移动 ≤ 329 个。 */
  maxDiffPixelRatio: 0.001,
  /** 单张基线遮罩合计面积占截图面积的上限 5%。 */
  maxMaskRatio: 0.05,
  baselineDir: "e2e/baselines",
} as const;

/**
 * 性能观测（需求 14）。
 * - samples / keyIntervalMs：每项 5 次取样，逐字输入的按键间隔 100 ms（14.2、14.7）
 * - budgetsMs：Perf_Budget，只在此处配置（14.3）；(e) `[book-load]` 不设预算
 * - shelfQuery：14.2 (c) 的书架检索词
 * - readerKeyword：14.2 (d) 的 5 字关键词，须在《从零开始》中至少命中 1 处（perf 用例在测试
 *   进程中解压该书核对，无命中时 (d) 记为"未采集"）。取"系统提示音"：本机书库中全书 10 处，都在
 *   正文章节内（检索抽屉只列出落在章节里的命中），散布于全书前后；命中数低于检索结果上限 150，
 *   输入末字后的那次检索要扫完全书，正是 (d) 要观测的最重一次按键。
 */
export const PERF = {
  samples: 5,
  keyIntervalMs: 100,
  budgetsMs: {
    /** (a) 点击目录按钮到首个目录行进入视口 */
    tocOpen: 500,
    /** (b) 目录抽屉滚动期间的最长长任务 */
    tocScrollLongTask: 100,
    /** (c) 书架检索：250 ms 防抖 + 100 ms 更新余量 */
    shelfSearch: 350,
    /** (d) 阅读器检索期间的最长长任务 */
    readerSearchLongTask: 100,
  },
  shelfQuery: "clks",
  readerKeyword: "系统提示音",
} as const;

/** A11y_Scan 只启用的 axe 标签（15.3）；不含 best-practice、experimental、wcag2aaa。 */
export const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;
