import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createCardElement, updateCardElement } from "./card.js";
import {
  createCardElement as beginCreateCardElement,
  getHeading as beginGetHeading,
} from "../3-mutation-observer/begin/utils.js";
import {
  createCardElement as endCreateCardElement,
  getHeading as endGetHeading,
} from "../3-mutation-observer/end/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Minimal mock DOM element for unit testing tag and class lookups.
 */
class MockCardNode {
  constructor(tagName, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attrs));
    this.children = children;
    this.textContent = "";
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  cloneNode(deep = false) {
    const clonedChildren = deep
      ? this.children.map((child) => child.cloneNode(true))
      : [];
    const copy = new MockCardNode(
      this.tagName,
      Object.fromEntries(this.attributes.entries()),
      clonedChildren,
    );
    copy.textContent = this.textContent;
    return copy;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (matchesSelector(child, selector)) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  getElementsByTagName(tagName) {
    const target = tagName.toUpperCase();
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.tagName === target) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function matchesSelector(node, selector) {
  if (selector.startsWith(".")) {
    const className = selector.slice(1);
    const classes = (node.getAttribute("class") ?? "").split(/\s+/);
    return classes.includes(className);
  }
  return node.tagName === selector.toUpperCase();
}

function createMockTemplate(rootNode) {
  return {
    content: {
      firstElementChild: rootNode,
      cloneNode() {
        return { firstElementChild: rootNode.cloneNode(true) };
      },
    },
  };
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Cannot find a Chrome binary.");
}

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = new URL(req.url, "http://127.0.0.1").pathname;
      const resolvedPath = path.resolve(rootDir, `.${urlPath}`);
      if (!resolvedPath.startsWith(rootDir) || !existsSync(resolvedPath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(resolvedPath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      });
      res.end(readFileSync(resolvedPath));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function launchHeadlessChrome() {
  const chromeBin = findChromeBinary();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "card-util-test-"));

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
      "--window-size=1280,900",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const debugPort = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Chrome DevTools port timed out: ${stderr}`));
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
      reject(new Error(`Chrome exited early with code ${code}`));
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
  const pageErrors = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(
        message.params?.exceptionDetails?.exception?.description ??
          message.params?.exceptionDetails?.text ??
          "Unknown runtime exception",
      );
    }
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

  const rejectAllPending = () => {
    for (const { reject } of pending.values()) {
      reject(new Error("WebSocket closed"));
    }
    pending.clear();
  };
  ws.addEventListener("close", rejectAllPending, { once: true });
  ws.addEventListener("error", rejectAllPending, { once: true });

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
      ws.close();
    } catch {}
    rejectAllPending();
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => proc.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await new Promise((resolve) => proc.once("exit", resolve));
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }

  return { send, evaluate, pageErrors, cleanup };
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(`Boolean(${predicateExpr})`);
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition timed out: ${predicateExpr}`);
}

