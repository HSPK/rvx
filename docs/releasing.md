# Releasing RVX

Repository: [HSPK/rvx](https://github.com/HSPK/rvx). PyPI project: `rvx`.
The PyPI owner account is `hspk`; account credentials are never stored in
the repository or workflow.

## Distribution contract

One mixed wheel contains:

- `rvx` Python SDK and CLI, including `Source`.
- Internal `rvx._native` abi3 extension for Python 3.11+.
- Executable `rvx/_bin/rvxd`.
- Built `rvx/_web/index.html` and its assets.

Users need neither Rust nor Node to run `rvx serve --data-dir PATH`.
The first release supports Linux x86_64/arm64 and macOS x86_64/arm64.
Linux targets glibc 2.28+, macOS targets 11+. Windows, musl, and source-only
PyPI installations are not part of this release matrix.

Both the Linux executable and extension are built inside the same manylinux
container. Auditing only the extension can incorrectly label a wheel whose
bundled executable requires a newer glibc; the release check audits both.
macOS builds use matching native runners and an explicit deployment target.

## One-time PyPI setup

Log into PyPI as `hspk`. On the `rvx` project's Publishing page, or as a
pending publisher before the first release, configure GitHub Actions:

| Field | Value |
| --- | --- |
| Owner | `HSPK` |
| Repository | `rvx` |
| Workflow filename | `release.yml` |
| Environment | `pypi` |

The GitHub owner above is not a PyPI username field. Trusted Publishing uses
short-lived OIDC credentials; no API token, password, or username secret is
needed by `release.yml`. The publish job alone has `id-token: write`.

Use the GitHub `pypi` environment for release restrictions or reviewer approval.
Build jobs do not receive publishing credentials. The upload action produces
PyPI attestations for the exact verified wheel artifacts.

## Dry builds

Run **Release** manually against `main`, or:

```bash
gh workflow run release.yml --repo HSPK/rvx --ref main
```

Manual runs build the UI and four wheels, inspect their contents/tags, install
each wheel in a clean environment, and exercise the bundled server and Source
outside the checkout with no build tools in PATH. Artifacts remain available
on the Actions run. **Manual dispatch never publishes to PyPI**, even if a
tag is selected as its ref.

## Publish a version

1. Update `project.version` in `pyproject.toml` and `workspace.package.version`
   in `Cargo.toml` to the same stable `MAJOR.MINOR.PATCH` value; refresh locks.
2. Complete CI and a manual Release build.
3. Commit the release changes and push an exact matching tag, e.g. `v0.1.0`.

Only a pushed `v*` tag can reach the PyPI job. A tag that differs from the
package version fails before building. Every platform must succeed before
publishing; SDK-only wheels, missing UI/executable assets, wrong ABI/platform
tags, and external `rvx-native` dependencies are rejected.

Published versions are immutable. Fix a failed artifact with a new version;
do not overwrite a PyPI release or bypass the complete-wheel checks.

## Local preparation

Build `web/dist` and a release `rvxd`, then stage them before building a wheel:

```bash
npm --prefix web ci
npm --prefix web run build
cargo build --locked --release -p rvx-server
python scripts/package_assets.py --binary target/release/rvxd --ui web/dist
uv run maturin build --release --locked --out dist
python scripts/check_wheel.py --version 0.1.0 dist/*.whl
```

Local Linux wheels built outside manylinux are useful for local smoke tests,
not proof of the release glibc baseline. Use the release workflow for PyPI
artifacts. Do not commit staged binaries, UI bundles, environments, or `dist/`.
