import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./utils/theme";
import "./index.css";

// 首屏绘制前把持久化的主题写到 <html data-theme>（需求 6.1/6.2，design §7.1）。
// 放在 render() 之前而不是某个组件的 effect 里：书架与阅读器两条路由都要生效，
// 且不能先绘制一帧默认配色再切过去。理由详见 utils/theme.ts。
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
