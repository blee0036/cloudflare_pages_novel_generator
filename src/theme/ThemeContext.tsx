import { createContext, useContext, useEffect, useMemo, useState } from "react";

type ThemeMode = "system" | "light" | "dark";
type ResolvedMode = "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedMode;
  setMode: (mode: ThemeMode) => void;
  cycleMode: () => void;
}

const STORAGE_KEY = "reader-theme";

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const getStoredMode = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "system";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
};

const getSystemMode = (): ResolvedMode => {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const applyTheme = (mode: ThemeMode, systemMode: ResolvedMode) => {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (mode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
  root.dataset.resolvedTheme = mode === "system" ? systemMode : mode;
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<ThemeMode>(() => getStoredMode());
  const [systemMode, setSystemMode] = useState<ResolvedMode>(() => getSystemMode());

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemMode(event.matches ? "dark" : "light");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (mode === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, mode);
    }
  }, [mode]);

  useEffect(() => {
    applyTheme(mode, systemMode);
  }, [mode, systemMode]);

  const value = useMemo<ThemeContextValue>(() => {
    const resolved = mode === "system" ? systemMode : mode;
    const cycleMode = () => {
      setMode((current) => {
        if (current === "system") return "light";
        if (current === "light") return "dark";
        return "system";
      });
    };
    return {
      mode,
      resolved,
      setMode,
      cycleMode,
    };
  }, [mode, systemMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
};
