from __future__ import annotations

import argparse
from email import message_from_bytes
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
from zipfile import ZipFile


def check_wheel(path: Path, version: str, platform: str | None) -> None:
    """Reject SDK-only, wrongly tagged, or externally dependent release artifacts."""
    if not path.name.startswith(f"rvx-{version}-cp311-abi3-") or path.suffix != ".whl":
        raise ValueError("wheel filename must match the rvx version and cp311-abi3 contract")
    with ZipFile(path) as archive:
        names = set(archive.namelist())
        required = {
            "rvx/__init__.py", "rvx/source.py", "rvx/adapters.py", "rvx/cli.py",
            "rvx/_bin/rvxd", "rvx/_web/index.html",
            f"rvx-{version}.dist-info/METADATA", f"rvx-{version}.dist-info/WHEEL",
        }
        if missing := required - names:
            raise ValueError(f"{path.name}: incomplete wheel: {sorted(missing)}")
        if not any(name.startswith("rvx/_native.") and name.endswith(".so") for name in names):
            raise ValueError("compiled rvx._native extension is missing")
        if any(PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts for name in names):
            raise ValueError("wheel contains unsafe paths")
        if any(name.startswith(("ryx/", "rvx_native/", "ryx_native/")) for name in names):
            raise ValueError("wheel contains a retired package namespace")
        metadata = message_from_bytes(archive.read(f"rvx-{version}.dist-info/METADATA"))
        if metadata["Name"] != "rvx" or metadata["Version"] != version:
            raise ValueError("wheel name/version differs from release metadata")
        for dependency in metadata.get_all("Requires-Dist", []):
            if dependency.lower().startswith(("rvx-native", "ryx-native")):
                raise ValueError("native code must be internal, not a separate PyPI dependency")
        wheel = message_from_bytes(archive.read(f"rvx-{version}.dist-info/WHEEL"))
        tags = wheel.get_all("Tag", [])
        if wheel["Root-Is-Purelib"] != "false" or not tags or any("-abi3-" not in tag for tag in tags):
            raise ValueError("release requires a platform-specific abi3 wheel")
        if platform and not any(tag.endswith("-" + platform) for tag in tags):
            raise ValueError(f"expected platform {platform}, got {tags}")
        if platform and platform not in path.stem.split("-")[-1].split("."):
            raise ValueError("wheel filename does not carry the expected platform tag")
        binary = archive.getinfo("rvx/_bin/rvxd")
        if not stat.S_IMODE(binary.external_attr >> 16) & 0o111:
            raise ValueError("bundled rvxd is not executable")
        html = archive.read("rvx/_web/index.html").decode("utf-8")
        assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)
        if not assets or any("rvx/_web" + asset not in names for asset in assets):
            raise ValueError("bundled UI references missing assets")
        if platform and platform.startswith("manylinux_2_28_"):
            check_glibc(archive.read("rvx/_bin/rvxd"))
    print(f"Complete RVX wheel: {path.name}")


def check_glibc(binary: bytes) -> None:
    """Audit the bundled executable too, which extension-only wheel repair can miss."""
    with tempfile.TemporaryDirectory(prefix="rvx-elf-") as directory:
        path = Path(directory) / "rvxd"
        path.write_bytes(binary)
        result = subprocess.run(
            ["readelf", "--version-info", str(path)], check=True, capture_output=True, text=True,
        )
    versions = [
        tuple(int(component) for component in version.split("."))
        for version in re.findall(r"Name: GLIBC_([0-9.]+)", result.stdout)
    ]
    if not versions or max(versions) > (2, 28):
        raise ValueError(f"rvxd exceeds the manylinux_2_28 glibc contract: {versions}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Validate complete RVX wheel contents.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform")
    parser.add_argument("wheels", nargs="+", type=Path)
    args = parser.parse_args()
    for wheel in args.wheels:
        check_wheel(wheel, args.version, args.platform)
