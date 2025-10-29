/**
 * 阅读器设置工具
 */

export interface ReaderSettings {
  fontSize: number; // px
  lineHeight: number; // 倍数
  letterSpacing: number; // px
  fontFamily: string;
  backgroundColor: string;
  textColor: string;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.8,
  letterSpacing: 0,
  fontFamily: "system-ui, -apple-system, sans-serif",
  backgroundColor: "auto",
  textColor: "auto",
};

export const PRESETS: Record<string, ReaderSettings> = {
  default: {
    fontSize: 18,
    lineHeight: 1.8,
    letterSpacing: 0,
    fontFamily: "system-ui, -apple-system, sans-serif",
    backgroundColor: "auto",
    textColor: "auto",
  },
  comfortable: {
    fontSize: 20,
    lineHeight: 2.0,
    letterSpacing: 0.5,
    fontFamily: "system-ui, -apple-system, sans-serif",
    backgroundColor: "#f9fafb",
    textColor: "#1f2937",
  },
  night: {
    fontSize: 18,
    lineHeight: 1.8,
    letterSpacing: 0,
    fontFamily: "system-ui, -apple-system, sans-serif",
    backgroundColor: "#1e1e1e",
    textColor: "#d4d4d4",
  },
  paper: {
    fontSize: 18,
    lineHeight: 2.0,
    letterSpacing: 0.3,
    fontFamily: "Georgia, serif",
    backgroundColor: "#f5f1e8",
    textColor: "#3b3226",
  },
  eyecare: {
    fontSize: 19,
    lineHeight: 1.9,
    letterSpacing: 0.2,
    fontFamily: "system-ui, -apple-system, sans-serif",
    backgroundColor: "#c7edcc",
    textColor: "#2d3e2f",
  },
};

const STORAGE_KEY = "reader_settings";

export function loadSettings(): ReaderSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (error) {
    console.warn("Failed to load reader settings:", error);
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Failed to save reader settings:", error);
  }
}

export function applySettings(settings: ReaderSettings, element: HTMLElement): void {
  element.style.fontSize = `${settings.fontSize}px`;
  element.style.lineHeight = String(settings.lineHeight);
  element.style.letterSpacing = `${settings.letterSpacing}px`;
  element.style.fontFamily = settings.fontFamily;
  
  // "auto" 表示使用CSS变量（跟随全局主题）
  if (settings.backgroundColor === "auto") {
    element.style.backgroundColor = "";
  } else {
    element.style.backgroundColor = settings.backgroundColor;
  }
  
  if (settings.textColor === "auto") {
    element.style.color = "";
  } else {
    element.style.color = settings.textColor;
  }
}
