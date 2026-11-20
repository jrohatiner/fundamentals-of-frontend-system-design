# AGENTS.md

## Repository Overview

This repository contains the zero-bundler browser exercises for the **Fundamentals of Frontend System Design** workshop. Each workshop module lives in its own top-level directory (`1-dom`, `2-intersection-observer`, `3-mutation-observer`, `4-resize-observer`, `5-virtualisation`) and uses shared browser utilities and stylesheets under `styles/` and `utils/`.

## Local Packaging Commands

To build isolated offline distribution bundles matching the GitHub Actions release matrix locally (without overwriting files across modules):

```bash
RELEASE_TAG="v1.0.0"
MODULES=(
  "1-dom"
  "2-intersection-observer"
  "3-mutation-observer"
  "4-resize-observer"
  "5-virtualisation"
)

rm -rf dist release-assets
mkdir -p release-assets

for MODULE in "${MODULES[@]}"; do
  BUNDLE_NAME="${MODULE}-${RELEASE_TAG}"
  MODULE_DIST_DIR="dist/${MODULE}"
  STAGE_DIR="${MODULE_DIST_DIR}/stage/${BUNDLE_NAME}"
  ARCHIVE_PATH="${MODULE_DIST_DIR}/${BUNDLE_NAME}.tar.gz"

  mkdir -p "$STAGE_DIR"
  cp -R "$MODULE" styles utils README.md LICENSE "$STAGE_DIR/"
  tar -C "${MODULE_DIST_DIR}/stage" -czf "$ARCHIVE_PATH" "$BUNDLE_NAME"
  rm -rf "${MODULE_DIST_DIR}/stage"

  cp "$ARCHIVE_PATH" "release-assets/${BUNDLE_NAME}.tar.gz"
done
```

Each generated archive (`release-assets/<module>-<tag>.tar.gz`) unpacks into `<module>-<tag>/` containing the module exercises alongside `styles/`, `utils/`, `README.md`, and `LICENSE` so relative browser ES module imports and stylesheet links work offline without a bundler.

## SHA-256 Checksum Generation & Verification

### Generate `checksums.sha256` Locally

Run from the repository root after building `release-assets/`:

```bash
(
  cd release-assets
  LC_ALL=C sha256sum -- *.tar.gz > checksums.sha256
)
```

### Verify Downloaded or Locally Built Release Assets

Verify all workshop module archives against `checksums.sha256`:

```bash
(
  cd release-assets
  sha256sum -c checksums.sha256
)
```

Verify a single downloaded module archive alongside `checksums.sha256`:

```bash
sha256sum --ignore-missing -c checksums.sha256
```

> **macOS note:** If `sha256sum` is not installed, run `shasum -a 256 -c checksums.sha256`.

Inspect archive contents before extraction:

```bash
tar -tzf release-assets/1-dom-v1.0.0.tar.gz
```

## Release Workflow Triggers & Security Guardrails

The automated release pipeline is defined in `.github/workflows/release.yml`:

- **Trigger:** Runs automatically only on `push` events for semantic version git tags matching `v*.*.*` (for example, `git tag v1.0.0 && git push origin v1.0.0`). Branch pushes and pull requests never trigger release asset publication.
- **Least-Privilege Permissions:** Declares `permissions: contents: read` at the top level of the workflow so `package` and `checksums` jobs run with read-only access. Only the final `publish` job requests `permissions: contents: write` to create/upload GitHub Release assets.
- **Injection Prevention:** Inline `bash` scripts never interpolate `${{ ... }}` expressions directly; untrusted context values such as `github.ref_name` are passed through `env:` (`RELEASE_TAG`, `MODULE`, `GH_REPO`) and validated against strict semantic version patterns.
- **Artifact Isolation & Action Pinning:** Matrix builds stage into isolated `dist/<module>/` directories and upload distinct `workshop-module-<module>` artifacts using official `actions/*` steps pinned to immutable 40-character commit SHAs.
