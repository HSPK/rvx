"""Stage native executables and built UI into the wheel data schemes."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
from typing import Sequence


WHEEL_DATA_ROOT = Path(__file__).resolve().parents[1] / "rvx.data"
NATIVE_MAGICS = {
    b"\x7fELF",
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
}


def _native(binary: Path, flag: str) -> Path:
    binary = Path(binary).absolute()
    if binary.is_symlink() or not binary.is_file():
        raise ValueError(f"{flag} must be a regular native executable: {binary}")
    with binary.open("rb") as stream:
        if stream.read(4) not in NATIVE_MAGICS:
            raise ValueError(f"{flag} must be an ELF or Mach-O native executable: {binary}")
    return binary


def stage_assets(
    cli_binary: Path,
    daemon_binary: Path,
    ui: Path,
) -> tuple[Path, Path, Path]:
    """Validate every input before replacing generated wheel script/data locations."""
    cli_binary = _native(cli_binary, "--cli-binary")
    daemon_binary = _native(daemon_binary, "--daemon-binary")
    if cli_binary.resolve() == daemon_binary.resolve():
        raise ValueError("CLI and daemon binaries must be distinct files")
    ui = Path(ui).absolute()
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

    root = WHEEL_DATA_ROOT.absolute()
    scripts = root / "scripts"
    data = root / "data"
    ui_target = data / "share" / "rvx" / "web"
    cli_target, daemon_target = scripts / "rvx", scripts / "rvxd"
    for destination in (root, scripts, data, ui_target):
        if destination.is_symlink():
            raise ValueError(f"refusing symlink staging destination: {destination}")
        if destination.exists() and not destination.is_dir():
            raise ValueError(f"staging destination is not a directory: {destination}")
    for destination in (cli_target, daemon_target, *ui_target.rglob("*")):
        if destination.is_symlink():
            raise ValueError(f"refusing symlink staging destination: {destination}")
    for source in (cli_binary.resolve(), daemon_binary.resolve(), ui.resolve()):
        for destination in (scripts.resolve(), ui_target.resolve()):
            if source.is_relative_to(destination) or destination.is_relative_to(source):
                raise ValueError("input assets must not overlap their generated staging locations")

    scripts.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(cli_binary, cli_target)
    shutil.copyfile(daemon_binary, daemon_target)
    cli_target.chmod(0o755)
    daemon_target.chmod(0o755)
    shutil.copytree(ui, ui_target, dirs_exist_ok=True)
    expected = {path.relative_to(ui) for path in entries}
    for path in sorted(ui_target.rglob("*"), reverse=True):
        if path.relative_to(ui_target) not in expected:
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
    return cli_target, daemon_target, ui_target


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli-binary", type=Path, required=True)
    parser.add_argument("--daemon-binary", type=Path, required=True)
    parser.add_argument("--ui", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        cli, daemon, ui = stage_assets(args.cli_binary, args.daemon_binary, args.ui)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Staged {cli}\nStaged {daemon}\nStaged {ui}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
