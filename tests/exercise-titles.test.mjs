import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const COURSE_TITLE = "Frontend System Design";
const MAX_TITLE_LENGTH = 95;
const LEGACY_GENERIC_TITLES = new Set([
  "Frontend System Design Fundamentals",
  "Frontend System Design",
  "Virtualisation",
  "Virtualization",
  "Document",
]);

const EXPECTED_TITLES = {
  "1-dom/begin/index.html": "DOM Operations (Begin) | Frontend System Design",
  "1-dom/end/index.html": "DOM Operations (End) | Frontend System Design",
  "2-intersection-observer/begin/index.html":
    "Intersection Observer (Begin) | Frontend System Design",
  "2-intersection-observer/end/index.html":
    "Intersection Observer (End) | Frontend System Design",
  "3-mutation-observer/begin/index.html":
    "Mutation Observer (Begin) | Frontend System Design",
  "3-mutation-observer/end/index.html":
    "Mutation Observer (End) | Frontend System Design",
  "4-resize-observer/begin/index.html":
    "Resize Observer (Begin) | Frontend System Design",
  "4-resize-observer/end/index.html":
    "Resize Observer (End) | Frontend System Design",
  "5-virtualisation/5-1-skeleton/begin/index.html":
    "Skeleton (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-1-skeleton/end/index.html":
    "Skeleton (End) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-2-observer-handling/begin/index.html":
    "Observer Handling (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-2-observer-handling/end/index.html":
    "Observer Handling (End) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-3-property-model-and-loading/begin/index.html":
    "Property Model and Loading (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-3-property-model-and-loading/end/index.html":
    "Property Model and Loading (End) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-4-elements-pool-and-recycling/begin/index.html":
    "Elements Pool and Recycling (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-4-elements-pool-and-recycling/end/index.html":
    "Elements Pool and Recycling (End) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-4-1-elements-pool-and-recycling-preparation/begin/index.html":
    "Elements Pool and Recycling Preparation (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-4-1-elements-pool-and-recycling-preparation/end/index.html":
    "Elements Pool and Recycling Preparation (End) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-4-2-elements-pool-and-recycling-rendering/begin/index.html":
    "Elements Pool and Recycling Rendering (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-4-2-elements-pool-and-recycling-rendering/end/index.html":
    "Elements Pool and Recycling Rendering (End) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-5-top-observer/begin/index.html":
    "Top Observer (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-5-top-observer/end/index.html":
    "Top Observer (End) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-6-scroll-preservation/begin/index.html":
    "Scroll Preservation (Begin) | Virtualisation | Frontend System Design",
  "5-virtualisation/5-6-scroll-preservation/end/index.html":
    "Scroll Preservation (End) | Virtualisation | Frontend System Design",
};

const MINOR_WORDS = new Set(["and", "or", "of", "in", "to", "for"]);
const TOP_LEVEL_TOPIC_OVERRIDES = {
  "1-dom": "DOM Operations",
};

function discoverFiles(dir, predicate, rootDir = dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...discoverFiles(fullPath, predicate, rootDir));
    } else if (predicate(fullPath)) {
      results.push(path.relative(rootDir, fullPath).split(path.sep).join("/"));
    }
  }
  return results.sort();
}

