import React from "react";
import { X, Type, Palette, Layout, BookOpen, Scroll } from "lucide-react";
import { ReaderSettings, ReaderThemeKey } from "../types";
import { THEME_CONFIGS, ThemeConfig } from "../utils/storage";

interface SettingDrawerProps {
  isOpen: boolean;
  settings: ReaderSettings;
  theme: ThemeConfig;
  onClose: () => void;
  onUpdateSettings: (newSettings: Partial<ReaderSettings>) => void;
}

export const SettingDrawer: React.FC<SettingDrawerProps> = ({
  isOpen,
  settings,
  theme,
  onClose,
  onUpdateSettings,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="relative w-80 sm:w-96 max-w-[85vw] h-full shadow-2xl flex flex-col z-50 overflow-y-auto"
        style={{
          backgroundColor: theme.bg,
          color: theme.text,
          borderLeft: `1px solid ${theme.border}`,
        }}
      >
        {/* Header */}
        <div
          className="p-4 border-b flex items-center justify-between"
          style={{ borderColor: theme.border }}
        >
          <div className="flex items-center space-x-2">
            <h2 className="font-bold text-base">阅读设置</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
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
            <div className="grid grid-cols-5 gap-2">
              {(Object.keys(THEME_CONFIGS) as ReaderThemeKey[]).map((key) => {
                const conf = THEME_CONFIGS[key];
                const isSelected = settings.theme === key;
                return (
                  <button
                    key={key}
                    onClick={() => onUpdateSettings({ theme: key })}
                    className={`h-11 rounded-xl flex flex-col items-center justify-center transition-all border ${
                      isSelected
                        ? "ring-2 ring-offset-2 ring-blue-500 scale-105 shadow-md"
                        : "opacity-80 hover:opacity-100"
                    }`}
                    style={{
                      backgroundColor: conf.bg,
                      color: conf.text,
                      borderColor: conf.border,
                    }}
                    title={conf.name}
                  >
                    <span className="text-[11px] font-medium leading-none">
                      {conf.name.slice(0, 2)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. 阅读模式 (Scroll vs Paged) */}
          <div>
            <label className="text-xs font-semibold opacity-60 flex items-center mb-3">
              <Layout className="w-3.5 h-3.5 mr-1.5" />
              翻页 / 阅读模式
            </label>
            <div
              className="grid grid-cols-2 gap-2 p-1 rounded-xl border"
              style={{
                backgroundColor: theme.cardBg,
                borderColor: theme.border,
              }}
            >
              <button
                onClick={() => onUpdateSettings({ viewMode: "scroll" })}
                className={`py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center space-x-1.5 transition-all ${
                  settings.viewMode === "scroll"
                    ? "bg-white shadow text-blue-600 dark:bg-slate-700 dark:text-blue-400"
                    : "opacity-60 hover:opacity-100"
                }`}
              >
                <Scroll className="w-4 h-4" />
                <span>连续滚动</span>
              </button>
              <button
                onClick={() => onUpdateSettings({ viewMode: "paged" })}
                className={`py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center space-x-1.5 transition-all ${
                  settings.viewMode === "paged"
                    ? "bg-white shadow text-blue-600 dark:bg-slate-700 dark:text-blue-400"
                    : "opacity-60 hover:opacity-100"
                }`}
              >
                <BookOpen className="w-4 h-4" />
                <span>单页翻页</span>
              </button>
            </div>
          </div>

          {/* 3. 字号调整 (Font Size) */}
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
                className="w-10 h-8 rounded-lg border font-bold text-xs flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
                style={{ borderColor: theme.border }}
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
                className="w-10 h-8 rounded-lg border font-bold text-sm flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
                style={{ borderColor: theme.border }}
              >
                A+
              </button>
            </div>
          </div>

          {/* 4. 字体风格 (Font Family) */}
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
                  className={`py-2 text-xs rounded-lg border font-medium transition-all ${
                    settings.fontFamily === f.key
                      ? "border-blue-500 bg-blue-500/10 font-bold"
                      : "opacity-70 hover:opacity-100"
                  }`}
                  style={{ borderColor: settings.fontFamily === f.key ? theme.accent : theme.border }}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          {/* 5. 行距与版心宽度 (Line Height & Width) */}
          <div className="space-y-4 pt-2 border-t" style={{ borderColor: theme.border }}>
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
        </div>
      </div>
    </div>
  );
};
