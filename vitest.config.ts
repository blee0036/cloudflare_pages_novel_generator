import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

/**
 * Vitest 配置（e2e-visual-testing 需求 2.1、2.6）。
 *
 * Vitest 一旦发现本文件就不再读取 `vite.config.ts`，所以这里把它整份合并进来：
 * 原有的 `define`（`__SITE_CONFIG__`）与插件照旧生效，单测的运行环境与改动前相同。
 * 唯一的差别是排除 `e2e/**`：那里是 Playwright 的用例（`*.spec.ts`，会被 Vitest 的
 * 默认 include 误收）与运行产物（`e2e/.out/`），两套测试互不串收。
 *
 * `vite.config.ts` 经 `loadConfigFromFile` 在运行时读入，而不是 `import` 进来：静态导入会把
 * 它拉进 `npm run typecheck` 的程序，而它用到的 `new Error(msg, { cause })` 需要 ES2022 的
 * lib，本 spec 既不改 `vite.config.ts` 也不改 `compilerOptions`（需求 2.7、16.1）。
 */
export default defineConfig(async (env) => {
  const viteConfigFile = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
  const loaded = await loadConfigFromFile(env, viteConfigFile);
  if (loaded === null) {
    throw new Error(`无法读取 ${viteConfigFile}`);
  }
  return mergeConfig(
    loaded.config,
    defineConfig({
      test: {
        exclude: [...configDefaults.exclude, "e2e/**"],
      },
    }),
  );
});
