"""把 tdx_server.py（内含 Bridge 与 HTTP/WS 服务）打成单文件可执行程序。

默认且只使用 Nuitka（编译为机器码，onefile 不携带 Python 源码）：
    python3 -m pip install -r requirements.txt
    python3 python/build.py

产物：
    python/dist/tdx-bridge        （Windows 是 tdx-bridge.exe）

产物不再用 stdio 与 Electron 通信：桌面壳带 `--serve` 拉起它，浏览器与
Electron 渲染层都通过同一个本地 HTTP/WebSocket 端口取数（同一套协议）。

electron-builder 会把 python/dist 整个目录复制到
resources/tdx-bridge/，主进程按这个路径拉起本地服务。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def sidecar_cache_tag() -> str:
    """macOS onefile 解包缓存键：Python 源码/connect.cfg/Nuitka 版本变则换目录。

    Nuitka 的 cached 模式会复用目录内容；不能只用应用版本号，否则同版本下改了
    Python 却复用旧 sidecar。这里对实际会被打进单文件的源码做指纹。
    """
    digest = hashlib.sha256()
    try:
        digest.update(package_version("Nuitka").encode("utf-8"))
    except PackageNotFoundError:
        digest.update(b"unknown-nuitka")

    # 协议层拆到 tdxproto/ 之后要递归取源码：sidecar 里编进去的每个 .py 都算指纹，
    # 否则改了子模块还复用旧缓存。tests/ 不参与打包，显式跳过。
    for path in sorted(ROOT.rglob("*.py")):
        rel = path.relative_to(ROOT)
        if rel.parts[0] in {"tests", "build", "dist"}:
            continue
        digest.update(rel.as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    digest.update((ROOT / "connect.cfg").read_bytes())
    digest.update((ROOT / "fixtures" / "tdx_holidays.json").read_bytes())
    return digest.hexdigest()[:16]


def patchelf_path() -> str | None:
    found = shutil.which("patchelf")
    if found:
        return found
    local = Path.home() / ".local" / "bin" / "patchelf"
    return str(local) if local.exists() else None


def build_nuitka() -> None:
    try:
        import nuitka  # noqa: F401
    except ImportError:
        print(
            "缺少 Nuitka：先运行 python3 -m pip install nuitka；"
            "Linux onefile 还需要 patchelf。",
            file=sys.stderr,
        )
        raise SystemExit(1)

    patchelf = patchelf_path()
    if sys.platform.startswith("linux") and not patchelf:
        print(
            "Nuitka standalone/onefile 需要 patchelf：\n"
            "  python3 -m pip install --user patchelf\n"
            "或通过系统包管理器安装，再重试。",
            file=sys.stderr,
        )
        raise SystemExit(1)

    env = os.environ.copy()
    if patchelf:
        env["PATH"] = f"{Path(patchelf).parent}{os.pathsep}{env.get('PATH', '')}"

    command = [
        sys.executable,
        "-m",
        "nuitka",
        "--onefile",
        "--remove-output",
        f"--output-dir={ROOT / 'dist'}",
        "--output-filename=tdx-bridge",
        "--assume-yes-for-downloads",
        # 核心 Parquet IO 走 DuckDB；pyarrow/pandas 只用于开发期数据分析与旧统计导出，
        # 不进入 sidecar，显式排除以控制编译时间和单文件体积。
        "--nofollow-import-to=pyarrow",
        "--nofollow-import-to=pandas",
        "--nofollow-import-to=matplotlib",
        "--nofollow-import-to=numba",
        "--nofollow-import-to=scipy",
        "--nofollow-import-to=pytest",
        "--nofollow-import-to=IPython",
        "--nofollow-import-to=tkinter",
        # 客户端解包的主站列表随 sidecar 一起分发，用户目录没有 connect.cfg 时仍可用。
        f"--include-data-files={ROOT / 'connect.cfg'}=connect.cfg",
        # TDX 官方节假日快照；sidecar 解包后与可执行文件同目录。
        f"--include-data-files={ROOT / 'fixtures' / 'tdx_holidays.json'}=tdx_holidays.json",
    ]

    # onefile 每次启动都解包约 90MB；48 个 worker 同时启动会把 CPU/磁盘打满，
    # 固定缓存目录后，后续 worker 复用同一份解包，启动不再线性变慢。
    cache_tag = sidecar_cache_tag()
    command.append(
        f"--onefile-tempdir-spec={{CACHE_DIR}}/pythontdx/tdx-bridge/{cache_tag}"
    )
    print(f"[build] onefile cache: {{CACHE_DIR}}/pythontdx/tdx-bridge/{cache_tag}")

    command.append(str(ROOT / "tdx_server.py"))
    print("[build] Nuitka:", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def main() -> None:
    build_nuitka()


if __name__ == "__main__":
    main()
