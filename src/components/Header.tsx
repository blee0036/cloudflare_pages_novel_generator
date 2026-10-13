import React from "react";
import {
  ArrowLeft,
  List,
  Settings,
  Maximize,
  Minimize,
  Search,
  Bookmark,
  Download,
  TriangleAlert,
} from "lucide-react";

interface HeaderProps {
  title: string;
  chapterTitle?: string;
  progressPercent: number;
  show: boolean;
  isBookmarked: boolean;
  onBack: () => void;
  onToggleToc: () => void;
  onToggleSearch: () => void;
  onToggleBookmark: () => void;
  onToggleSettings: () => void;
  /**
   * 整本下载（需求 9.1）。正文未就绪时为 `null`，按钮置灰。回调允许抛错（超大书分配不出
   * 那个 Blob），由这里兜住，按钮改成"下载失败"的样子，再按一次即重试。
   */
  onDownload: (() => void) | null;
  /**
   * 顶栏上任何一处点击（含按钮，冒泡上来）。阅读页用它重置控制栏的 4.5 秒自动隐藏计时。
   */
  onClick?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  chapterTitle,
  progressPercent,
  show,
  isBookmarked,
  onBack,
  onToggleToc,
  onToggleSearch,
  onToggleBookmark,
  onToggleSettings,
  onDownload,
  onClick,
}) => {
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [downloadFailed, setDownloadFailed] = React.useState(false);

  const handleDownload = () => {
    if (!onDownload) return;
    try {
      onDownload();
      setDownloadFailed(false);
    } catch {
      setDownloadFailed(true);
    }
  };
  const downloadName = downloadFailed ? "下载失败，点击重试" : "下载整本";

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <header
      onClick={onClick}
      className={`fixed top-0 left-0 right-0 h-14 z-30 transition-transform duration-300 ease-in-out border-b shadow-sm bg-[var(--bg)] text-[var(--text)] border-[var(--border)] ${
        show ? "translate-y-0" : "-translate-y-full"
      }`}
    >
      <div className="max-w-6xl mx-auto h-full px-4 flex items-center justify-between">
        {/* Left: Back & Title */}
        <div className="flex items-center space-x-3 overflow-hidden">
          <button
            onClick={onBack}
            className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors"
            title="返回书架"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="truncate">
            <h1 className="text-sm font-semibold truncate leading-tight">{title}</h1>
            {chapterTitle && (
              <p className="text-xs text-[var(--text-muted)] truncate leading-tight mt-0.5">
                {chapterTitle}
              </p>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
          <span className="text-xs px-2 py-0.5 rounded-full font-medium hidden sm:inline-block bg-[var(--card-bg)] text-[var(--accent)]">
            已读 {progressPercent.toFixed(1)}%
          </span>

          <button
            onClick={onToggleBookmark}
            className={`p-2 rounded-lg hover:bg-[var(--hover)] transition-colors ${
              isBookmarked ? "text-amber-500" : "text-[var(--text-muted)]"
            }`}
            title={isBookmarked ? "已添加书签 (点击移除)" : "添加书签"}
          >
            <Bookmark className={`w-5 h-5 ${isBookmarked ? "fill-current" : ""}`} />
          </button>

          <button
            onClick={onToggleToc}
            className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors"
            title="章节目录 (快捷键: T)"
          >
            <List className="w-5 h-5" />
          </button>

          <button
            onClick={onToggleSearch}
            className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors"
            title="全书内容检索 (快捷键: F)"
          >
            <Search className="w-5 h-5" />
          </button>

          {/* 整本下载：手机上也显示。窄屏上书名会多截掉一截，换来不用进设置抽屉找下载 */}
          <button
            onClick={handleDownload}
            disabled={onDownload === null}
            className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
            aria-label={downloadName}
            title={downloadName}
          >
            {downloadFailed ? (
              <TriangleAlert className="w-5 h-5" aria-hidden="true" />
            ) : (
              <Download className="w-5 h-5" aria-hidden="true" />
            )}
          </button>

          <button
            onClick={onToggleSettings}
            className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors"
            title="阅读设置 (快捷键: S)"
          >
            <Settings className="w-5 h-5" />
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors hidden sm:block"
            title="全屏切换 (快捷键: F11)"
          >
            {isFullscreen ? (
              <Minimize className="w-5 h-5" />
            ) : (
              <Maximize className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
};
