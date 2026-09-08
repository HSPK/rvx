from __future__ import annotations

import os
from pathlib import Path
from typing import NoReturn


REBUILD_HELP = (
    "Reinstall a complete rvx wheel. For a source checkout, build rvxd and the Web UI, "
    "then run `python scripts/package_assets.py "
    "--binary target/release/rvxd --ui web/dist` and rebuild/reinstall with maturin."
)


def serve(
    *,
    data_dir: str,
    listen: str | None = None,
    ui_dir: str | None = None,
    scrape_concurrency: str | None = None,
) -> NoReturn:
    """Replace the CLI with the packaged daemon, retaining its PID and signal ownership."""
    package = Path(__file__).resolve().parent
    binary = package / "_bin" / "rvxd"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError(f"Packaged rvxd executable is missing or not executable: {binary}. {REBUILD_HELP}")
    ui = Path(ui_dir).expanduser().resolve() if ui_dir is not None else package / "_web"
    if not (ui / "index.html").is_file():
        if ui_dir is not None:
            raise RuntimeError(f"--ui-dir must contain a built index.html: {ui}")
        raise RuntimeError(f"Packaged Web UI is missing: {ui / 'index.html'}. {REBUILD_HELP}")
    if ui_dir is None and not any(path.is_file() for path in (ui / "assets").rglob("*")):
        raise RuntimeError(f"Packaged Web UI assets are missing: {ui / 'assets'}. {REBUILD_HELP}")
    if ui_dir is None and (
        not (ui / "login" / "index.html").is_file()
        or not any(path.is_file() for path in (ui / "login" / "assets").rglob("*"))
    ):
        raise RuntimeError(f"Packaged sign-in UI is missing: {ui / 'login'}. {REBUILD_HELP}")
    arguments = [
        str(binary), "--data-dir", str(Path(data_dir).expanduser().resolve()),
        "--ui-dir", str(ui),
    ]
    for flag, value in (
        ("--listen", listen),
        ("--scrape-concurrency", scrape_concurrency),
    ):
        if value is not None:
            arguments.extend((flag, str(value)))
    try:
        os.execv(str(binary), arguments)
    except OSError as error:
        raise RuntimeError(f"Cannot launch packaged rvxd: {error}. {REBUILD_HELP}") from error