describe("utils/card.js unit behavior", () => {
  it("re-exports shared createCardElement from 3-mutation-observer utils modules", () => {
    assert.equal(beginCreateCardElement, createCardElement);
    assert.equal(endCreateCardElement, createCardElement);
    assert.equal(typeof beginGetHeading, "function");
    assert.equal(typeof endGetHeading, "function");
  });

  it("creates and updates tag-based card templates while preserving contenteditable attributes", () => {
    const template = createMockTemplate(
      new MockCardNode("article", { class: "card" }, [
        new MockCardNode("h3"),
        new MockCardNode("div", { class: "card__body" }, [
          new MockCardNode("div", { class: "card__body__image" }),
          new MockCardNode("section", {
            class: "card__body__content",
            contenteditable: "true",
          }),
        ]),
      ]),
    );

    const card = createCardElement("Initial Title", "Initial Body", template);
    const [titleEl] = card.getElementsByTagName("h3");
    const [bodyEl] = card.getElementsByTagName("section");

    assert.equal(titleEl.textContent, "Initial Title");
    assert.equal(bodyEl.textContent, "Initial Body");
    assert.equal(bodyEl.getAttribute("contenteditable"), "true");

    updateCardElement(card, { title: "Recycled Title", body: "Recycled Body" });
    assert.equal(titleEl.textContent, "Recycled Title");
    assert.equal(bodyEl.textContent, "Recycled Body");
    assert.equal(bodyEl.getAttribute("contenteditable"), "true");
  });

  it("supports CSS class selectors on non-h3 and non-section elements", () => {
    const template = createMockTemplate(
      new MockCardNode("article", { class: "card" }, [
        new MockCardNode("div", { class: "card__title" }),
        new MockCardNode("div", { class: "card__body" }, [
          new MockCardNode("div", {
            class: "card__body__content",
            contenteditable: "true",
          }),
        ]),
      ]),
    );

    const card = createCardElement(
      { title: "Class Title", body: "Class Body" },
      template,
    );
    assert.equal(card.querySelector(".card__title").textContent, "Class Title");
    assert.equal(
      card.querySelector(".card__body__content").textContent,
      "Class Body",
    );
    assert.equal(
      card
        .querySelector(".card__body__content")
        .getAttribute("contenteditable"),
      "true",
    );

    updateCardElement(card, "Updated Class Title", "Updated Class Body");
    assert.equal(
      card.querySelector(".card__title").textContent,
      "Updated Class Title",
    );
    assert.equal(
      card.querySelector(".card__body__content").textContent,
      "Updated Class Body",
    );
  });

  it("supports VirtualList two-argument getTemplate(undefined, datum) calls", () => {
    const template = createMockTemplate(
      new MockCardNode("article", { class: "card" }, [
        new MockCardNode("h3"),
        new MockCardNode("section", { class: "card__body__content" }),
      ]),
    );
    const prevDocument = globalThis.document;
    globalThis.document = {
      getElementById(id) {
        return id === "card_template" ? template : null;
      },
    };
    try {
      const card = createCardElement(undefined, {
        title: "Legacy Signature Title",
        body: "Legacy Signature Body",
      });
      assert.equal(
        card.querySelector("h3").textContent,
        "Legacy Signature Title",
      );
      assert.equal(
        card.querySelector(".card__body__content").textContent,
        "Legacy Signature Body",
      );
    } finally {
      globalThis.document = prevDocument;
    }
  });
});

