# 站点配置

在仓库根目录放一个 `site.config.json`，可以改站名、简介、关键词、图标，以及书架顶栏和横幅的文案。没有这个文件时用默认值。

## 使用

1. 把 `site.config.example.json` 复制为 `site.config.json`。样板里的值就是默认值。
2. 改想改的字段，其余的可以删掉。
3. 把 `site.config.json` 提交进仓库，不要加进 `.gitignore`。

开发服务器会在这个文件变化时自动重启。

只改站名、隐藏副标题的最小示例：

```json
{
  "name": "我的书库",
  "tagline": ""
}
```

## 字段

| 字段 | 显示在哪 |
| --- | --- |
| `name` | 标签页标题、书架顶栏的站名 |
| `description` / `keywords` | 页面的 `<meta>` 标签，给搜索引擎看 |
| `favicon` | 标签页图标，也是书架顶栏左上角的图标 |
| `tagline` | 顶栏站名下面那行小字 |
| `banner.badge` | 横幅标题上方的小标签 |
| `banner.title` | 横幅大标题 |
| `banner.description` | 横幅标题下的说明 |
| `banner.countLabel` | 藏书数字下方的说明。数字按书库实际数量显示，不能配 |

## 规则

- 每个字段都可以不写，`banner` 里也可以只写其中几项。
- `tagline`、`banner.badge`、`banner.description` 写成 `""` 就不显示。`banner.title` 和 `banner.countLabel` 不能为空，空串会退回默认值并打提示。
- `favicon` 写路径时，文件必须在 `public/` 下，否则构建报错。也可以写 data URI 或完整网址。
- 文件不是合法 JSON 时，构建失败。单个字段写错（类型不对、键名拼错）只退回那个字段的默认值，并打提示。
