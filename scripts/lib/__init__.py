# -*- coding: utf-8 -*-
"""预处理管线的实现模块（design §4.1）。

按职责拆分，编排层 `scripts/preprocess.py` 只负责串起流程：

- `archive`    解压源文件，返回其中体积最大的 `.txt`
- `encoding`   BOM 嗅探 → 候选探测 → 全文 strict 试解 + 有效性校验，出口统一为 UTF-8 `str`
- `toc_rules`  具名章节规则表（纯数据）
- `toc`        规则择一评分、切分、卷标记、两级兜底、标题净化
- `toc_overrides` 按 `book_id` 点名规则的人工覆盖表（`scripts/toc-overrides.json`）
- `pinyin`     书名/作者的拼音首字母缩写
- `manifest`   SHA-256 增量清单与失效产物清理
- `validate`   `_toc.json` / `books.json` 的产物 schema 自校验
- `report`     逐本成败记录、`book_id` 消歧、批次汇总与容量护栏（退出码由它算出）

本包不做"缺依赖就降级"的可选导入（需求 7.7）；必需依赖由入口脚本统一前置检查。
"""