describe("curriculum exercises render cards with utils/card.js in Chrome", () => {
  it("renders cards without runtime errors across 1-dom, 2-intersection-observer, 3-mutation-observer, and 5-virtualisation", async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(() => {
      server.closeAllConnections?.();
      server.close();
    });

    const chrome = await launchHeadlessChrome();
    t.after(async () => {
      await chrome.cleanup();
    });

    await chrome.send("Page.enable");
    await chrome.send("Runtime.enable");

    // 1. Verify 1-dom/end/index.html
    chrome.pageErrors.length = 0;
    await chrome.send("Page.navigate", {
      url: `${baseUrl}/1-dom/end/index.html`,
    });
    await waitForCondition(
      chrome.evaluate,
      `document.querySelectorAll('#container .card').length === 1`,
    );
    const domCard = await chrome.evaluate(`({
            title: document.querySelector('#container .card h3')?.textContent,
            body: document.querySelector('#container .card .card__body__content')?.textContent,
        })`);
    assert.deepEqual(domCard, {
      title: "Frontend System Design: Fundamentals",
      body: "This is a random content",
    });
    assert.deepEqual(chrome.pageErrors, []);

    // 2. Verify 2-intersection-observer/end/index.html
    chrome.pageErrors.length = 0;
    await chrome.send("Page.navigate", {
      url: `${baseUrl}/2-intersection-observer/end/index.html`,
    });
    await waitForCondition(
      chrome.evaluate,
      `document.querySelectorAll('#list .card').length === 10`,
    );
    const ioCard = await chrome.evaluate(`({
            title: document.querySelector('#list .card .card__title')?.textContent,
            body: document.querySelector('#list .card .card__body__content')?.textContent,
        })`);
    assert.deepEqual(ioCard, {
      title: "[Entry 0] - Fundamentals of Frontend System Design",
      body: "[Entry 0] - Learning to use Intersection Observer",
    });
    assert.deepEqual(chrome.pageErrors, []);

    // 3. Verify 3-mutation-observer/begin/index.html and 3-mutation-observer/end/index.html
    chrome.pageErrors.length = 0;
    await chrome.send("Page.navigate", {
      url: `${baseUrl}/3-mutation-observer/begin/index.html`,
    });
    await waitForCondition(
      chrome.evaluate,
      `document.querySelectorAll('#list .card').length === 10`,
    );
    assert.deepEqual(chrome.pageErrors, []);

    chrome.pageErrors.length = 0;
    await chrome.send("Page.navigate", {
      url: `${baseUrl}/3-mutation-observer/end/index.html`,
    });
    await waitForCondition(
      chrome.evaluate,
      `document.querySelectorAll('#list .card').length === 10`,
    );
    assert.deepEqual(chrome.pageErrors, []);

    // 4. Verify 5-virtualisation/5-3-property-model-and-loading/end/index.html
    chrome.pageErrors.length = 0;
    await chrome.send("Page.navigate", {
      url: `${baseUrl}/5-virtualisation/5-3-property-model-and-loading/end/index.html`,
    });
    await waitForCondition(
      chrome.evaluate,
      `document.querySelectorAll('#virtual-list .card').length === 10`,
    );
    const virt53Card = await chrome.evaluate(`({
            title: document.querySelector('#virtual-list .card h3')?.textContent,
            editable: document.querySelector('#virtual-list .card .card__body__content')?.getAttribute('contenteditable'),
        })`);
    assert.deepEqual(virt53Card, {
      title: "[Entry 0] - Frontend System Design",
      editable: "true",
    });
    assert.deepEqual(chrome.pageErrors, []);

    // 5. Verify 5-virtualisation/5-5-top-observer/end/index.html including node recycling
    chrome.pageErrors.length = 0;
    await chrome.send("Page.navigate", {
      url: `${baseUrl}/5-virtualisation/5-5-top-observer/end/index.html`,
    });
    await waitForCondition(
      chrome.evaluate,
      `document.querySelectorAll('#virtual-list .card').length === 10`,
    );

    // Scroll bottom observer into view to fill pool to 20 cards
    await chrome.evaluate(
      `document.getElementById('bottom-observer').scrollIntoView()`,
    );
    await waitForCondition(
      chrome.evaluate,
      `document.querySelectorAll('#virtual-list .card').length === 20`,
    );

    // Tag initial 20 DOM elements to verify in-place recycling via updateCardElement
    await chrome.evaluate(`
            document.querySelectorAll('#virtual-list .card').forEach((el, idx) => {
                el.dataset.poolOrigin = String(idx);
            });
            document.getElementById('bottom-observer').scrollIntoView();
        `);
    await waitForCondition(
      chrome.evaluate,
      `Array.from(document.querySelectorAll('#virtual-list .card h3')).some((el) => el.textContent.includes('[Entry 20]'))`,
    );

    const recycleSummary = await chrome.evaluate(`(() => {
            const cards = Array.from(document.querySelectorAll('#virtual-list .card'));
            return {
                count: cards.length,
                allReused: cards.every((el) => el.dataset.poolOrigin !== undefined),
                allEditable: cards.every(
                    (el) => el.querySelector('.card__body__content')?.getAttribute('contenteditable') === 'true'
                ),
            };
        })()`);
    assert.deepEqual(recycleSummary, {
      count: 20,
      allReused: true,
      allEditable: true,
    });
    assert.deepEqual(chrome.pageErrors, []);
  });
});
