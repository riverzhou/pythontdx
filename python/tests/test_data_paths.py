"""数据目录迁移的离线测试。"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import data_paths


class TestDataPaths(unittest.TestCase):
    def test_migrates_legacy_home_and_keeps_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            legacy = base / "stocklens" / "data"
            legacy.mkdir(parents=True)
            (legacy / "server.json").write_text("{}", encoding="utf-8")
            with mock.patch.dict(os.environ, {"XDG_DATA_HOME": directory}, clear=False):
                os.environ.pop("PYTHONTDX_DATA_DIR", None)
                os.environ.pop("STOCKLENS_DATA_DIR", None)
                result = data_paths.data_dir()
            self.assertEqual(result, base / "pythontdx" / "data")
            self.assertTrue((result / "server.json").is_file())
            self.assertFalse((base / "stocklens").exists())

    def test_new_home_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "stocklens" / "data").mkdir(parents=True)
            (base / "stocklens" / "data" / "old").write_text("old", encoding="utf-8")
            new = base / "pythontdx" / "data"
            new.mkdir(parents=True)
            (new / "new").write_text("new", encoding="utf-8")
            with mock.patch.dict(os.environ, {"XDG_DATA_HOME": directory}, clear=False):
                os.environ.pop("PYTHONTDX_DATA_DIR", None)
                os.environ.pop("STOCKLENS_DATA_DIR", None)
                result = data_paths.data_dir()
            self.assertEqual(result, new)
            self.assertTrue((new / "new").is_file())
            self.assertTrue((base / "stocklens" / "data" / "old").is_file())

    def test_env_override_and_legacy_env_alias(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(
                os.environ, {"STOCKLENS_DATA_DIR": directory}, clear=False
            ):
                os.environ.pop("PYTHONTDX_DATA_DIR", None)
                self.assertEqual(data_paths.data_dir(), Path(directory))


if __name__ == "__main__":
    unittest.main()
