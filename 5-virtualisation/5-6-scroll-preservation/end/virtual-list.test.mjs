import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

const MARGIN = 16;

/**
 * Minimal instrumented DOM harness for testing VirtualList layout read/write
 * ordering, reflow counts, scoped element updates, and coordinate accuracy
 * without external dependencies.
 */
function createDOMEnvironment({ heightForDatum = () => 200 } = {}) {
  const metrics = {
    layoutDirty: false,
    layoutCalculations: 0,
    geometryReads: 0,
    readsAfterWriteInPhase: 0,
    wroteInCurrentUpdate: false,
    operationLog: [],
  };

  const elementsById = new Map();

  class MockStyle {
    #transform = "";
    #height = "";
    #owner;

    constructor(owner) {
      this.#owner = owner;
    }

    get transform() {
      return this.#transform;
    }

    set transform(value) {
      const next = String(value);
      this.#transform = next;
      this.#owner.transformWrites++;
      metrics.layoutDirty = true;
      metrics.wroteInCurrentUpdate = true;
      metrics.operationLog.push({
        type: "write-transform",
        id: this.#owner.id || this.#owner.tagName,
      });
    }

    get height() {
      return this.#height;
    }

    set height(value) {
      this.#height = String(value);
      metrics.layoutDirty = true;
    }
  }

  class MockElement {
    constructor(tagName = "div", id = "") {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.attributes = new Map();
      this.children = [];
      this.style = new MockStyle(this);
      this._height = 200;
      this._textContent = "";
      this.transformWrites = 0;
      this.dataYWrites = 0;
    }

    get textContent() {
      return this._textContent;
    }

    set textContent(val) {
      this._textContent = String(val);
      metrics.layoutDirty = true;
    }

    set innerHTML(html) {
      this.children = [];
      elementsById.clear();
      if (html.includes('id="container"')) {
        const container = new MockElement("div", "container");
        const topObserver = new MockElement("div", "top-observer");
        const list = new MockElement("main", "virtual-list");
        const bottomObserver = new MockElement("div", "bottom-observer");
        topObserver._height = 100;
        bottomObserver._height = 100;
        container.appendChild(topObserver);
        container.appendChild(list);
        container.appendChild(bottomObserver);
        this.appendChild(container);
        elementsById.set("container", container);
        elementsById.set("top-observer", topObserver);
        elementsById.set("virtual-list", list);
        elementsById.set("bottom-observer", bottomObserver);
      }
      metrics.layoutDirty = true;
    }

    get scrollHeight() {
      if (metrics.layoutDirty) {
        metrics.layoutDirty = false;
      }
      return 5000;
    }

    setAttribute(name, value) {
      const strVal = String(value);
      this.attributes.set(name, strVal);
      if (name === "data-y") {
        this.dataYWrites++;
        metrics.wroteInCurrentUpdate = true;
        metrics.operationLog.push({ type: "write-attr", name });
      }
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(child) {
      if (child instanceof MockDocumentFragment) {
        for (const grandChild of child.children) {
          this.children.push(grandChild);
        }
        child.children = [];
      } else {
        this.children.push(child);
      }
      metrics.layoutDirty = true;
      return child;
    }

    getBoundingClientRect() {
      metrics.geometryReads++;
      if (metrics.wroteInCurrentUpdate) {
        metrics.readsAfterWriteInPhase++;
      }
      if (metrics.layoutDirty) {
        metrics.layoutCalculations++;
        metrics.layoutDirty = false;
      }
      metrics.operationLog.push({
        type: "read-rect",
        id: this.id || this.tagName,
      });
      const yAttr = this.getAttribute("data-y");
      const top = yAttr == null ? 0 : +yAttr;
      return {
        top,
        y: top,
        bottom: top + this._height,
        height: this._height,
        width: 800,
        left: 0,
        right: 800,
        x: 0,
      };
    }
  }

  class MockDocumentFragment {
    constructor() {
      this.children = [];
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }
  }

  let observerCallback = null;

  class MockIntersectionObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe() {}
    disconnect() {}
  }

  globalThis.DocumentFragment = MockDocumentFragment;
  globalThis.IntersectionObserver = MockIntersectionObserver;
  globalThis.document = {
    body: new MockElement("body", "body"),
    getElementById(id) {
      return elementsById.get(id) ?? null;
    },
  };

  const createCard = (datum) => {
    const card = new MockElement("article");
    card.datum = datum;
    card._height = heightForDatum(datum);
    metrics.layoutDirty = true;
    return card;
  };

  const updateCard = (card, datum) => {
    card.datum = datum;
    card._height = heightForDatum(datum);
    metrics.layoutDirty = true;
  };

  const resetPhaseMetrics = () => {
    // Begin scroll update with dirty layout from newly inserted/updated DOM
    metrics.layoutDirty = true;
    metrics.layoutCalculations = 0;
    metrics.geometryReads = 0;
    metrics.readsAfterWriteInPhase = 0;
    metrics.wroteInCurrentUpdate = false;
    metrics.operationLog = [];
  };

  const triggerScroll = async (direction) => {
    const targetId = direction === "down" ? "bottom-observer" : "top-observer";
    const target = elementsById.get(targetId);
    // Intercept container.scrollHeight after #updateElement by resetting counters right before getPage resolves
    observerCallback([{ isIntersecting: true, target }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    metrics,
    elementsById,
    createCard,
    updateCard,
    resetPhaseMetrics,
    triggerScroll,
  };
}

const { VirtualList } = await import("./virtual-list.js");

describe("VirtualList.#updateElement layout batching and scoped positioning", () => {
  let pages;

  beforeEach(() => {
    pages = Array.from({ length: 10 }, (_, pageIndex) =>
      Array.from({ length: 10 }, (__, itemOffset) => {
        const index = pageIndex * 10 + itemOffset;
        return { id: index, title: `[Entry ${index}]` };
      }),
    );
  });

  it("triggers only one layout calculation per scroll update with zero reads after writes", async () => {
    const env = createDOMEnvironment({ heightForDatum: () => 200 });

    const list = new VirtualList(globalThis.document.body, {
      getPage: async (page) => {
        env.resetPhaseMetrics();
        return pages[page] ?? [];
      },
      getTemplate: env.createCard,
      updateTemplate: env.updateCard,
      pageSize: 10,
    });
    list.render();

    // Initial render (Page 0: pool 0 -> 10)
    await env.triggerScroll("down");
    assert.equal(
      env.metrics.layoutCalculations,
      1,
      "Initial load should trigger exactly 1 layout calculation",
    );
    assert.equal(
      env.metrics.readsAfterWriteInPhase,
      0,
      "Should perform 0 geometry reads after writes",
    );

    // Second page (Page 1: pool 10 -> 20, reaches poolLimit)
    await env.triggerScroll("down");
    assert.equal(
      env.metrics.layoutCalculations,
      1,
      "Second page load should trigger exactly 1 layout calculation",
    );
    assert.equal(
      env.metrics.readsAfterWriteInPhase,
      0,
      "Should perform 0 geometry reads after writes",
    );

    // Recycled downward scroll (Page 2: pool full at 20)
    await env.triggerScroll("down");
    assert.equal(
      env.metrics.layoutCalculations,
      1,
      "Downward recycle should trigger exactly 1 layout calculation",
    );
    assert.equal(
      env.metrics.readsAfterWriteInPhase,
      0,
      "Downward recycle should perform 0 geometry reads after writes",
    );

    // Recycled upward scroll (back to Page 0)
    await env.triggerScroll("up");
    assert.equal(
      env.metrics.layoutCalculations,
      1,
      "Upward recycle should trigger exactly 1 layout calculation",
    );
    assert.equal(
      env.metrics.readsAfterWriteInPhase,
      0,
      "Upward recycle should perform 0 geometry reads after writes",
    );
  });

  it("scopes downward positioning to newly added or recycled elements when the pool is full", async () => {
    const env = createDOMEnvironment({ heightForDatum: () => 200 });
    const list = new VirtualList(globalThis.document.body, {
      getPage: async (page) => pages[page] ?? [],
      getTemplate: env.createCard,
      updateTemplate: env.updateCard,
      pageSize: 10,
    });
    list.render();

    // Load Page 0 and Page 1 to fill pool (20 elements)
    await env.triggerScroll("down");
    assert.equal(list.pool.length, 10);
    assert.equal(list.pool[0].getAttribute("data-y"), "0");
    assert.equal(list.pool[0].style.transform, "");

    // Reset element write counters before loading Page 1
    for (const el of list.pool) {
      el.transformWrites = 0;
      el.dataYWrites = 0;
    }

    await env.triggerScroll("down");
    assert.equal(list.pool.length, 20);
    // Existing elements 0..9 should not be rewritten when Page 1 fills the pool
    for (let i = 0; i < 10; i++) {
      assert.equal(
        list.pool[i].dataYWrites,
        0,
        `Unchanged element ${i} should not rewrite data-y on Page 1`,
      );
      assert.equal(
        list.pool[i].transformWrites,
        0,
        `Unchanged element ${i} should not rewrite transform on Page 1`,
      );
    }
    for (let i = 10; i < 20; i++) {
      assert.equal(
        list.pool[i].dataYWrites,
        1,
        `New element ${i} should set data-y once`,
      );
      assert.equal(
        list.pool[i].transformWrites,
        1,
        `New element ${i} should set transform once`,
      );
    }

    // Reset element write counters before recycling on Page 2
    for (const el of list.pool) {
      el.transformWrites = 0;
      el.dataYWrites = 0;
    }

    await env.triggerScroll("down");
    // After recycling: indices 0..9 are unchanged (Page 1), indices 10..19 are recycled (Page 2)
    for (let i = 0; i < 10; i++) {
      assert.equal(
        list.pool[i].dataYWrites,
        0,
        `Unchanged element ${i} should not rewrite data-y during downward recycle`,
      );
      assert.equal(
        list.pool[i].transformWrites,
        0,
        `Unchanged element ${i} should not rewrite transform during downward recycle`,
      );
    }
    for (let i = 10; i < 20; i++) {
      assert.equal(
        list.pool[i].dataYWrites,
        1,
        `Recycled element ${i} should update data-y once`,
      );
      assert.equal(
        list.pool[i].transformWrites,
        1,
        `Recycled element ${i} should update transform once`,
      );
    }
  });

  it("preserves exact element and observer coordinates across downward and upward scroll cycles", async () => {
    const cardHeight = 200;
    const stride = cardHeight + 2 * MARGIN; // 232
    const env = createDOMEnvironment({ heightForDatum: () => cardHeight });

    const list = new VirtualList(globalThis.document.body, {
      getPage: async (page) => pages[page] ?? [],
      getTemplate: env.createCard,
      updateTemplate: env.updateCard,
      pageSize: 10,
    });
    list.render();

    const topObserver = env.elementsById.get("top-observer");
    const bottomObserver = env.elementsById.get("bottom-observer");

    // Page 0: items 0..9
    await env.triggerScroll("down");
    assert.deepEqual(
      list.pool.map((el) => +el.getAttribute("data-y")),
      Array.from({ length: 10 }, (_, i) => i * stride),
    );
    assert.equal(topObserver.style.transform, "translateY(0px)");
    assert.equal(
      bottomObserver.style.transform,
      `translateY(${10 * stride}px)`,
    );

    // Page 1: items 0..19
    await env.triggerScroll("down");
    assert.deepEqual(
      list.pool.map((el) => +el.getAttribute("data-y")),
      Array.from({ length: 20 }, (_, i) => i * stride),
    );
    assert.equal(topObserver.style.transform, "translateY(0px)");
    assert.equal(
      bottomObserver.style.transform,
      `translateY(${20 * stride}px)`,
    );

    // Page 2 & Page 3 downward: window becomes items 20..39
    await env.triggerScroll("down");
    await env.triggerScroll("down");
    assert.deepEqual(
      list.pool.map((el) => +el.getAttribute("data-y")),
      Array.from({ length: 20 }, (_, i) => (20 + i) * stride),
    );
    assert.equal(topObserver.style.transform, `translateY(${20 * stride}px)`);
    assert.equal(
      bottomObserver.style.transform,
      `translateY(${40 * stride}px)`,
    );

    // Scroll back up twice: window returns to items 0..19
    await env.triggerScroll("up");
    assert.deepEqual(
      list.pool.map((el) => +el.getAttribute("data-y")),
      Array.from({ length: 20 }, (_, i) => (10 + i) * stride),
    );
    assert.equal(topObserver.style.transform, `translateY(${10 * stride}px)`);
    assert.equal(
      bottomObserver.style.transform,
      `translateY(${30 * stride}px)`,
    );

    await env.triggerScroll("up");
    assert.deepEqual(
      list.pool.map((el) => +el.getAttribute("data-y")),
      Array.from({ length: 20 }, (_, i) => i * stride),
    );
    assert.equal(list.pool[0].style.transform, "translateY(0px)");
    assert.equal(topObserver.style.transform, "translateY(0px)");
    assert.equal(
      bottomObserver.style.transform,
      `translateY(${20 * stride}px)`,
    );
  });

  it("prevents negative coordinate shifts during upward recycling near start = 0", async () => {
    const env = createDOMEnvironment({ heightForDatum: () => 200 });
    const list = new VirtualList(globalThis.document.body, {
      getPage: async (page) => pages[page] ?? [],
      getTemplate: env.createCard,
      updateTemplate: env.updateCard,
      pageSize: 10,
    });
    list.render();

    // Fill pool and scroll down one page (items 10..29)
    await env.triggerScroll("down");
    await env.triggerScroll("down");
    await env.triggerScroll("down");

    // Simulate user expanding contenteditable card at index 0 (Entry 10) before scrolling up to start = 0
    list.pool[0]._height = 600;

    await env.triggerScroll("up");
    for (let i = 0; i < list.pool.length; i++) {
      const yPos = +list.pool[i].getAttribute("data-y");
      assert.ok(
        yPos >= 0,
        `Expected non-negative coordinate at index ${i}, got ${yPos}`,
      );
    }
    assert.equal(
      env.elementsById.get("top-observer").style.transform,
      "translateY(0px)",
    );
  });
});
