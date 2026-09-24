from __future__ import annotations

from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

from scripts import package_assets


ROOT = Path(__file__).resolve().parents[1]


class AssetStagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.cli = self.root / "rvx"
        self.daemon = self.root / "rvxd"
        for binary in (self.cli, self.daemon):
            binary.write_bytes(b"\x7fELFfixture")
            binary.chmod(0o644)
        self.ui = self.root / "dist"
        (self.ui / "assets").mkdir(parents=True)
        (self.ui / "index.html").write_text('<script src="/assets/app.js"></script>')
        (self.ui / "assets" / "app.js").write_text("fixture")
        (self.ui / "login" / "assets").mkdir(parents=True)
        (self.ui / "login" / "index.html").write_text(
            '<script src="/login/assets/login.js"></script>'
        )
        (self.ui / "login" / "assets" / "login.js").write_text("login fixture")
        self.data = self.root / "rvx.data"
        destination = patch.object(package_assets, "WHEEL_DATA_ROOT", self.data)
        destination.start()
        self.addCleanup(destination.stop)

    def test_stages_native_scripts_and_shared_web_data(self):
        cli, daemon, ui = package_assets.stage_assets(self.cli, self.daemon, self.ui)
        self.assertEqual(cli, self.data / "scripts" / "rvx")
        self.assertEqual(daemon, self.data / "scripts" / "rvxd")
        self.assertEqual(ui, self.data / "data" / "share" / "rvx" / "web")
        self.assertEqual(cli.read_bytes(), self.cli.read_bytes())
        self.assertEqual(daemon.read_bytes(), self.daemon.read_bytes())
        self.assertEqual(cli.stat().st_mode & 0o777, 0o755)
        self.assertEqual(daemon.stat().st_mode & 0o777, 0o755)
        self.assertEqual((ui / "assets" / "app.js").read_text(), "fixture")
        self.assertEqual((ui / "login" / "assets" / "login.js").read_text(), "login fixture")

    def test_restage_prunes_obsolete_web_files(self):
        _, _, ui = package_assets.stage_assets(self.cli, self.daemon, self.ui)
        (ui / "obsolete.js").write_text("old")
        (self.ui / "assets" / "app.js").unlink()
        (self.ui / "assets" / "new.js").write_text("new")
        package_assets.stage_assets(self.cli, self.daemon, self.ui)
        self.assertFalse((ui / "obsolete.js").exists())
        self.assertFalse((ui / "assets" / "app.js").exists())
        self.assertEqual((ui / "assets" / "new.js").read_text(), "new")

    def test_rejects_invalid_binaries_ui_and_overlaps(self):
        self.cli.write_text("not native")
        with self.assertRaisesRegex(ValueError, "ELF or Mach-O"):
            package_assets.stage_assets(self.cli, self.daemon, self.ui)
        self.cli.write_bytes(b"\x7fELFfixture")
        (self.ui / "index.html").unlink()
        with self.assertRaisesRegex(ValueError, "index.html"):
            package_assets.stage_assets(self.cli, self.daemon, self.ui)
        (self.ui / "index.html").write_text("fixture")
        with self.assertRaisesRegex(ValueError, "distinct"):
            package_assets.stage_assets(self.cli, self.cli, self.ui)

    def test_rejects_symlink_inputs_and_destinations(self):
        marker = self.root / "marker"
        marker.write_text("unchanged")
        (self.ui / "assets" / "link").symlink_to(marker)
        with self.assertRaisesRegex(ValueError, "not links"):
            package_assets.stage_assets(self.cli, self.daemon, self.ui)
        (self.ui / "assets" / "link").unlink()
        self.data.symlink_to(self.ui, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink staging"):
            package_assets.stage_assets(self.cli, self.daemon, self.ui)
        self.assertEqual(marker.read_text(), "unchanged")


class PackageMetadataTests(unittest.TestCase):
    def test_python_distribution_contains_only_sdk_runtime(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        cargo = tomllib.loads((ROOT / "Cargo.toml").read_text())
        extension = tomllib.loads((ROOT / "rust/rvx-python/Cargo.toml").read_text())
        self.assertNotIn("scripts", project["project"])
        self.assertEqual(project["tool"]["maturin"]["data"], "rvx.data")
        self.assertEqual(project["tool"]["maturin"]["module-name"], "rvx._native")
        self.assertEqual(project["tool"]["maturin"]["python-source"], "src")
        self.assertEqual(project["project"]["version"], cargo["workspace"]["package"]["version"])
        self.assertIn("rust/rvx-cli", cargo["workspace"]["members"])
        self.assertIn("rust/rvx-config", cargo["workspace"]["members"])
        self.assertIn("rust/rvx-tracker", cargo["workspace"]["members"])
        self.assertEqual(extension["lib"]["name"], "_native")
        self.assertEqual(
            {path.name for path in (ROOT / "src" / "rvx").glob("*.py")},
            {
                "__init__.py",
                "_tracker_span.py",
                "_tracker_values.py",
                "adapters.py",
                "config.py",
                "errors.py",
                "service.py",
                "source.py",
                "tracker.py",
            },
        )
        for removed in ("cli.py", "tui.py", "_server.py", "__main__.py"):
            self.assertFalse((ROOT / "src" / "rvx" / removed).exists())

    def test_cache_tracks_native_cli_and_wheel_data(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        cache = project["tool"]["uv"]["cache-keys"]
        for pattern in (
            "Cargo.lock",
            "rust/**/*.rs",
            "rust/rvx-cli/**/*.rs",
            "rust/rvx-config/**/*.rs",
            "rust/rvx-tracker/**/*.rs",
            "rvx.data/scripts/rvx",
            "rvx.data/scripts/rvxd",
            "rvx.data/data/share/rvx/web/**/*",
        ):
            self.assertIn({"file": pattern}, cache)


if __name__ == "__main__":
    unittest.main()
