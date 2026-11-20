import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".idea",
  ".cache",
  "coverage",
]);
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".html",
  ".css",
  ".json",
  ".yml",
  ".yaml",
  ".md",
]);
const PARSEABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".html",
  ".css",
  ".json",
  ".yml",
  ".yaml",
]);
const CONFLICT_MARKER_RE = new RegExp("^(<{7}|>{7})(\\s|$)", "m");

function collectFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        collectFiles(path.join(dir, entry.name), results);
      }
      continue;
    }
    if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

const files = collectFiles(ROOT_DIR).sort();
const errors = [];

for (const filePath of files) {
  const relPath = path.relative(ROOT_DIR, filePath);
  const ext = path.extname(filePath);
  const content = readFileSync(filePath, "utf8");

  if (CONFLICT_MARKER_RE.test(content)) {
    errors.push(`${relPath}: contains unresolved Git merge conflict markers.`);
  }
  if (content.includes("\r")) {
    errors.push(`${relPath}: contains CRLF (\\r) line endings; expected LF.`);
  }
  if (content.includes("\t")) {
    errors.push(`${relPath}: contains tab characters; expected spaces.`);
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/[ \t]+$/.test(lines[i])) {
      errors.push(`${relPath}:${i + 1}: contains trailing whitespace.`);
      break;
    }
  }

  if (PARSEABLE_EXTENSIONS.has(ext)) {
    try {
      if (path.basename(filePath) === "package-lock.json") {
        JSON.parse(content);
      } else {
        await prettier.format(content, { filepath: filePath });
      }
    } catch (error) {
      errors.push(`${relPath}: syntax/format parse error:\n${error.message}`);
    }
  }
}

if (errors.length > 0) {
  console.error(
    `Format and structural validation failed (${errors.length} issue(s)):\n\n${errors.join("\n\n")}`,
  );
  process.exit(1);
}

console.log(
  `Format and structural validation passed across ${files.length} file(s).`,
);
