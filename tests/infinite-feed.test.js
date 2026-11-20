/**
 * End-to-end Playwright verification for 2-intersection-observer/end/index.html.
 *
 * Run with:
 *   node --test tests/infinite-feed.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
};

function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, "http://127.0.0.1");
      const safePath = path.resolve(
        REPO_ROOT,
        "." + decodeURIComponent(reqUrl.pathname),
      );
      if (
        !safePath.startsWith(REPO_ROOT + path.sep) &&
        safePath !== REPO_ROOT
      ) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const content = await fs.readFile(safePath);
      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function installDbSpyRoute(page, { overrideCount } = {}) {
  const dbFilePath = path.join(REPO_ROOT, "utils", "db.js");
  const originalDbSource = await fs.readFile(dbFilePath, "utf8");
  const instrumentedSource =
    originalDbSource.replace(
      "export function initMockDB",
      "function __originalInitMockDB",
    ) +
    `\nwindow.__getPageCalls = [];
export function initMockDB(sample, count = 100, page = 10) {
    const effectiveCount = ${overrideCount !== undefined ? Number(overrideCount) : "count"};
    const db = __originalInitMockDB(sample, effectiveCount, page);
    return {
        getPage(pointer) {
            window.__getPageCalls.push(pointer);
            return db.getPage(pointer);
        }
    };
}
`;

  await page.route("**/utils/db.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: instrumentedSource,
    });
  });
}

let serverInfo;
let browser;

before(async () => {
  serverInfo = await startStaticServer();
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
  if (serverInfo?.server) {
    await new Promise((resolve) => serverInfo.server.close(resolve));
  }
});

test("scrolls through all 10 pages until exhaustion and unobserves sentinel", async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await installDbSpyRoute(page);
    await page.goto(
      `${serverInfo.baseUrl}/2-intersection-observer/end/index.html`,
      {
        waitUntil: "domcontentloaded",
      },
    );

    const cards = page.locator("#list .card");
    const sentinel = page.locator("#bottom-observer");

    assert.equal((await sentinel.textContent()).trim(), "Bottom Observer");

    // Page 0 loads automatically when #bottom-observer initially intersects.
    await page.waitForFunction(
      () => document.querySelectorAll("#list .card").length === 10,
      null,
      {
        timeout: 5000,
      },
    );

    // Scroll through pages 1..9 (remaining 9 pages, 10 items per page -> 100 items total).
    for (let pageIndex = 1; pageIndex < 10; pageIndex++) {
      const expectedCards = (pageIndex + 1) * 10;
      await sentinel.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        (count) => document.querySelectorAll("#list .card").length === count,
        expectedCards,
        { timeout: 5000 },
      );
      assert.equal((await sentinel.textContent()).trim(), "Bottom Observer");
    }

    assert.equal(await cards.count(), 100);
    assert.match(
      await cards.first().locator(".card__title").textContent(),
      /^\[Entry 0\]/,
    );
    assert.match(
      await cards.nth(99).locator(".card__title").textContent(),
      /^\[Entry 99\]/,
    );

    const callsBeforeExhaustion = await page.evaluate(() =>
      window.__getPageCalls.slice(),
    );
    assert.deepEqual(callsBeforeExhaustion, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Scroll to the sentinel after page 9 -> triggers getPage(10), which resolves [].
    await sentinel.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        document.getElementById("bottom-observer").textContent.trim() ===
        "No more items to load",
      null,
      { timeout: 5000 },
    );

    assert.equal(await cards.count(), 100);
    const callsAtExhaustion = await page.evaluate(() =>
      window.__getPageCalls.slice(),
    );
    assert.deepEqual(callsAtExhaustion, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Repeatedly scroll away from and back to #bottom-observer to verify no further getPage calls occur.
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await sentinel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1500);

    const callsAfterRescroll = await page.evaluate(() =>
      window.__getPageCalls.slice(),
    );
    assert.deepEqual(callsAfterRescroll, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(await cards.count(), 100);
  } finally {
    await context.close();
  }
});

test("unobserves sentinel immediately and leaves list empty when first getPage returns empty array", async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await installDbSpyRoute(page, { overrideCount: 0 });
    await page.goto(
      `${serverInfo.baseUrl}/2-intersection-observer/end/index.html`,
      {
        waitUntil: "domcontentloaded",
      },
    );

    const sentinel = page.locator("#bottom-observer");
    await page.waitForFunction(
      () =>
        document.getElementById("bottom-observer").textContent.trim() ===
        "No more items to load",
      null,
      { timeout: 5000 },
    );

    const listChildren = await page.evaluate(
      () => document.getElementById("list").children.length,
    );
    assert.equal(listChildren, 0);
    assert.deepEqual(
      await page.evaluate(() => window.__getPageCalls.slice()),
      [0],
    );

    // Toggle visibility / scroll to confirm observer stays detached.
    await page.setViewportSize({ width: 1280, height: 200 });
    await page.evaluate(() => {
      document.getElementById("list").style.height = "800px";
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);
    await sentinel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);

    assert.deepEqual(
      await page.evaluate(() => window.__getPageCalls.slice()),
      [0],
    );
  } finally {
    await context.close();
  }
});