function slugToTitle(slug) {
  const withoutPrefix = slug.replace(/^\d+(?:-\d+)*-/, "");
  return withoutPrefix
    .split("-")
    .map((word, index) => {
      if (index > 0 && MINOR_WORDS.has(word)) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function deriveExpectedTitleFromPath(relPath) {
  const segments = relPath.split("/");
  const fileName = segments.at(-1);
  assert.equal(
    fileName,
    "index.html",
    `Expected index.html exercise entry, got ${relPath}`,
  );

  const milestoneDir = segments.at(-2);
  assert.ok(
    milestoneDir === "begin" || milestoneDir === "end",
    `Expected 'begin' or 'end' milestone directory in ${relPath}`,
  );
  const milestone = milestoneDir === "begin" ? "Begin" : "End";

  if (segments.length === 3) {
    const [moduleSlug] = segments;
    const topic =
      TOP_LEVEL_TOPIC_OVERRIDES[moduleSlug] ?? slugToTitle(moduleSlug);
    return `${topic} (${milestone}) | ${COURSE_TITLE}`;
  }

  if (segments.length === 4) {
    const [parentSlug, topicSlug] = segments;
    const subModule = slugToTitle(parentSlug);
    const topic = slugToTitle(topicSlug);
    return `${topic} (${milestone}) | ${subModule} | ${COURSE_TITLE}`;
  }

  throw new Error(`Unsupported exercise directory depth for ${relPath}`);
}

function normalizeHtmlTitle(rawTitle) {
  return rawTitle.replace(/[ \t\n\f\r]+/g, " ").trim();
}

/**
 * Extracts and validates `<title>` elements from static HTML `<head>` markup
 * (ignoring any nested `<template>` blocks inside `<head>`).
 */
export function validateExerciseTitles(entries) {
  const errors = [];
  const seenTitles = new Map();

  for (const { relPath, html } of entries) {
    const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch) {
      errors.push(`${relPath}: missing <head> section`);
      continue;
    }

    const headWithoutTemplates = headMatch[1].replace(
      /<template\b[^>]*>[\s\S]*?<\/template>/gi,
      "",
    );
    const titleMatches = [
      ...headWithoutTemplates.matchAll(/<title>([\s\S]*?)<\/title>/gi),
    ];

    if (titleMatches.length !== 1) {
      errors.push(
        `${relPath}: expected exactly 1 static <title> in <head>, found ${titleMatches.length}`,
      );
      continue;
    }

    const rawTitle = titleMatches[0][1];
    const title = normalizeHtmlTitle(rawTitle);
    const isCleanSingleLine = rawTitle === title;
    const isCleanPrettierMultiLine =
      !/\r|\t/.test(rawTitle) &&
      /^\n[ ]+\S[\s\S]*\S\n[ ]*$/.test(rawTitle) &&
      rawTitle
        .trim()
        .split("\n")
        .every((line) => !/ {2,}/.test(line.trim()));

    if (!title || (!isCleanSingleLine && !isCleanPrettierMultiLine)) {
      errors.push(
        `${relPath}: <title> must be non-empty and cleanly formatted (got ${JSON.stringify(rawTitle)})`,
      );
      continue;
    }

    if (LEGACY_GENERIC_TITLES.has(title)) {
      errors.push(
        `${relPath}: uses generic non-descriptive title "${title}" (WCAG Failure F25)`,
      );
    }

    if (title.length > MAX_TITLE_LENGTH) {
      errors.push(
        `${relPath}: title exceeds ${MAX_TITLE_LENGTH} characters (${title.length}): "${title}"`,
      );
    }

    if (seenTitles.has(title)) {
      errors.push(
        `${relPath}: shares duplicate <title> "${title}" with ${seenTitles.get(title)}`,
      );
    } else {
      seenTitles.set(title, relPath);
    }

    const parts = title.split(" | ");
    if (parts.length !== 2 && parts.length !== 3) {
      errors.push(
        `${relPath}: expected "[Topic] ([Milestone]) | [Sub-module] | ${COURSE_TITLE}" or "[Topic] ([Milestone]) | ${COURSE_TITLE}", got "${title}"`,
      );
      continue;
    }

    if (parts.at(-1) !== COURSE_TITLE) {
      errors.push(
        `${relPath}: final title segment must be "${COURSE_TITLE}", got "${parts.at(-1)}"`,
      );
    }

    const milestoneDir = relPath.split("/").at(-2);
    const expectedMilestone = milestoneDir === "begin" ? "Begin" : "End";
    const topicMatch = parts[0].match(/^(.+) \((Begin|End)\)$/);
    if (!topicMatch) {
      errors.push(
        `${relPath}: first segment "${parts[0]}" must place "[Topic] (Begin|End)" first per WCAG G88`,
      );
    } else {
      const [, topic, milestone] = topicMatch;
      if (!topic.trim()) {
        errors.push(
          `${relPath}: topic prefix before milestone must not be empty`,
        );
      }
      if (milestone !== expectedMilestone) {
        errors.push(
          `${relPath}: milestone "(${milestone})" does not match directory "${milestoneDir}" (expected "(${expectedMilestone})")`,
        );
      }
    }
  }

  return errors;
}

describe("Exercise HTML static <title> hierarchy (WCAG 2.2 SC 2.4.2 & G88)", () => {
  const htmlPaths = discoverFiles(REPO_ROOT, (fullPath) =>
    fullPath.endsWith(".html"),
  );
  const entries = htmlPaths.map((relPath) => ({
    relPath,
    html: readFileSync(path.join(REPO_ROOT, relPath), "utf8"),
  }));

  it("discovers all 24 workshop exercise HTML templates across modules 1 through 5", () => {
    assert.equal(
      htmlPaths.length,
      24,
      `Expected 24 HTML exercise templates, found ${htmlPaths.length}`,
    );
    assert.deepEqual(htmlPaths, Object.keys(EXPECTED_TITLES).sort());
  });

  it("ensures all 24 templates have non-empty, unique, concise, structured static <title> elements", () => {
    const errors = validateExerciseTitles(entries);
    assert.deepEqual(
      errors,
      [],
      `Title validation failed:\n${errors.join("\n")}`,
    );
  });

  it("matches curriculum taxonomy and exact acceptance criteria titles across every exercise", () => {
    for (const { relPath, html } of entries) {
      const headSection = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)[1];
      const headWithoutTemplates = headSection.replace(
        /<template\b[^>]*>[\s\S]*?<\/template>/gi,
        "",
      );
      const title = normalizeHtmlTitle(
        headWithoutTemplates.match(/<title>([\s\S]*?)<\/title>/i)[1],
      );

      const derivedTitle = deriveExpectedTitleFromPath(relPath);
      assert.equal(
        title,
        EXPECTED_TITLES[relPath],
        `Unexpected <title> in ${relPath}`,
      );
      assert.equal(
        title,
        derivedTitle,
        `Title in ${relPath} diverged from curriculum directory taxonomy`,
      );
    }

    // Explicit checks for Acceptance Criteria 3 & 4
    assert.equal(
      EXPECTED_TITLES["1-dom/begin/index.html"],
      "DOM Operations (Begin) | Frontend System Design",
    );
    assert.equal(
      EXPECTED_TITLES["1-dom/end/index.html"],
      "DOM Operations (End) | Frontend System Design",
    );
    assert.equal(
      EXPECTED_TITLES[
        "5-virtualisation/5-6-scroll-preservation/end/index.html"
      ],
      "Scroll Preservation (End) | Virtualisation | Frontend System Design",
    );
  });

  it("retains purely declarative static titles with zero client-side document.title mutations", () => {
    const scriptAndHtmlPaths = discoverFiles(
      REPO_ROOT,
      (fullPath) =>
        (fullPath.endsWith(".html") || fullPath.endsWith(".js")) &&
        !fullPath.includes(".test.") &&
        !fullPath.startsWith(path.join(REPO_ROOT, "tests")),
    );

    for (const relPath of scriptAndHtmlPaths) {
      const source = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      assert.equal(
        /document\.title\s*=/.test(source),
        false,
        `Expected no dynamic document.title mutation in ${relPath}`,
      );
    }
  });

  it("rejects duplicate, empty, generic, or misordered titles in validator checks", () => {
    const duplicateErrors = validateExerciseTitles([
      {
        relPath: "1-dom/begin/index.html",
        html: "<!DOCTYPE html><html><head><title>DOM Operations (Begin) | Frontend System Design</title></head></html>",
      },
      {
        relPath: "2-intersection-observer/begin/index.html",
        html: "<!DOCTYPE html><html><head><title>DOM Operations (Begin) | Frontend System Design</title></head></html>",
      },
    ]);
    assert.ok(
      duplicateErrors.some((err) => err.includes("shares duplicate <title>")),
    );

    const emptyAndGenericErrors = validateExerciseTitles([
      {
        relPath: "1-dom/begin/index.html",
        html: "<!DOCTYPE html><html><head><title>   </title></head></html>",
      },
      {
        relPath: "1-dom/end/index.html",
        html: "<!DOCTYPE html><html><head><title>Frontend System Design Fundamentals</title></head></html>",
      },
      {
        relPath: "2-intersection-observer/end/index.html",
        html: "<!DOCTYPE html><html><head><title>Intersection Observer (Begin) | Frontend System Design</title></head></html>",
      },
    ]);
    assert.equal(emptyAndGenericErrors.length >= 3, true);
  });
});
