/**
 * End-to-end headless Chrome verification for sentinel status updates and
 * IntersectionObserver detachment in:
 *   - 2-intersection-observer/end/index.html
 *   - 3-mutation-observer/end/index.html
 *
 * Run with:
 *   node --test tests/infinite-feed.test.js
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
};

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Could not find a Chrome/Chromium binary. Set CHROME_BIN to its path.",
  );
}

function startStaticServer() {
  let dbRouteOptions = null;

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, "http://127.0.0.1");
      if (reqUrl.pathname === "/utils/db.js" && dbRouteOptions) {
        const dbFilePath = path.join(REPO_ROOT, "utils", "db.js");
        let originalDbSource = await fs.readFile(dbFilePath, "utf8");
        if (dbRouteOptions.delayMs !== undefined) {
          originalDbSource = originalDbSource.replace(
            "}, 1000);",
            `}, ${Number(dbRouteOptions.delayMs)});`,
          );
        }
        const overrideExpr =
          dbRouteOptions.overrideCount !== undefined
            ? String(Number(dbRouteOptions.overrideCount))
            : "count";
        const instrumentedSource =
          originalDbSource.replace(
            "export function initMockDB",
            "function __originalInitMockDB",
          ) +
          `
window.__getPageCalls = [];
window.__sentinelTextsAtFetchStart = [];
export function initMockDB(sample, count = 100, page = 10) {
    const effectiveCount = ${overrideExpr};
    const db = __originalInitMockDB(sample, effectiveCount, page);
    return {
        getPage(pointer) {
            window.__getPageCalls.push(pointer);
            window.__sentinelTextsAtFetchStart.push(
                document.getElementById("bottom-observer")?.textContent.trim() ?? null
            );
            return db.getPage(pointer);
        }
    };
}
`;
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(instrumentedSource);
        return;
      }

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
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        setDbRouteOptions(opts) {
          dbRouteOptions = opts;
        },
      });
    });
  });
}

async function launchHeadlessChrome() {
  const chromeBin = findChromeBinary();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), "infinite-feed-test-"),
  );

  const proc = spawn(
    chromeBin,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,720",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const debugPort = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for Chrome DevTools port. Stderr: ${stderr}`,
        ),
      );
    }, 10_000);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(
        /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//,
      );
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });

    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Chrome exited prematurely with code ${code}. Stderr: ${stderr}`,
        ),
      );
    });
  });

  const targetsResponse = await fetch(
    `http://127.0.0.1:${debugPort}/json/list`,
  );
  const targets = await targetsResponse.json();
  const pageTarget = targets.find((target) => target.type === "page");
  assert.ok(
    pageTarget?.webSocketDebuggerUrl,
    "Expected a debuggable page target",
  );

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    }
    return response.result.value;
  }

  async function cleanup() {
    try {
      await send("Browser.close");
    } catch {}
    try {
      ws.close();
    } catch {}
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await new Promise((resolve) => proc.once("exit", resolve));
    }
    try {
      rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {}
  }

  await send("Page.enable");
  await send("Runtime.enable");

  return { send, evaluate, cleanup };
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(`Boolean(${predicateExpr})`);
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for condition: ${predicateExpr}`);
}

const EXERCISE_PAGES = [
  "/2-intersection-observer/end/index.html",
  "/3-mutation-observer/end/index.html",
];

describe(
  "Infinite feed sentinel status and observer detachment",
  { concurrency: false },
  () => {
    for (const pagePath of EXERCISE_PAGES) {
      test(`${pagePath}: displays Loading during fetches, restores Bottom Observer, and sets End of feed + unobserves at page 10`, async (t) => {
        const serverInfo = await startStaticServer();
        t.after(async () => {
          await new Promise((resolve) => serverInfo.server.close(resolve));
        });

        const chrome = await launchHeadlessChrome();
        t.after(async () => {
          await chrome.cleanup();
        });

        serverInfo.setDbRouteOptions({ delayMs: 150 });
        await chrome.send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
          mobile: false,
        });

        await chrome.send("Page.navigate", {
          url: `${serverInfo.baseUrl}${pagePath}`,
        });

        // Verify sentinel shows "Loading" while initial asynchronous page request is in flight.
        await waitForCondition(
          chrome.evaluate,
          `document.getElementById("bottom-observer")?.textContent.trim() === "Loading" || window.__sentinelTextsAtFetchStart?.[0] === "Loading"`,
        );

        // Page 0 finishes loading 10 cards and restores sentinel text to "Bottom Observer".
        await waitForCondition(
          chrome.evaluate,
          `document.querySelectorAll("#list .card").length === 10`,
        );
        assert.equal(
          await chrome.evaluate(
            `document.getElementById("bottom-observer").textContent.trim()`,
          ),
          "Bottom Observer",
        );

        // Scroll through pages 1..9 (10 items per page -> 100 items total).
        for (let pageIndex = 1; pageIndex < 10; pageIndex++) {
          const expectedCards = (pageIndex + 1) * 10;
          await chrome.evaluate(
            `document.getElementById("bottom-observer").scrollIntoView()`,
          );
          await waitForCondition(
            chrome.evaluate,
            `document.getElementById("bottom-observer")?.textContent.trim() === "Loading" || window.__sentinelTextsAtFetchStart?.[${pageIndex}] === "Loading"`,
          );
          await waitForCondition(
            chrome.evaluate,
            `document.querySelectorAll("#list .card").length === ${expectedCards}`,
          );
          assert.equal(
            await chrome.evaluate(
              `document.getElementById("bottom-observer").textContent.trim()`,
            ),
            "Bottom Observer",
          );
        }

        const cardSummary = await chrome.evaluate(`({
          count: document.querySelectorAll("#list .card").length,
          firstTitle: document.querySelectorAll("#list .card .card__title")[0]?.textContent ?? "",
          lastTitle: document.querySelectorAll("#list .card .card__title")[99]?.textContent ?? ""
        })`);
        assert.equal(cardSummary.count, 100);
        assert.match(cardSummary.firstTitle, /^\[Entry 0\]/);
        assert.match(cardSummary.lastTitle, /^\[Entry 99\]/);

        const callsBeforeExhaustion = await chrome.evaluate(
          `window.__getPageCalls.slice()`,
        );
        assert.deepEqual(callsBeforeExhaustion, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

        // Scroll to the sentinel after page 9 -> triggers getPage(10), showing "Loading" then "End of feed".
        await chrome.evaluate(
          `document.getElementById("bottom-observer").scrollIntoView()`,
        );
        await waitForCondition(
          chrome.evaluate,
          `document.getElementById("bottom-observer")?.textContent.trim() === "Loading" || window.__sentinelTextsAtFetchStart?.[10] === "Loading"`,
        );
        await waitForCondition(
          chrome.evaluate,
          `document.getElementById("bottom-observer")?.textContent.trim() === "End of feed"`,
        );

        assert.equal(
          await chrome.evaluate(
            `document.querySelectorAll("#list .card").length`,
          ),
          100,
        );
        const callsAtExhaustion = await chrome.evaluate(
          `window.__getPageCalls.slice()`,
        );
        assert.deepEqual(callsAtExhaustion, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        // Confirm sentinel was already set to "Loading" prior to every db.getPage invocation.
        const sentinelTextsAtFetchStart = await chrome.evaluate(
          `window.__sentinelTextsAtFetchStart.slice()`,
        );
        assert.deepEqual(sentinelTextsAtFetchStart, Array(11).fill("Loading"));

        // Repeatedly scroll away from and back to #bottom-observer to verify observer was detached.
        for (let cycle = 0; cycle < 3; cycle++) {
          await chrome.evaluate(`window.scrollTo(0, 0)`);
          await new Promise((resolve) => setTimeout(resolve, 60));
          await chrome.evaluate(
            `document.getElementById("bottom-observer").scrollIntoView()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        await new Promise((resolve) => setTimeout(resolve, 350));

        const callsAfterRescroll = await chrome.evaluate(
          `window.__getPageCalls.slice()`,
        );
        assert.deepEqual(
          callsAfterRescroll,
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        );
        assert.equal(
          await chrome.evaluate(
            `document.getElementById("bottom-observer").textContent.trim()`,
          ),
          "End of feed",
        );
        assert.equal(
          await chrome.evaluate(
            `document.querySelectorAll("#list .card").length`,
          ),
          100,
        );
      });

      test(`${pagePath}: sets End of feed immediately, leaves list empty, and unobserves sentinel when initial database is empty`, async (t) => {
        const serverInfo = await startStaticServer();
        t.after(async () => {
          await new Promise((resolve) => serverInfo.server.close(resolve));
        });

        const chrome = await launchHeadlessChrome();
        t.after(async () => {
          await chrome.cleanup();
        });

        serverInfo.setDbRouteOptions({ overrideCount: 0, delayMs: 150 });
        await chrome.send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
          mobile: false,
        });

        await chrome.send("Page.navigate", {
          url: `${serverInfo.baseUrl}${pagePath}`,
        });

        await waitForCondition(
          chrome.evaluate,
          `document.getElementById("bottom-observer")?.textContent.trim() === "Loading" || window.__sentinelTextsAtFetchStart?.[0] === "Loading"`,
        );
        await waitForCondition(
          chrome.evaluate,
          `document.getElementById("bottom-observer")?.textContent.trim() === "End of feed"`,
        );

        assert.equal(
          await chrome.evaluate(
            `document.getElementById("list").children.length`,
          ),
          0,
        );
        assert.deepEqual(
          await chrome.evaluate(`window.__getPageCalls.slice()`),
          [0],
        );
        assert.deepEqual(
          await chrome.evaluate(`window.__sentinelTextsAtFetchStart.slice()`),
          ["Loading"],
        );

        // Toggle visibility / scroll to confirm observer stays detached.
        await chrome.send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 200,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await chrome.evaluate(`
          document.getElementById("list").style.height = "800px";
          window.scrollTo(0, 0);
        `);
        await new Promise((resolve) => setTimeout(resolve, 60));
        await chrome.evaluate(
          `document.getElementById("bottom-observer").scrollIntoView()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 350));

        assert.deepEqual(
          await chrome.evaluate(`window.__getPageCalls.slice()`),
          [0],
        );
        assert.equal(
          await chrome.evaluate(
            `document.getElementById("bottom-observer").textContent.trim()`,
          ),
          "End of feed",
        );
      });
    }
  },
);
