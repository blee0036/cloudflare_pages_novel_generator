import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Type, Palette, HardDrive, Trash2, TriangleAlert, Download } from "lucide-react";
import { ReaderSettings } from "../types";
import { READER_THEMES } from "../utils/theme";
import {
  MAX_MAX_BOOKS,
  MIN_MAX_BOOKS,
  clearBookCache,
  isCacheDegraded,
  normalizeMaxBooks,
} from "../utils/bookCache";
import { listCachedBooks } from "../utils/indexedDB";
import { CacheUsage, formatByteSize, summarizeCacheUsage } from "../utils/cacheUsage";

interface SettingDrawerProps {
  isOpen: boolean;
  settings: ReaderSettings;
  onClose: () => void;
  onUpdateSettings: (newSettings: Partial<ReaderSettings>) => void;
  /**
   * 整本下载（需求 9.1）。正文尚未就绪时为 `null`，按钮随之置灰。
   *
   * 抽屉不碰 `Blob` 也不认识书名——全文在 `ReaderPage` 手里（`fullText`），这里只提供
   * 入口与反馈。回调**允许抛错**（超大书在低内存设备上可能分配不出那个 Blob），由下面的
   * `handleDownload` 兜住并显示失败文案。
   */
  onDownloadBook: (() => void) | null;
  /** 将要写出的文件名，直接显示给读者（净化后的结果，见 `utils/download.ts`）。 */
  downloadFileName: string;
}

