from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

from rvx import _server
from rvx.cli import build_parser, daemon_main, execute, main, package_version
from scripts import package_assets


ROOT = Path(__file__).resolve().parents[1]


class AssetStagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.package = self.root / "src" / "rvx"
        self.package.mkdir(parents=True)
        self.binary = self.root / "rvxd"
        self.binary.write_bytes(b"\x7fELFfixture")
        self.binary.chmod(0o644)
        self.ui = self.root / "dist"
        (self.ui / "assets").mkdir(parents=True)
        (self.ui / "index.html").write_text('<script src="/assets/app.js"></script>')
        (self.ui / "assets" / "app.js").write_text("fixture")
        (self.ui / "login" / "assets").mkdir(parents=True)
        (self.ui / "login" / "index.html").write_text('<script src="/login/assets/login.js"></script>')
        (self.ui / "login" / "assets" / "login.js").write_text("login fixture")
        self.destination = patch.object(package_assets, "PACKAGE_ROOT", self.package)
        self.destination.start()
        self.addCleanup(self.destination.stop)

    def test_copies_both_assets_and_forces_executable_mode(self):
        binary, ui = package_assets.stage_assets(self.binary, self.ui)
        self.assertEqual(binary, self.package / "_bin" / "rvxd")
        self.assertEqual(binary.read_bytes(), self.binary.read_bytes())
        self.assertEqual(binary.stat().st_mode & 0o777, 0o755)
        self.assertEqual(ui, self.package / "_web")
        self.assertEqual((ui / "index.html").read_bytes(), (self.ui / "index.html").read_bytes())
        self.assertEqual((ui / "assets" / "app.js").read_text(), "fixture")
        self.assertEqual((ui / "login" / "assets" / "login.js").read_text(), "login fixture")

    def test_restage_prunes_only_obsolete_generated_ui_files(self):
        unrelated = self.package / "source.py"
        unrelated.write_text("do not change")
        _, ui = package_assets.stage_assets(self.binary, self.ui)
        (ui / "obsolete").mkdir()
        (ui / "obsolete" / "asset.js").write_text("old")
        (self.ui / "assets" / "app.js").unlink()
        (self.ui / "assets" / "new.js").write_text("new")
        package_assets.stage_assets(self.binary, self.ui)
        self.assertFalse((ui / "obsolete").exists())
        self.assertFalse((ui / "assets" / "app.js").exists())
        self.assertEqual((ui / "assets" / "new.js").read_text(), "new")
        self.assertEqual(unrelated.read_text(), "do not change")

    def test_invalid_inputs_fail_before_existing_assets_are_changed(self):
        binary, ui = package_assets.stage_assets(self.binary, self.ui)
        self.binary.write_text("not a native binary")
        with self.assertRaisesRegex(ValueError, "ELF or Mach-O"):
            package_assets.stage_assets(self.binary, self.ui)
        self.assertEqual(binary.read_bytes(), b"\x7fELFfixture")
        self.binary.write_bytes(b"\xcf\xfa\xed\xfemach-o")
        (self.ui / "index.html").unlink()
        with self.assertRaisesRegex(ValueError, "index.html"):
            package_assets.stage_assets(self.binary, self.ui)
        self.assertTrue((ui / "index.html").is_file())
        self.assertEqual(binary.read_bytes(), b"\x7fELFfixture")

    def test_ui_without_assets_is_not_a_complete_build(self):
        (self.ui / "assets" / "app.js").unlink()
        with self.assertRaisesRegex(ValueError, "nonempty built assets"):
            package_assets.stage_assets(self.binary, self.ui)
        self.assertFalse((self.package / "_bin").exists())

    def test_login_entry_and_assets_are_required_before_staging(self):
        for missing in (self.ui / "login" / "index.html", self.ui / "login" / "assets" / "login.js"):
            content = missing.read_bytes()
            missing.unlink()
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, "login"):
                package_assets.stage_assets(self.binary, self.ui)
            self.assertFalse((self.package / "_bin").exists())
            missing.write_bytes(content)

    def test_rejects_symlink_inputs_and_destinations_without_touching_targets(self):
        marker = self.root / "marker"
        marker.write_text("unchanged")
        (self.ui / "assets" / "link").symlink_to(marker)
        with self.assertRaisesRegex(ValueError, "not links"):
            package_assets.stage_assets(self.binary, self.ui)
        (self.ui / "assets" / "link").unlink()
        (self.package / "_web").symlink_to(self.ui, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink staging"):
            package_assets.stage_assets(self.binary, self.ui)
        self.assertEqual(marker.read_text(), "unchanged")

    def test_rejects_overlapping_input_and_staging(self):
        binary, ui = package_assets.stage_assets(self.binary, self.ui)
        for source_binary, source_ui in ((binary, self.ui), (self.binary, ui)):
            with self.subTest(binary=source_binary, ui=source_ui):
                with self.assertRaisesRegex(ValueError, "overlap"):
                    package_assets.stage_assets(source_binary, source_ui)
        self.assertEqual(binary.read_bytes(), b"\x7fELFfixture")


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.package = self.root / "installed" / "rvx"
        self.binary = self.package / "_bin" / "rvxd"
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b"\x7fELFfixture")
        self.binary.chmod(0o755)
        self.ui = self.package / "_web"
        (self.ui / "assets").mkdir(parents=True)
        (self.ui / "index.html").write_text("built UI")
        (self.ui / "assets" / "app.js").write_text("built asset")
        (self.ui / "login" / "assets").mkdir(parents=True)
        (self.ui / "login" / "index.html").write_text("built login")
        (self.ui / "login" / "assets" / "login.js").write_text("built login asset")
        self.location = patch.object(_server, "__file__", str(self.package / "_server.py"))
        self.location.start()
        self.addCleanup(self.location.stop)

    def test_defaults_use_installed_resources_and_preserve_native_defaults(self):
        with patch("rvx._server.os.execv") as replace:
            execute(build_parser().parse_args(["serve", "--data-dir", str(self.root / "data")]))
        replace.assert_called_once_with(str(self.binary), [
            str(self.binary), "--data-dir", str(self.root / "data"), "--ui-dir", str(self.ui),
        ])

    def test_all_explicit_options_are_forwarded_without_shell_parsing(self):
        custom = self.root / "custom UI"
        custom.mkdir()
        (custom / "index.html").write_text("custom")
        with patch("rvx._server.os.execv") as replace:
            execute(build_parser().parse_args([
                "serve", "--data-dir", str(self.root / "data with spaces"),
                "--listen", "127.0.0.1:0", "--ui-dir", str(custom),
                "--scrape-concurrency", "3",
            ]))
        self.assertEqual(replace.call_args.args[1], [
            str(self.binary), "--data-dir", str(self.root / "data with spaces"),
            "--ui-dir", str(custom), "--listen", "127.0.0.1:0",
            "--scrape-concurrency", "3",
        ])

    def test_missing_binary_and_ui_report_complete_rebuild_instructions(self):
        for missing in (self.binary, self.ui / "index.html", self.ui / "assets" / "app.js",
                        self.ui / "login" / "index.html", self.ui / "login" / "assets" / "login.js"):
            content = missing.read_bytes()
            mode = missing.stat().st_mode
            missing.unlink()
            with self.subTest(missing=missing), patch("rvx._server.os.execv") as replace:
                with redirect_stderr(io.StringIO()) as error:
                    self.assertEqual(main(["serve", "--data-dir", str(self.root / "data")]), 1)
                self.assertIn("missing", error.getvalue())
                self.assertIn("scripts/package_assets.py", error.getvalue())
                self.assertIn("maturin", error.getvalue())
                replace.assert_not_called()
            missing.write_bytes(content)
            missing.chmod(mode)

    def test_nonexecutable_binary_and_exec_errors_are_actionable(self):
        self.binary.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "not executable"):
            _server.serve(data_dir="unused")
        self.binary.chmod(0o755)
        with patch("rvx._server.os.execv", side_effect=OSError("wrong architecture")):
            with self.assertRaisesRegex(RuntimeError, "wrong architecture.*Reinstall"):
                _server.serve(data_dir="unused")

    def test_custom_ui_overrides_a_missing_bundle_and_is_validated(self):
        (self.ui / "index.html").unlink()
        custom = self.root / "custom"
        custom.mkdir()
        with self.assertRaisesRegex(RuntimeError, "--ui-dir must contain"):
            _server.serve(data_dir="unused", ui_dir=str(custom))
        (custom / "index.html").write_text("custom")
        with patch("rvx._server.os.execv") as replace:
            _server.serve(data_dir="unused", ui_dir=str(custom))
        self.assertEqual(replace.call_args.args[1][-2:], ["--ui-dir", str(custom)])

    def test_required_data_dir_and_daemon_alias(self):
        for entry, args in ((main, ["serve"]), (daemon_main, [])):
            with self.subTest(entry=entry), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    entry(args)
                self.assertEqual(error.exception.code, 2)
        with patch("rvx._server.os.execv") as replace:
            self.assertEqual(daemon_main(["--data-dir", str(self.root / "data")]), 0)
        self.assertEqual(replace.call_args.args[0], str(self.binary))

    def test_versions_do_not_need_packaged_assets_or_native_imports(self):
        self.binary.unlink()
        for entry, args, prefix in (
            (main, ["--version"], "rvx"), (main, ["serve", "--version"], "rvx serve"),
            (daemon_main, ["--version"], "rvxd"),
        ):
            with self.subTest(args=args), redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as exit:
                    entry(args)
                self.assertEqual(exit.exception.code, 0)
            self.assertEqual(output.getvalue().strip(), f"{prefix} {package_version()}")

    def test_import_and_control_help_do_not_load_the_extension_or_server(self):
        result = subprocess.run(
            [sys.executable, "-I", "-c", (
                "import sys; import rvx; from rvx.cli import build_parser; "
                "assert callable(rvx.Source); build_parser().parse_args(['status']); "
                "assert 'rvx._native' not in sys.modules; "
                "assert 'rvx._server' not in sys.modules"
            )],
            cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class PackageMetadataTests(unittest.TestCase):
    def test_single_distribution_uses_internal_abi3_and_resource_mapping(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        cargo = tomllib.loads((ROOT / "Cargo.toml").read_text())
        extension = tomllib.loads((ROOT / "rust/rvx-python/Cargo.toml").read_text())
        self.assertEqual(project["build-system"]["build-backend"], "maturin")
        self.assertEqual(project["project"]["name"], "rvx")
        self.assertEqual(project["project"]["version"], cargo["workspace"]["package"]["version"])
        self.assertEqual(project["project"]["authors"], [{"name": "hspk"}])
        self.assertEqual(project["project"]["dependencies"], [])
        self.assertNotIn("sources", project["tool"]["uv"])
        self.assertFalse((ROOT / "rust/rvx-python/pyproject.toml").exists())
        self.assertEqual(extension["lib"]["name"], "_native")
        maturin = project["tool"]["maturin"]
        self.assertEqual(maturin["module-name"], "rvx._native")
        self.assertEqual(maturin["python-source"], "src")
        self.assertEqual(maturin["include"], [
            {"path": "rvx/_bin/rvxd", "format": "wheel"},
            {"path": "rvx/_web/**/*", "format": "wheel"},
        ])
        self.assertIn("abi3-py311", cargo["workspace"]["dependencies"]["pyo3"]["features"])
        cache = project["tool"]["uv"]["cache-keys"]
        for pattern in ("Cargo.lock", "rust/**/*.rs", "src/rvx/**/*.py", "src/rvx/_bin/rvxd"):
            self.assertIn({"file": pattern}, cache)


if __name__ == "__main__":
    unittest.main()
