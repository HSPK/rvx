from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

from scripts.check_wheel import check_glibc, check_wheel
from scripts.release_version import release_version


class ReleaseContractTests(unittest.TestCase):
    def test_tag_matches_both_package_versions(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            (root / "pyproject.toml").write_text('[project]\nname="rvx"\nversion="0.1.0"\n')
            (root / "Cargo.toml").write_text('[workspace.package]\nversion="0.1.0"\n')
            self.assertEqual(release_version(root, "refs/heads/main"), "0.1.0")
            self.assertEqual(release_version(root, "refs/tags/v0.1.0"), "0.1.0")
            for reference in ("refs/tags/v0.2.0", "refs/tags/not-a-version"):
                with self.subTest(reference=reference), self.assertRaises(ValueError):
                    release_version(root, reference)
            (root / "Cargo.toml").write_text('[workspace.package]\nversion="0.2.0"\n')
            with self.assertRaises(ValueError):
                release_version(root, "refs/heads/main")

    def fixture_wheel(self, directory, *, omitted=(), executable=True, dependency=""):
        path = Path(directory) / "rvx-0.1.0-cp311-abi3-macosx_11_0_arm64.whl"
        files = {
            "rvx/__init__.py": "",
            "rvx/source.py": "",
            "rvx/adapters.py": "",
            "rvx/cli.py": "",
            "rvx/_native.abi3.so": "test-extension-placeholder",
            "rvx/_bin/rvxd": "test-executable-placeholder",
            "rvx/_web/index.html": '<script src="/assets/app.js"></script>',
            "rvx/_web/assets/app.js": "test-ui",
            "rvx/_web/login/index.html": '<script src="/login/assets/login.js"></script>',
            "rvx/_web/login/assets/login.js": "test-login-ui",
            "rvx-0.1.0.dist-info/METADATA": (
                "Metadata-Version: 2.4\nName: rvx\nVersion: 0.1.0\n"
                + (f"Requires-Dist: {dependency}\n" if dependency else "")
            ),
            "rvx-0.1.0.dist-info/WHEEL": (
                "Wheel-Version: 1.0\nRoot-Is-Purelib: false\n"
                "Tag: cp311-abi3-macosx_11_0_arm64\n"
            ),
        }
        with ZipFile(path, "w") as archive:
            for name, content in files.items():
                if name in omitted:
                    continue
                info = ZipInfo(name)
                info.external_attr = (0o100755 if executable and name.endswith("/rvxd") else 0o100644) << 16
                archive.writestr(info, content)
        return path

    def test_complete_wheel_contract_rejects_missing_runtime_assets(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = self.fixture_wheel(directory)
            check_wheel(path, "0.1.0", "macosx_11_0_arm64")
            for omitted in (
                ("rvx/_bin/rvxd",), ("rvx/_web/index.html",),
                ("rvx/_web/assets/app.js",), ("rvx/_native.abi3.so",),
                ("rvx/_web/login/index.html",), ("rvx/_web/login/assets/login.js",),
            ):
                with self.subTest(omitted=omitted):
                    path = self.fixture_wheel(directory, omitted=omitted)
                    with self.assertRaises(ValueError):
                        check_wheel(path, "0.1.0", None)

    def test_executable_modes_native_dependency_and_platform_are_enforced(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            for options in (
                {"executable": False}, {"dependency": "rvx-native==0.1.0"},
            ):
                with self.subTest(options=options):
                    path = self.fixture_wheel(directory, **options)
                    with self.assertRaises(ValueError):
                        check_wheel(path, "0.1.0", None)
            path = self.fixture_wheel(directory)
            with self.assertRaises(ValueError):
                check_wheel(path, "0.1.0", "macosx_11_0_x86_64")
            wrong = path.with_name("rvx-0.1.0-py3-none-any.whl")
            path.rename(wrong)
            with self.assertRaises(ValueError):
                check_wheel(wrong, "0.1.0", None)

    def test_bundled_executable_cannot_exceed_declared_glibc(self):
        with patch("scripts.check_wheel.subprocess.run") as inspect:
            inspect.return_value.stdout = "Name: GLIBC_2.2.5\nName: GLIBC_2.28\n"
            check_glibc(b"fixture")
            inspect.return_value.stdout = "Name: GLIBC_2.34\n"
            with self.assertRaises(ValueError):
                check_glibc(b"fixture")