export const SettingDrawer: React.FC<SettingDrawerProps> = ({
  isOpen,
  settings,
  onClose,
  onUpdateSettings,
  onDownloadBook,
  downloadFileName,
}) => {
  /*
    离线缓存区块的状态（需求 4.5）。

    `usage` 为 `null` 表示"还没查过"，与"查过、是空的"区分开——前者显示"统计中…"，
    后者显示"0 本"。两者用同一个文案会让首次打开抽屉的瞬间闪一个假的 0。
  */
  const [usage, setUsage] = useState<CacheUsage | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState(false);
  /*
    降级闩是模块级的可变状态（`bookCache.ts` 的 `memoryOnly`），不是 props 也不是 state，
    React 不会因它变化而重渲染。所以在每次刷新占用时顺手快照一份：抽屉打开的那一刻就是
    读者会看到这条提示的唯一时机。
  */
  const [degraded, setDegraded] = useState(false);

  /*
    整本下载的失败标记（需求 9.1）。

    这个动作本身是同步且瞬时的——`new Blob` + 一次 `a.click()`，没有"进行中"这个状态可显示
    （浏览器的下载栏随后自己会出现），所以只有"失败"需要状态。能失败的也只有 Blob 分配：
    最大书的全文约 57 MB UTF-8，低内存设备上确实可能拿不到那块内存，而那时读者看到的是
    "按了没反应"，必须有一句话解释。
  */
  const [downloadError, setDownloadError] = useState(false);

  /*
    卸载标记。`listCachedBooks()` 是异步的，而抽屉关掉后阅读器整页也可能被卸载（切书、
    返回书架），那时回调仍会到达。它只拦 setState，不试图取消查询——IndexedDB 的游标读
    没有取消一说，读完就扔掉结果是最省事且无副作用的做法。
  */
  const isMountedRef = useRef(true);
  useEffect(() => {
    // 进 effect 时重新置真是必需的，不是保险：`StrictMode`（`main.tsx` 开着）在开发下
    // 会 mount → cleanup → mount，只写 cleanup 的话第二次挂载后这个标记永远是 false，
    // 于是所有 setState 都被自己拦掉——占用数字在开发环境永远停在"统计中…"。
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshUsage = useCallback(async () => {
    // listCachedBooks() 永不抛出：缓存不可用时返回 []，于是这里显示 0 本，
    // 与下面的降级提示一起构成完整的解释（存储层的"读静默"约定）。
    const metas = await listCachedBooks();
    if (!isMountedRef.current) return;
    setUsage(summarizeCacheUsage(metas));
    setDegraded(isCacheDegraded());
  }, []);

  /*
    抽屉打开时刷新，而不是挂载时刷新一次：`SettingDrawer` 由 `ReaderPage` 常驻渲染
    （只靠 `isOpen` 决定要不要出内容），一次性的挂载刷新会让第二次打开看到的是上次的数字，
    而两次之间刚好可能加载过新书或发生过淘汰。关闭时不查，省掉一次无人看的游标遍历。
  */
  useEffect(() => {
    if (!isOpen) return;
    setClearError(false);
    setDownloadError(false);
    void refreshUsage();
  }, [isOpen, refreshUsage]);

  /*
    触发整本下载（需求 9.1）。

    捕获异常而不是让它冒到 React 之外：这是一个用户主动按下的、可以重试的动作，抛上去只会
    在控制台留一行没人看的报错，读者什么也看不到。成功路径不给额外反馈——浏览器自己的下载
    提示已经是最清楚的确认，再叠一句"已开始下载"反而要处理它何时消失。
  */
  const handleDownload = () => {
    if (!onDownloadBook) return;
    setDownloadError(false);
    try {
      onDownloadBook();
    } catch {
      setDownloadError(true);
    }
  };

  /*
    一键清空：不加二次确认。缓存是可再生数据，误点的全部代价是下次打开这几本书要重新下载
    （最大书约 22 MB），而需求 4.5 要的就是"一键"——插一个确认弹窗既违背字面要求，又要为
    此再引入一层遮罩与焦点管理。反馈由数字本身给出：清完立刻变成"0 本 · 0B"。

    走 `clearBookCache()` 而不是存储层的 `clearCachedBooks()`：后者只清数据，不解降级闩，
    于是"清空"反而会让本会话余下时间里缓存彻底不工作（见 `bookCache.ts` 的说明）。
  */
  const handleClear = async () => {
    setIsClearing(true);
    setClearError(false);
    try {
      await clearBookCache();
    } catch {
      if (isMountedRef.current) setClearError(true);
    }
    // 成功与失败都重新统计：失败时数字要如实反映"还在那儿"，而不是乐观地归零。
    await refreshUsage();
    if (isMountedRef.current) setIsClearing(false);
  };

  if (!isOpen) return null;

  /*
    每次渲染都过一遍规范化：`getStoredSettings()` 只做浅合并、不校验数值，手改过的
    localStorage 能给出 `-1` 或 `0`，那会让滑杆的 `value` 落在 min/max 之外（受控 input
    会被浏览器夹回，显示与状态从此不一致）。规范化写在用处，与 `bookCache.ts` 同一口径。
  */
  const maxBooks = normalizeMaxBooks(settings.cacheMaxBooks);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative w-80 sm:w-96 max-w-[85vw] h-full shadow-2xl flex flex-col z-50 overflow-y-auto bg-[var(--bg)] text-[var(--text)] border-l border-[var(--border)]">
        {/* Header */}
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <h2 className="font-bold text-base">阅读设置</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--hover)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* 1. 主题配色 (Theme Presets) */}
          <div>
            <label className="text-xs font-semibold opacity-60 flex items-center mb-3">
              <Palette className="w-3.5 h-3.5 mr-1.5" />
              阅读背景 / 主题
            </label>
            {/*
              五个色块要同时显示五套配色，而当前生效的只有一套——这是整个主题机制里唯一
              需要"别的主题长什么样"的地方（任务 44）。

              做法不是把颜色值搬回 TS，而是给每个按钮带上 `data-theme={key}`：
              `src/index.css` 的选择器是 `[data-theme="..."]` 而非 `:root[...]`，
              于是这几个变量在按钮上就地重声明，`var(--bg)` 一类的类名自然取到该套主题的
              取值（需求 6.1：颜色只存在于 CSS）。按钮的子元素随之换色，页面其余部分不受
              影响——属性只作用于自己的子树。
            */}
            <div className="grid grid-cols-5 gap-2">
              {READER_THEMES.map(({ key, name }) => {
                const isSelected = settings.theme === key;
                return (
                  <button
                    key={key}
                    data-theme={key}
                    onClick={() => onUpdateSettings({ theme: key })}
                    className={`h-11 rounded-xl flex flex-col items-center justify-center transition-all border bg-[var(--bg)] text-[var(--text)] border-[var(--border)] ${
                      isSelected
                        ? "ring-2 ring-offset-2 ring-blue-500 scale-105 shadow-md"
                        : "opacity-80 hover:opacity-100"
                    }`}
                    title={name}
                  >
                    <span className="text-[11px] font-medium leading-none">
                      {name.slice(0, 2)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. 字号调整 (Font Size) */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-xs font-semibold opacity-60 flex items-center">
                <Type className="w-3.5 h-3.5 mr-1.5" />
                字号大小
              </label>
              <span className="text-xs font-mono font-medium">
                {settings.fontSize}px
              </span>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={() =>
                  onUpdateSettings({
                    fontSize: Math.max(14, settings.fontSize - 1),
                  })
                }
                className="w-10 h-8 rounded-lg border border-[var(--border)] font-bold text-xs flex items-center justify-center hover:bg-[var(--hover)]"
              >
                A-
              </button>
              <input
                type="range"
                min="14"
                max="36"
                step="1"
                value={settings.fontSize}
                onChange={(e) =>
                  onUpdateSettings({ fontSize: parseInt(e.target.value, 10) })
                }
                className="flex-1 accent-blue-500"
              />
              <button
                onClick={() =>
                  onUpdateSettings({
                    fontSize: Math.min(36, settings.fontSize + 1),
                  })
                }
                className="w-10 h-8 rounded-lg border border-[var(--border)] font-bold text-sm flex items-center justify-center hover:bg-[var(--hover)]"
              >
                A+
              </button>
            </div>
          </div>

          {/* 3. 字体风格 (Font Family) */}
          <div>
            <label className="text-xs font-semibold opacity-60 flex items-center mb-2">
              字体选择
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { key: "system", name: "系统黑体" },
                { key: "serif", name: "宋体/明体" },
                { key: "kaiti", name: "楷体/手写" },
              ].map((f) => (
                <button
                  key={f.key}
                  onClick={() =>
                    onUpdateSettings({
                      fontFamily: f.key as ReaderSettings["fontFamily"],
                    })
                  }
                  /* 选中态的边框取 `--accent`：原先 `border-blue-500` 与行内
                     `borderColor: theme.accent` 并存，行内胜出，实际呈现的一直是主题强调色
                     （蓝色那个类从未生效）。这里按实际呈现迁移，不改视觉（需求 6.4）。 */
                  className={`py-2 text-xs rounded-lg border font-medium transition-all ${
                    settings.fontFamily === f.key
                      ? "border-[var(--accent)] bg-blue-500/10 font-bold"
                      : "border-[var(--border)] opacity-70 hover:opacity-100"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          {/* 4. 行距、字间距与版心宽度 (Line Height & Letter Spacing & Width) */}
          <div className="space-y-4 pt-2 border-t border-[var(--border)]">
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-xs opacity-60">行高间距</span>
                <span className="text-xs font-mono">{settings.lineHeight}x</span>
              </div>
              <input
                type="range"
                min="1.4"
                max="2.5"
                step="0.05"
                value={settings.lineHeight}
                onChange={(e) =>
                  onUpdateSettings({ lineHeight: parseFloat(e.target.value) })
                }
                className="w-full accent-blue-500"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-xs opacity-60">字间距</span>
                <span className="text-xs font-mono">{settings.letterSpacing}px</span>
              </div>
              <input
                type="range"
                min="0"
                max="4"
                step="0.5"
                value={settings.letterSpacing}
                onChange={(e) =>
                  onUpdateSettings({ letterSpacing: parseFloat(e.target.value) })
                }
                className="w-full accent-blue-500"
                aria-label="字间距"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-xs opacity-60">内容版心宽度</span>
                <span className="text-xs font-mono">{settings.contentWidth}px</span>
              </div>
              <input
                type="range"
                min="600"
                max="1200"
                step="40"
                value={settings.contentWidth}
                onChange={(e) =>
                  onUpdateSettings({ contentWidth: parseInt(e.target.value, 10) })
                }
                className="w-full accent-blue-500"
              />
            </div>
          </div>

          {/* 5. 离线缓存 (Offline Cache) */}
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            <label className="text-xs font-semibold opacity-60 flex items-center">
              <HardDrive className="w-3.5 h-3.5 mr-1.5" />
              离线缓存
            </label>

            {/* 已缓存本数与占用字节（需求 4.5）。`bytes` 是存储层为这一行存的冗余字段，
                所以这里不必读取任何 gz 二进制。 */}
            <div className="flex justify-between items-center text-xs">
              <span className="opacity-60">已缓存</span>
              <span className="font-mono">
                {usage === null
                  ? "统计中…"
                  : `${usage.count} 本 · ${formatByteSize(usage.bytes)}`}
              </span>
            </div>

            {degraded && (
              <p className="text-[11px] opacity-70 flex items-start leading-snug">
                <TriangleAlert className="w-3.5 h-3.5 mr-1.5 mt-px shrink-0" />
                <span>本次会话未能写入离线缓存，阅读不受影响；清空后可再次尝试。</span>
              </p>
            )}

            {/* 本数上限（需求 4.2 的"可在设置中调整"）。调小不会立刻淘汰已有的书——
                淘汰发生在下一次写入前，见 `bookCache.ts` 的 `planCacheEviction`。 */}
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-xs opacity-60">缓存上限</span>
                <span className="text-xs font-mono">{maxBooks} 本</span>
              </div>
              <input
                type="range"
                min={MIN_MAX_BOOKS}
                max={MAX_MAX_BOOKS}
                step="1"
                value={maxBooks}
                onChange={(e) =>
                  onUpdateSettings({
                    cacheMaxBooks: normalizeMaxBooks(parseInt(e.target.value, 10)),
                  })
                }
                className="w-full accent-blue-500"
                aria-label="离线缓存本数上限"
              />
            </div>

            {/* 0 本时按钮**不**置灰：清空同时还负责解除降级闩，而"缓存里一本都没有"恰好
                可能是因为降级（单本比配额还大时一本都写不进去），置灰会把唯一的恢复入口
                关掉。空缓存上点一次的代价只是一次空事务。 */}
            <button
              onClick={() => void handleClear()}
              disabled={isClearing}
              className="w-full py-2 text-xs rounded-lg border border-[var(--border)] font-medium flex items-center justify-center hover:bg-[var(--hover)] disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {isClearing ? "清空中…" : "清空缓存"}
            </button>

            {clearError && (
              <p className="text-[11px] text-red-500" role="alert">
                清空失败，请重试。
              </p>
            )}
          </div>

          {/* 6. 整本下载 (Download whole book) — 需求 9.1 / 差异表 C21

              为什么入口在这里，不在悬浮顶栏：顶栏已经挂了书签、目录、检索、设置、全屏五个
              图标按钮加一个百分比胶囊，窄屏上书名本来就在 `truncate`，第六个按钮要从书名
              再夺走 40px；而下载是一次性的、有意图的动作，不是随时要按的阅读控制。放在抽屉
              里还换来两样图标按钮给不了的东西：文件名能写出来给读者确认，失败能有一句话解释。

              紧跟"离线缓存"也是有意的——两者回答的是同一个问题"把这本书留在我机器上"，
              一个是给浏览器自己用的缓存，一个是给读者拿走的文件。 */}
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            <label className="text-xs font-semibold opacity-60 flex items-center">
              <Download className="w-3.5 h-3.5 mr-1.5" />
              下载整本
            </label>

            {/* 文件名直接显示：净化后的名字可能与书名不同（非法字符被换成 `_`、过长被截断），
                读者在按之前就该知道硬盘上会出现哪个文件。`break-all` 是因为中文书名不含空格，
                不给断点就会撑破抽屉宽度。 */}
            <div className="flex justify-between items-start text-xs gap-2">
              <span className="opacity-60 shrink-0">文件名</span>
              <span className="font-mono text-right break-all opacity-80">
                {downloadFileName}
              </span>
            </div>

            <button
              onClick={handleDownload}
              disabled={onDownloadBook === null}
              className="w-full py-2 text-xs rounded-lg border border-[var(--border)] font-medium flex items-center justify-center hover:bg-[var(--hover)] disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              下载 UTF-8 纯文本
            </button>

            <p className="text-[11px] opacity-60 leading-snug">
              由当前已加载的正文直接生成，不再向服务器请求。
            </p>

            {downloadError && (
              <p className="text-[11px] text-red-500" role="alert">
                生成文件失败，可能是内存不足；关掉几个标签页后重试。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
