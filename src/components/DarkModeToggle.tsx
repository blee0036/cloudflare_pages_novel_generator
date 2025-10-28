import { useTheme } from "../theme";

export const DarkModeToggle: React.FC = () => {
  const { mode, resolved, cycleMode } = useTheme();

  const label = mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色";
  const state = resolved === "dark" ? "夜间" : "日间";

  return (
    <button type="button" className="theme-toggle" onClick={cycleMode} aria-label="切换主题">
      <strong>{state}</strong>
      <span>{label}</span>
    </button>
  );
};
