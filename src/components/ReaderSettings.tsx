import { useState } from "react";
import { createPortal } from "react-dom";
import type { ReaderSettings as Settings } from "../utils/readerSettings";
import { PRESETS } from "../utils/readerSettings";

interface ReaderSettingsProps {
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  onClose: () => void;
}

const FONT_FAMILIES = [
  { label: "系统默认", value: "system-ui, -apple-system, sans-serif" },
  { label: "宋体", value: "SimSun, STSong, serif" },
  { label: "黑体", value: "SimHei, STHeiti, sans-serif" },
  { label: "楷体", value: "KaiTi, STKaiti, serif" },
  { label: "微软雅黑", value: "Microsoft YaHei, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times", value: "Times New Roman, serif" },
];

export const ReaderSettings: React.FC<ReaderSettingsProps> = ({ settings, onSettingsChange, onClose }) => {
  const [localSettings, setLocalSettings] = useState<Settings>(settings);

  const handleChange = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const updated = { ...localSettings, [key]: value };
    setLocalSettings(updated);
    onSettingsChange(updated);
  };

  const applyPreset = (presetKey: string) => {
    const preset = PRESETS[presetKey];
    if (preset) {
      setLocalSettings(preset);
      onSettingsChange(preset);
    }
  };

  const panelContent = (
    <div className="reader-settings-overlay" onClick={onClose}>
      <div className="reader-settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="reader-settings-header">
          <h3>阅读设置</h3>
          <button type="button" onClick={onClose} className="reader-settings-close" aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="reader-settings-content">
          {/* 预设主题 */}
          <div className="reader-settings-group">
            <label className="reader-settings-label">预设主题</label>
            <div className="reader-settings-presets">
              {Object.entries(PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  className="reader-preset-button"
                  onClick={() => applyPreset(key)}
                  style={{
                    backgroundColor: preset.backgroundColor,
                    color: preset.textColor,
                  }}
                >
                  {key === "default" && "默认"}
                  {key === "comfortable" && "舒适"}
                  {key === "night" && "夜间"}
                  {key === "paper" && "纸质"}
                  {key === "eyecare" && "护眼"}
                </button>
              ))}
            </div>
          </div>

          {/* 字号 */}
          <div className="reader-settings-group">
            <label className="reader-settings-label">
              字号: {localSettings.fontSize}px
            </label>
            <input
              type="range"
              min="14"
              max="32"
              step="1"
              value={localSettings.fontSize}
              onChange={(e) => handleChange("fontSize", Number(e.target.value))}
              className="reader-settings-slider"
            />
          </div>

          {/* 行高 */}
          <div className="reader-settings-group">
            <label className="reader-settings-label">
              行高: {localSettings.lineHeight.toFixed(1)}
            </label>
            <input
              type="range"
              min="1.0"
              max="3.0"
              step="0.1"
              value={localSettings.lineHeight}
              onChange={(e) => handleChange("lineHeight", Number(e.target.value))}
              className="reader-settings-slider"
            />
          </div>

          {/* 字间距 */}
          <div className="reader-settings-group">
            <label className="reader-settings-label">
              字间距: {localSettings.letterSpacing}px
            </label>
            <input
              type="range"
              min="0"
              max="5"
              step="0.5"
              value={localSettings.letterSpacing}
              onChange={(e) => handleChange("letterSpacing", Number(e.target.value))}
              className="reader-settings-slider"
            />
          </div>

          {/* 字体 */}
          <div className="reader-settings-group">
            <label className="reader-settings-label">字体</label>
            <select
              value={localSettings.fontFamily}
              onChange={(e) => handleChange("fontFamily", e.target.value)}
              className="reader-settings-select"
            >
              {FONT_FAMILIES.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </div>

          {/* 背景色 */}
          <div className="reader-settings-group">
            <label className="reader-settings-label">背景色</label>
            <div className="reader-settings-color-group">
              <input
                type="color"
                value={localSettings.backgroundColor === "auto" ? "#ffffff" : localSettings.backgroundColor}
                onChange={(e) => handleChange("backgroundColor", e.target.value)}
                className="reader-settings-color"
                disabled={localSettings.backgroundColor === "auto"}
              />
              <input
                type="text"
                value={localSettings.backgroundColor}
                onChange={(e) => handleChange("backgroundColor", e.target.value)}
                className="reader-settings-color-text"
                placeholder="auto 或 #ffffff"
              />
            </div>
          </div>

          {/* 文字颜色 */}
          <div className="reader-settings-group">
            <label className="reader-settings-label">文字颜色</label>
            <div className="reader-settings-color-group">
              <input
                type="color"
                value={localSettings.textColor === "auto" ? "#000000" : localSettings.textColor}
                onChange={(e) => handleChange("textColor", e.target.value)}
                className="reader-settings-color"
                disabled={localSettings.textColor === "auto"}
              />
              <input
                type="text"
                value={localSettings.textColor}
                onChange={(e) => handleChange("textColor", e.target.value)}
                className="reader-settings-color-text"
                placeholder="auto 或 #000000"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  
  return createPortal(panelContent, document.body);
};
