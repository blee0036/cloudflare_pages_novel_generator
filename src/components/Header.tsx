import React from "react";
import { ArrowLeft, List, Settings, Maximize, Minimize, Search, Bookmark } from "lucide-react";
import { ThemeConfig } from "../utils/storage";

interface HeaderProps {
  title: string;
  chapterTitle?: string;
  progressPercent: number;
  theme: ThemeConfig;
  show: boolean;
  isBookmarked: boolean;
  onBack: () => void;
  onToggleToc: () => void;
  onToggleSearch: () => void;
  onToggleBookmark: () => void;
  onToggleSettings: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  chapterTitle,
  progressPercent,
  theme,
  show,
  isBookmarked,
  onBack,
  onToggleToc,
  onToggleSearch,
  onToggleBookmark,
  onToggleSettings,
}) => {
  const [isFullscreen, setIsFullscreen] = React.useState(false);

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
      className={`fixed top-0 left-0 right-0 h-14 z-30 transition-transform duration-300 ease-in-out border-b shadow-sm ${
        show ? "translate-y-0" : "-translate-y-full"
      }`}
      style={{
        backgroundColor: theme.bg,
        borderColor: theme.border,
        color: theme.text,
      }}
    >
      <div className="max-w-6xl mx-auto h-full px-4 flex items-center justify-between">
        {/* Left: Back & Title */}
        <div className="flex items-center space-x-3 overflow-hidden">
          <button
            onClick={onBack}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="返回书架"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="truncate">
            <h1 className="text-sm font-semibold truncate leading-tight">{title}</h1>
            {chapterTitle && (
              <p className="text-xs opacity-60 truncate leading-tight mt-0.5">
                {chapterTitle}
              </p>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium hidden sm:inline-block"
            style={{ backgroundColor: theme.cardBg, color: theme.accent }}
          >
            已读 {progressPercent.toFixed(1)}%
          </span>

          <button
            onClick={onToggleBookmark}
            className={`p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors ${
              isBookmarked ? "text-amber-500" : "opacity-75 hover:opacity-100"
            }`}
            title={isBookmarked ? "已添加书签 (点击移除)" : "添加书签"}
          >
            <Bookmark className={`w-5 h-5 ${isBookmarked ? "fill-current" : ""}`} />
          </button>

          <button
            onClick={onToggleToc}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="章节目录 (快捷键: T)"
          >
            <List className="w-5 h-5" />
          </button>

          <button
            onClick={onToggleSearch}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="全书内容检索 (快捷键: F)"
          >
            <Search className="w-5 h-5" />
          </button>

          <button
            onClick={onToggleSettings}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            title="阅读设置 (快捷键: S)"
          >
            <Settings className="w-5 h-5" />
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors hidden sm:block"
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
