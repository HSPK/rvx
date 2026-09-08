"""Stage native and built UI resources for the single mixed RVX wheel."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
from typing import Sequence


PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "src" / "rvx"
NATIVE_MAGICS = {
    b"\x7fELF",
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
}


def stage_assets(binary: Path, ui: Path) -> tuple[Path, Path]:
    """Validate both inputs before replacing only the two generated asset locations."""
    binary, ui = Path(binary).absolute(), Path(ui).absolute()
    if binary.is_symlink() or not binary.is_file():
        raise ValueError(f"--binary must be a regular native rvxd executable: {binary}")
    with binary.open("rb") as stream:
        if stream.read(4) not in NATIVE_MAGICS:
            raise ValueError(f"--binary must be an ELF or Mach-O native executable: {binary}")
    if ui.is_symlink() or not ui.is_dir():
        raise ValueError(f"--ui must be a built UI directory: {ui}")
    entries = list(ui.rglob("*"))
    if any(path.is_symlink() or not (path.is_dir() or path.is_file()) for path in entries):
        raise ValueError("--ui must contain only regular files and directories, not links")
    if not (ui / "index.html").is_file() or not (ui / "index.html").stat().st_size:
        raise ValueError("--ui must contain a nonempty built index.html")
    if not any(path.is_file() and path.stat().st_size for path in (ui / "assets").rglob("*")):
        raise ValueError("--ui must contain nonempty built assets")
    if not (ui / "login" / "index.html").is_file() or not (ui / "login" / "index.html").stat().st_size:
        raise ValueError("--ui must contain a nonempty built login/index.html")
    if not any(path.is_file() and path.stat().st_size for path in (ui / "login" / "assets").rglob("*")):
        raise ValueError("--ui must contain nonempty built login assets")

    package = PACKAGE_ROOT.absolute()
    binary_dir, ui_target = package / "_bin", package / "_web"
    binary_target = binary_dir / "rvxd"
    for destination in (package, binary_dir, ui_target):
        if destination.is_symlink():
            raise ValueError(f"refusing symlink staging destination: {destination}")
        if destination.exists() and not destination.is_dir():
            raise ValueError(f"staging destination is not a directory: {destination}")
    for destination in (binary_target, *ui_target.rglob("*")):
        if destination.is_symlink():
            raise ValueError(f"refusing symlink staging destination: {destination}")
    for source in (binary.resolve(), ui.resolve()):
        for destination in (binary_dir.resolve(), ui_target.resolve()):
            if source.is_relative_to(destination) or destination.is_relative_to(source):
                raise ValueError("input assets must not overlap their generated staging locations")

    binary_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(binary, binary_target)
    binary_target.chmod(0o755)
    shutil.copytree(ui, ui_target, dirs_exist_ok=True)
    expected = {path.relative_to(ui) for path in entries}
    for path in sorted(ui_target.rglob("*"), reverse=True):
        if path.relative_to(ui_target) not in expected:
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
    return binary_target, ui_target


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--ui", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        binary, ui = stage_assets(args.binary, args.ui)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Staged {binary}\nStaged {ui}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
