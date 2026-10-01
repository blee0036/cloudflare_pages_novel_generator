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
  {
    // E2E 运行产物（App_Build、Fixture_Library、trace、HTML 报告等）不在检查范围内
    // （e2e-visual-testing 需求 2.6）
    ignores: ["e2e/.out/**"],
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
  {
    /**
     * E2E 套件（e2e-visual-testing 需求 2.4、2.7）：Playwright 用例、E2E_Server、启动器
     * `e2e/run.mjs` 与两个根配置文件都跑在 Node 上。只作用于这些文件，`src/`、`build/`
     * 的规则与全局变量不受影响。
     *
     * - js / typescript-eslint 的 recommended 由上方不带 `files` 的全局块作用于这里的
     *   全部文件；此处不再 `extends` 一遍，否则 typescript-eslint 的 eslint-recommended
     *   会连同 `run.mjs` 一起关掉 `no-undef`，而 `.mjs` 不经 tsc 检查，那是它唯一的
     *   未定义标识符检查。
     * - 未使用变量的判定与 `src/` 相同（`_` 前缀豁免），`.mjs` 也按同一口径。
     * - 关掉 react-hooks：Playwright fixture 的 `use` 回调会被 rules-of-hooks 误认成
     *   React 的 `use` Hook（`lib: async ({}, use) => { await use(x) }` 报错）。
     * - 放行参数位置的空对象解构：不依赖其他 fixture 的 fixture 必须写成 `async ({}, use)`，
     *   Playwright 靠解析首参的解构来识别依赖，换成普通参数名会在运行时报错。
     * - 禁止直接写 `test.step`（含 `test.step.skip`）：步骤一律经 `e2e/support/step.ts` 的
     *   `step()` 声明，它维护步骤栈，Run_Summary 才能写出失败或超时所处的步骤名（需求 6.9）。
     *   `step.ts` 自身由下一个块豁免。
     */
    files: ["e2e/**/*.{ts,mjs}", "playwright.config.ts", "vitest.config.ts"],
    languageOptions: { globals: globals.node },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
      "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
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
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='test'][property.name='step']",
          message:
            "不要直接写 test.step：请用 e2e/support/step.ts 的 step()，它记录失败与超时所处的步骤（需求 6.9）。",
        },
      ],
    },
  },
  {
    // `step()` 的实现本身要调用 `test.step`（需求 6.9）
    files: ["e2e/support/step.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
