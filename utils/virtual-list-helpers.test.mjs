import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { MARGIN, getList, y } from "./virtual-list-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const VIRTUAL_LIST_MODULES = [
  "5-virtualisation/5-4-1-elements-pool-and-recycling-preparation/end/virtual-list.js",
  "5-virtualisation/5-4-2-elements-pool-and-recycling-rendering/begin/virtual-list.js",
  "5-virtualisation/5-4-2-elements-pool-and-recycling-rendering/end/virtual-list.js",
  "5-virtualisation/5-5-top-observer/begin/virtual-list.js",
  "5-virtualisation/5-5-top-observer/end/virtual-list.js",
  "5-virtualisation/5-6-scroll-preservation/begin/virtual-list.js",
  "5-virtualisation/5-6-scroll-preservation/end/virtual-list.js",
];

class MockElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  appendChild(node) {
    if (node.children && node.isFragment) {
      this.children.push(...node.children);
      node.children = [];
      return node;
    }
    this.children.push(node);
    return node;
  }

  getBoundingClientRect() {
    return {
      height: 100,
      top: 0,
      bottom: 100,
      left: 0,
      right: 300,
      width: 300,
    };
  }

  get scrollHeight() {
    return 500;
  }
}

describe("utils/virtual-list-helpers.js", () => {
  it("exports MARGIN constant equal to 16", () => {
    assert.equal(typeof MARGIN, "number");
    assert.equal(MARGIN, 16);
  });

  it("exports getList returning #virtual-list from document", () => {
    const listEl = new MockElement("main", "virtual-list");
    globalThis.document = {
      getElementById(id) {
        return id === "virtual-list" ? listEl : null;
      },
    };

    assert.equal(getList(), listEl);

    globalThis.document = {
      getElementById() {
        return null;
      },
    };
    assert.equal(getList(), null);
  });

  it("exports y helper that gets and sets data-y with safe optional chaining", () => {
    const el = new MockElement("article");
    assert.equal(y(el), null);

    assert.equal(y(el, 0), "0");
    assert.equal(y(el), "0");

    assert.equal(y(el, 232), "232");
    assert.equal(y(el, undefined), "232");
    assert.equal(y(el, null), "232");

    assert.doesNotThrow(() => y(null));
    assert.doesNotThrow(() => y(undefined));
    assert.doesNotThrow(() => y(null, 128));
    assert.doesNotThrow(() => y(undefined, "64"));
    assert.equal(y(null), undefined);
    assert.equal(y(undefined, 128), undefined);
  });

  it("replaces local MARGIN, getList, and y definitions across all active virtualization modules", async () => {
    for (const relPath of VIRTUAL_LIST_MODULES) {
      const absPath = resolve(repoRoot, relPath);
      const source = await readFile(absPath, "utf8");

      assert.match(
        source,
        /import\s*\{\s*MARGIN\s*,\s*getList\s*,\s*y\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/utils\/virtual-list-helpers\.js["'];?/,
        `Expected ${relPath} to import {MARGIN, getList, y} from ../../../utils/virtual-list-helpers.js`,
      );
      assert.doesNotMatch(
        source,
        /\bconst\s+MARGIN\b/,
        `Unexpected local MARGIN in ${relPath}`,
      );
      assert.doesNotMatch(
        source,
        /\bfunction\s+getList\b/,
        `Unexpected local getList in ${relPath}`,
      );
      assert.doesNotMatch(
        source,
        /\bfunction\s+y\b/,
        `Unexpected local y in ${relPath}`,
      );
    }
  });

  it("executes render and bottom observer lifecycle across all active virtualization modules without runtime errors", async () => {
    for (const relPath of VIRTUAL_LIST_MODULES) {
      const elementsById = new Map();
      let observerCallback = null;

      const root = new MockElement("body");
      Object.defineProperty(root, "innerHTML", {
        get() {
          return this._html ?? "";
        },
        set(html) {
          this._html = html;
          elementsById.clear();
          const container = new MockElement("div", "container");
          const topObserver = new MockElement("div", "top-observer");
          const list = new MockElement("main", "virtual-list");
          const bottomObserver = new MockElement("div", "bottom-observer");
          container.appendChild(topObserver);
          container.appendChild(list);
          container.appendChild(bottomObserver);
          elementsById.set("container", container);
          elementsById.set("top-observer", topObserver);
          elementsById.set("virtual-list", list);
          elementsById.set("bottom-observer", bottomObserver);
        },
      });

      globalThis.document = {
        getElementById(id) {
          return elementsById.get(id) ?? null;
        },
      };
      globalThis.DocumentFragment = class {
        constructor() {
          this.isFragment = true;
          this.children = [];
        }
        appendChild(node) {
          this.children.push(node);
          return node;
        }
      };
      globalThis.IntersectionObserver = class {
        constructor(cb) {
          observerCallback = cb;
        }
        observe() {}
        disconnect() {}
      };

      const mod = await import(resolve(repoRoot, relPath));
      assert.equal(
        typeof mod.VirtualList,
        "function",
        `${relPath} must export VirtualList`,
      );

      const instance = new mod.VirtualList(root, {
        pageSize: 2,
        getPage: async (page) => [
          { title: `Item ${page}-0` },
          { title: `Item ${page}-1` },
        ],
        getTemplate: (datum) => {
          const card = new MockElement("article");
          card.textContent = datum.title;
          return card;
        },
        updateTemplate: (el, datum) => {
          el.textContent = datum.title;
        },
      });

      instance.render();
      observerCallback([
        { isIntersecting: true, target: elementsById.get("bottom-observer") },
      ]);
      await new Promise((r) => setImmediate(r));
      assert.equal(
        elementsById.get("virtual-list").children.length,
        2,
        `${relPath} should mount initial page`,
      );
    }
  });
});
