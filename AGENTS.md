# AGENTS.md

## Overview

This repository contains the workshop exercises for **Fundamentals of Frontend System Design** (`1-dom`, `2-intersection-observer`, `3-mutation-observer`, `4-resize-observer`, and `5-virtualisation`).

Exercises use native browser APIs, HTML, CSS, and ES modules without a bundler or frontend framework. A minimal root Node.js toolchain provides automated linting, formatting checks, and syntax validation locally and in GitHub Actions CI.

## Prerequisites & Local Setup

- **Node.js**: Supported LTS versions (`18.x` or `20.x`; `>=18.18.0`).
- **Install dependencies** from the repository root:

```bash
npm ci
```

Use `npm install` only when intentionally adding or updating dependencies in `package.json` and `package-lock.json`.

## Validation & Linting Commands

Run all validation commands from the repository root. These commands execute in strict, read-only mode (they return non-zero exit codes on violations and never modify source files):

- **Run full CI validation locally** (recommended before every commit and pull request):

  ```bash
  npm run validate
  ```

- **Run linting and JavaScript/HTML script syntax checks**:

  ```bash
  npm run lint
  ```

  Executes ESLint (`--max-warnings=0`) across `.js`, `.mjs`, and inline `<script>` blocks inside `.html` files, followed by `node --check` module syntax verification (`scripts/check-syntax.mjs`).

- **Run formatting and structural syntax checks**:

  ```bash
  npm run format:check
  ```

  Executes `prettier --check` on root configuration, workflow, script, and agent documentation files, followed by `scripts/check-format.mjs` to verify AST parseability (HTML, CSS, JS, JSON, YAML) and whitespace/line-ending hygiene (no tabs, CRLF, trailing whitespace, or conflict markers) across all repository files.

## CI Parity & Contribution Guidelines

- Pull requests targeting `main` and pushes to `main` automatically run `.github/workflows/pull-request-validation.yml` across Node.js `18.x` and `20.x`.
- Consecutive pushes to an open pull request automatically cancel superseded in-progress workflow runs.
- Preserve the zero-bundler workshop design: exercises in `begin/` and `end/` directories must continue to work directly in modern browsers using standard ES modules.
- Always verify `npm run validate` exits with code `0` and leaves `git status` clean before opening or updating a pull request.
