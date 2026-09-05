from __future__ import annotations

import os
from pathlib import Path
import re
import tomllib


def release_version(root: Path, reference: str) -> str:
    """Require matching Python/Cargo versions and an exact version tag when tagged."""
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    cargo = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))["workspace"]["package"]
    version = project["version"]
    if project["name"] != "rvx" or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("release requires package rvx and a stable MAJOR.MINOR.PATCH version")
    if cargo["version"] != version:
        raise ValueError("Python and Cargo workspace release versions differ")
    if reference.startswith("refs/tags/") and reference != f"refs/tags/v{version}":
        raise ValueError(f"release tag must be v{version}, got {reference}")
    return version


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    print(f"version={release_version(root, os.environ.get('RELEASE_REF', ''))}")
