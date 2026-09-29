import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * ESLint 扁平配置（Requirements 1.6）。
 *
 * 目标只有两条：
 *  1. 未使用的变量 / 导入必须报错（配合 tsconfig 的 noUnusedLocals 形成双保险）；
 *  2. React Hooks 的依赖与调用规则必须被检查（用于拦住 ReaderPage 那类 effect 依赖缺失）。
 *
 * react-hooks 只显式启用两条经典规则，不整体引入 recommended——v6+ 的 recommended
 * 附带了面向 React 19 / React Compiler 的规则集，本项目为 React 18，噪声大于收益。
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/**",
      "koodo-reader/**",
      "legado/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // 构建期配置文件跑在 Node 上
    files: ["*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
