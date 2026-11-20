import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const IGNORED_DIRS = new Set(["node_modules", ".git", ".cache", "coverage"]);
const JS_EXTENSIONS = new Set([".js", ".mjs"]);

function collectJsFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        collectJsFiles(path.join(dir, entry.name), results);
      }
      continue;
    }
    if (entry.isFile() && JS_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

const files = collectJsFiles(ROOT_DIR).sort();
const failures = [];

for (const filePath of files) {
  try {
    execFileSync(process.execPath, ["--check", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    const relPath = path.relative(ROOT_DIR, filePath);
    const detail = (error.stderr || error.message || "").trim();
    failures.push(`${relPath}:\n${detail}`);
  }
}

if (failures.length > 0) {
  console.error(
    `Syntax check failed in ${failures.length} file(s) on Node ${process.version}:\n\n${failures.join("\n\n")}`,
  );
  process.exit(1);
}

console.log(
  `Syntax check passed for ${files.length} JS/MJS file(s) on Node ${process.version}.`,
);
