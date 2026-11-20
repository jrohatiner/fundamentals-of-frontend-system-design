# Contributor and Agent Guide (`AGENTS.md`)

## Repository Overview

This repository contains vanilla HTML, CSS, and ES module workshop exercises for the Frontend Masters _Fundamentals of Frontend System Design_ course. Exercises run directly in modern browsers without a bundler or frontend framework.

## Local Pre-commit Guardrails

Commits are validated with [`pre-commit`](https://pre-commit.com/) using `.pre-commit-config.yaml`:

- **`trailing-whitespace`** (`pre-commit/pre-commit-hooks`): Removes superfluous trailing whitespace across text files.
- **`end-of-file-fixer`** (`pre-commit/pre-commit-hooks`): Ensures non-empty text files end with a single POSIX trailing newline (`\n`).
- **`prettier`** (`rbubley/mirrors-prettier`): Enforces consistent code and documentation formatting across HTML, CSS, JavaScript/ESM, Markdown, JSON, and YAML files.

### 1. Install Git Hooks

Install `pre-commit` and register the local git commit hook once per clone:

```bash
pip install pre-commit
pre-commit install
```

> **Note for sandboxed/automated agent environments:** If `pre-commit install` reports `Cowardly refusing to install hooks with core.hooksPath set` (common when global git config sets `core.hooksPath = /dev/null`), unset it first with `git config --global --unset-all core.hooksPath` before running `pre-commit install`, and always run `pre-commit run --all-files` explicitly before committing.

Alternative installation methods for `pre-commit`:

- **pipx**: `pipx install pre-commit && pre-commit install`
- **Homebrew (macOS/Linux)**: `brew install pre-commit && pre-commit install`

### 2. Run Guardrails Across All Files

Before opening or updating a pull request (and for automated agents operating in non-interactive environments), run all configured hooks across every tracked file and verify exit code `0`:

```bash
pre-commit run --all-files
```

You can also run Prettier directly across the workspace:

```bash
npx prettier --check .
```

To auto-format files with Prettier:

```bash
npx prettier --write .
```

### 3. Guidance for Missing Python or Node.js Environments

- **No Node.js installed**: `pre-commit` automatically provisions an isolated Node.js runtime via `nodeenv` the first time the `prettier` hook runs, so `pre-commit run --all-files` works even without a global `node` or `npx` installation. If you also want standalone `npx prettier` or `node --test`, install Node.js LTS (>= 18) from [nodejs.org](https://nodejs.org/) or via `nvm install --lts`.
- **No Python installed**: Install Python 3 (>= 3.9) from [python.org](https://www.python.org/downloads/) or your system package manager (`brew install python`, `apt install python3 python3-pip`) so `pre-commit` can be installed. If Python cannot be installed temporarily, run `npx prettier --check .` and verify that modified text files have no trailing whitespace and end with a single `\n` before committing.

### 4. Non-Text Assets and Unsupported File Extensions

Binary assets and plain-text files without Prettier parsers are listed in `.prettierignore` so Prettier skips them cleanly. If future exercises introduce large non-text assets, fixtures, or unsupported file extensions:

1. Add the file path or extension pattern to `.prettierignore` so both `pre-commit` and `npx prettier --check .` bypass Prettier formatting on those files.
2. If a file must also bypass `trailing-whitespace` or `end-of-file-fixer` (for example, an intentionally malformed test fixture), add a narrow `exclude:` regex pattern to the specific hook entry in `.pre-commit-config.yaml` rather than disabling hooks globally.

## Running Automated Tests

Execute the Node.js unit test suites using the built-in test runner:

```bash
node --test 5-virtualisation/5-6-scroll-preservation/end/virtual-list.test.js 5-virtualisation/5-6-scroll-preservation/end/virtual-list.test.mjs
```
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
