/**
 * 用途特征核对 `checkRoleFeature` 的例子测试（无浏览器，`tooling` 项目；test-data-desensitization
 * 需求 4.2，设计"需求 4.2 的特征核对"）。
 *
 * `e2e/support/library.ts` 的 `ROLE_FEATURES` 中有特征的 5 个用途各一正一反，共 10 例。正例与反例只差在
 * 特征所看的那一处，反例贴着特征的边界构造：
 *
 * | 用途 | 需求 4.2 | 正例 | 反例 |
 * | --- | --- | --- | --- |
 * | volumes | (a) | 卷节点前后各有 1 个非卷节点 | 卷节点只在书首与书末，各缺一侧的非卷节点 |
 * | leadingVolume | (d) | 第 2 个节点为卷节点 | 卷节点在第 3 个 |
 * | huge | (b) | 恰好 `HUGE_MIN_NODES` 个节点，其中 1 个为卷节点（卷节点也计入节点数） | 少 1 个非卷节点 |
 * | stars | (e) | 全部节点标题为 `STARS_TITLE` | 只有末个节点的标题不同；没有节点 |
 * | fallback | (f) | `fallback` 为 true | `fallback` 为 false；未设置 |
 *
 * 断言：
 *
 * - 正例：`role` 为被核对的用途，`feature` 为 `ROLE_FEATURES[role].label`，`ok` 为 true。
 * - 反例：`role`、`feature` 同正例，`ok` 为 false；`actual` 非空、与正例的 `actual` 不同，并写出差在
 *   哪里的那个取值（卷节点数、节点数、第 2 个节点或标题不同的那个节点的标题、`fallback` 的值）。只核对
 *   这个取值出现在 `actual` 中，不核对其余措辞。没有这样的取值时（没有节点、未设置 `fallback`）只核对
 *   前两条。
 *
 * 另有 1 例核对没有特征的 pinyin、longText、crlf 返回 null，且有特征的恰为上表 5 个用途，即上表覆盖了
 * `ROLE_FEATURES` 中的全部特征。
 *
 * `_toc.json` 片段全部由本文件现场构造，只写特征核对看的字段：`chapters` 各节点的 `title`、`isVolume`，
 * 以及 `fallback`。与预处理产物一样，`isVolume` 只在为真时写出。标题只用通用章节标记（`第1章`、
 * `第一卷`）与 `STARS_TITLE`。阈值与标题从 `library.ts` 导入，本文件不写它们的字面量，也不读取任何
 * 书库文件。
 */
import { expect, test } from "@playwright/test";
import {
  BOOK_ROLES,
  HUGE_MIN_NODES,
  ROLE_FEATURES,
  STARS_TITLE,
  checkRoleFeature,
  type BookRole,
  type RoleFeatureCheck,
  type TocShape,
} from "../../support/library";

/** 有特征的用途，按 `BOOK_ROLES` 的顺序。 */
const FEATURED_ROLES = [
  "volumes",
  "leadingVolume",
  "huge",
  "stars",
  "fallback",
] as const satisfies readonly BookRole[];

/** 没有特征的用途：`checkRoleFeature` 返回 null。 */
const FEATURELESS_ROLES = ["pinyin", "longText", "crlf"] as const satisfies readonly BookRole[];

type FeaturedRole = (typeof FEATURED_ROLES)[number];

/** `_toc.json` 片段的一个节点。 */
type TocNode = TocShape["chapters"][number];

// ---------------------------------------------------------------------------
// 片段
// ---------------------------------------------------------------------------

/** 非卷节点，标题为 `第<n>章`。与预处理产物一样不写 `isVolume`。 */
function chapter(n: number): TocNode {
  return { title: `第${n}章` };
}

/** `count` 个非卷节点，标题依次为 `第<from>章`、`第<from + 1>章`……。 */
function chapters(count: number, from = 1): TocNode[] {
  return Array.from({ length: count }, (_, i) => chapter(from + i));
}

/** 卷节点。 */
function volume(title: string): TocNode {
  return { title, isVolume: true };
}

/** `count` 个标题为 `STARS_TITLE` 的非卷节点。 */
function stars(count: number): TocNode[] {
  return Array.from({ length: count }, () => ({ title: STARS_TITLE }));
}

/** huge 的片段：共 `total` 个节点，首个为卷节点，其余为非卷节点。 */
function hugeNodes(total: number): TocNode[] {
  return [volume("第一卷"), ...chapters(total - 1)];
}

/** 各用途的正例片段。反例的 `actual` 须与对应正例的不同。 */
const POSITIVE: Readonly<Record<FeaturedRole, TocShape>> = {
  volumes: { chapters: [chapter(1), volume("第一卷"), chapter(2)] },
  leadingVolume: { chapters: [chapter(1), volume("第一卷"), chapter(2)] },
  huge: { chapters: hugeNodes(HUGE_MIN_NODES) },
  stars: { chapters: stars(3) },
  fallback: { chapters: [chapter(1)], fallback: true },
};

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

