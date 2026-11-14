"""Python 测试包。

为什么是包（有 `__init__.py`）：`npm run test:python` 用
`python -m unittest discover -s python`，unittest 只递归进「包」目录；
把目录标记为包之后，顶层目录 `python/` 会被插进 `sys.path`，
测试里仍然可以直接 `import tdx_bridge`，与源码平铺的布局保持一致。

约定：
- 一个源码模块一个 `test_<模块名>.py`；
- 报文类用例一律读 `python/fixtures/`，不要在测试里内联长 hex。
"""
