# -*- coding: utf-8 -*-
"""预处理工具包。

把 `scripts/` 声明为常规包，使以下两种调用方式都成立：

- `python scripts/preprocess.py`（`package.json` 的 `npm run preprocess`）
- `python -m scripts.preprocess` / `python -m scripts.test_toc`（仓库根目录下，design §11 的夹具断言入口）

包内模块统一用 `scripts.lib.xxx` 绝对导入；直接以脚本方式运行的入口文件
（`preprocess.py`、`check_toc.py`）负责把仓库根目录放进 `sys.path`。
"""