/** `ROLE_FEATURES` 中该用途的特征描述。 */
function labelOf(role: FeaturedRole): string {
  const feature = ROLE_FEATURES[role];
  if (feature === null) throw new Error(`ROLE_FEATURES.${role} 为 null，该用途应有特征`);
  return feature.label;
}

/** 核对有特征的用途；返回 null 即判失败。 */
function check(role: FeaturedRole, toc: TocShape): RoleFeatureCheck {
  const result = checkRoleFeature(role, toc);
  expect(result, `checkRoleFeature("${role}") 不应返回 null：该用途有特征`).not.toBeNull();
  return result as RoleFeatureCheck;
}

/**
 * 正例：`role` 与 `feature` 对得上，`ok` 为 true。`toMatchObject` 的差异里没有 `actual`，失败信息另行带上。
 */
function expectHas(role: FeaturedRole): void {
  const result = check(role, POSITIVE[role]);
  expect(result, `${role} 正例（actual：${result.actual}）`).toMatchObject({
    role,
    feature: labelOf(role),
    ok: true,
  });
}

/**
 * 反例：`role` 与 `feature` 同正例，`ok` 为 false；`actual` 非空、与正例的 `actual` 不同。给出 `shown` 时，
 * `actual` 还须含有它，即差在哪里的那个取值。
 */
function expectLacks(role: FeaturedRole, toc: TocShape, shown?: string): void {
  const result = check(role, toc);
  expect(result, `${role} 反例（actual：${result.actual}）`).toMatchObject({
    role,
    feature: labelOf(role),
    ok: false,
  });
  expect(result.actual, "actual 应写明实际情况").not.toBe("");
  expect(result.actual, "actual 应与正例的不同").not.toBe(check(role, POSITIVE[role]).actual);
  if (shown !== undefined) expect(result.actual, `actual 应写出 ${shown}`).toContain(shown);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("checkRoleFeature（test-data-desensitization 需求 4.2）", () => {
  test("4.2 volumes：卷节点前后各有 1 个非卷节点时具备特征", () => {
    expectHas("volumes");
  });

  test("4.2 volumes：卷节点只在书首与书末（各缺一侧的非卷节点）时不具备特征", () => {
    const nodes = [volume("第一卷"), ...chapters(2), volume("第二卷")];
    const volumeCount = nodes.filter((node) => node.isVolume === true).length;
    expectLacks("volumes", { chapters: nodes }, `${volumeCount} 个卷节点`);
  });

  test("4.2 leadingVolume：第 2 个节点为卷节点时具备特征", () => {
    expectHas("leadingVolume");
  });

  test("4.2 leadingVolume：卷节点在第 3 个（第 2 个节点不是卷节点）时不具备特征", () => {
    const nodes = [...chapters(2), volume("第一卷"), chapter(3)];
    expectLacks("leadingVolume", { chapters: nodes }, nodes[1].title);
  });

  test("4.2 huge：恰好 HUGE_MIN_NODES 个节点（其中 1 个为卷节点）时具备特征", () => {
    expect(POSITIVE.huge.chapters, "正例片段的节点数").toHaveLength(HUGE_MIN_NODES);
    expectHas("huge");
  });

  test("4.2 huge：比 HUGE_MIN_NODES 少 1 个节点时不具备特征", () => {
    const nodes = hugeNodes(HUGE_MIN_NODES - 1);
    expectLacks("huge", { chapters: nodes }, String(nodes.length));
  });

  test("4.2 stars：全部节点标题为 STARS_TITLE 时具备特征", () => {
    expectHas("stars");
  });

  test("4.2 stars：只有末个节点的标题不同，或没有节点时不具备特征", () => {
    const nodes = [...stars(2), chapter(3)];
    expectLacks("stars", { chapters: nodes }, nodes[2].title);
    expectLacks("stars", { chapters: [] });
  });

  test("4.2 fallback：fallback 为 true 时具备特征", () => {
    expectHas("fallback");
  });

  test("4.2 fallback：fallback 为 false 或未设置时不具备特征", () => {
    expectLacks("fallback", { chapters: [chapter(1)], fallback: false }, String(false));
    expectLacks("fallback", { chapters: [chapter(1)] });
  });

  test("4.2 pinyin、longText、crlf 没有特征：checkRoleFeature 返回 null，有特征的恰为其余 5 个用途", () => {
    expect(
      BOOK_ROLES.filter((role) => ROLE_FEATURES[role] !== null),
      "ROLE_FEATURES 中有特征的用途",
    ).toEqual([...FEATURED_ROLES]);
    for (const role of FEATURELESS_ROLES) {
      expect(checkRoleFeature(role, POSITIVE.volumes), role).toBeNull();
    }
  });
});
