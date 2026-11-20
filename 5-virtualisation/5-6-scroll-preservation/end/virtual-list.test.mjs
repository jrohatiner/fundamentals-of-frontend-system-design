import assert from "node:assert/strict";
import test, { describe, it, beforeEach } from "node:test";
import { VirtualList } from "./virtual-list.js";
import { initMockDB } from "../../../utils/db.js";

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

describe("VirtualList upward scroll compensation and template update ordering", () => {
    let pages;

    beforeEach(() => {
        delete globalThis.window;
        pages = Array.from({ length: 6 }, (_, pageIndex) =>
            Array.from({ length: 10 }, (__, itemOffset) => {
                const index = pageIndex * 10 + itemOffset;
                return { id: index, title: `[Entry ${index}]` };
            })
        );
    });

    function installMockWindow(initialScrollY = 0) {
        const scrollListeners = [];
        const scrollCalls = [];
        const win = {
            scrollX: 0,
            scrollY: initialScrollY,
            innerHeight: 800,
            scrollBy(x, y) {
                this.scrollX += x;
                this.scrollY += y;
                scrollCalls.push({ type: "scrollBy", x, y, resultingScrollY: this.scrollY });
            },
            scrollTo(x, y) {
                const deltaY = y - this.scrollY;
                this.scrollX = x;
                this.scrollY = y;
                scrollCalls.push({ type: "scrollTo", x, y, deltaY, resultingScrollY: this.scrollY });
            },
            addEventListener(event, handler) {
                if (event === "scroll") {
                    scrollListeners.push(handler);
                }
            },
            removeEventListener(event, handler) {
                if (event === "scroll") {
                    const idx = scrollListeners.indexOf(handler);
                    if (idx !== -1) {
                        scrollListeners.splice(idx, 1);
                    }
                }
            },
            dispatchScroll(nextScrollY) {
                this.scrollY = nextScrollY;
                for (const listener of [...scrollListeners]) {
                    listener();
                }
            },
        };
        globalThis.window = win;
        return { win, scrollCalls };
    }

    it("populates template data before measuring recycled element heights during upward pagination", async () => {
        const callSequence = [];
        const heightForDatum = (datum) => 140 + (datum.id % 5) * 40;
        const env = createDOMEnvironment({ heightForDatum });

        const list = new VirtualList(globalThis.document.body, {
            getPage: async (page) => pages[page] ?? [],
            getTemplate: (datum) => {
                const card = env.createCard(datum);
                const origGetRect = card.getBoundingClientRect.bind(card);
                card.getBoundingClientRect = () => {
                    callSequence.push({ op: "measure", datumId: card.datum.id, height: card._height });
                    return origGetRect();
                };
                return card;
            },
            updateTemplate: (card, datum) => {
                callSequence.push({ op: "updateTemplate", datumId: datum.id });
                env.updateCard(card, datum);
            },
            pageSize: 10,
        });
        list.render();

        // Populate pages 0, 1, 2 (active items 10..29)
        await env.triggerScroll("down");
        await env.triggerScroll("down");
        await env.triggerScroll("down");

        callSequence.length = 0;
        await env.triggerScroll("up");

        const updateIndices = callSequence
            .map((entry, idx) => (entry.op === "updateTemplate" ? idx : -1))
            .filter((idx) => idx !== -1);
        const measureIndices = callSequence
            .map((entry, idx) => (entry.op === "measure" ? idx : -1))
            .filter((idx) => idx !== -1);

        assert.equal(updateIndices.length, 10, "Should update all 10 recycled elements");
        assert.ok(measureIndices.length >= 10, "Should measure all newly prepended elements");
        assert.ok(
            Math.max(...updateIndices) < Math.min(...measureIndices),
            "All updateTemplate calls must complete before any getBoundingClientRect height reads"
        );

        // Verify measured heights reflect the newly bound Entries 0..9 (not stale Entries 20..29)
        const measuredIds = callSequence.filter((e) => e.op === "measure").slice(0, 10).map((e) => e.datumId);
        assert.deepEqual(measuredIds, Array.from({ length: 10 }, (_, i) => i));

        // Verify exact spacing without overlaps or gaps for variable heights
        let expectedY = 0;
        for (let i = 0; i < list.pool.length; i++) {
            const actualY = +list.pool[i].getAttribute("data-y");
            assert.equal(actualY, expectedY, `Card ${i} should sit at exact cumulative variable height`);
            expectedY += heightForDatum(list.pool[i].datum) + 2 * MARGIN;
        }
        assert.equal(env.elementsById.get("top-observer").style.transform, "translateY(0px)");
        assert.equal(env.elementsById.get("bottom-observer").style.transform, `translateY(${expectedY}px)`);
    });

    it("preserves exact screen position of top visible card and prevents negative coordinates when prepended templates grow taller", async () => {
        // Initial downward pass uses compact heights (180px), upward pass returns expanded heights (320px) for Page 0
        let expandPageZero = false;
        const heightForDatum = (datum) => (expandPageZero && datum.id < 10 ? 320 : 180);
        const env = createDOMEnvironment({ heightForDatum });
        const { win, scrollCalls } = installMockWindow(0);

        const list = new VirtualList(globalThis.document.body, {
            getPage: async (page) => pages[page] ?? [],
            getTemplate: env.createCard,
            updateTemplate: env.updateCard,
            pageSize: 10,
        });
        list.render();

        // Load Pages 0, 1, 2 (active items 10..29; Entry 10 sits at 10 * (180 + 32) = 2120)
        await env.triggerScroll("down");
        await env.triggerScroll("down");
        await env.triggerScroll("down");

        const anchorCard = list.pool[0]; // Entry 10
        const anchorYBefore = +anchorCard.getAttribute("data-y");
        assert.equal(anchorYBefore, 2120);

        // User is reading Entry 10 near the top of the viewport (viewport offset = +40px)
        win.scrollY = 2080;
        const screenOffsetBefore = anchorYBefore - win.scrollY;

        // Now Page 0 has taller content (10 * (320 + 32) = 3520 > 2120)
        expandPageZero = true;
        scrollCalls.length = 0;
        await env.triggerScroll("up");

        // Coordinate at start = 0 must never go negative and cards must not overlap
        for (let i = 0; i < list.pool.length; i++) {
            const yPos = +list.pool[i].getAttribute("data-y");
            assert.ok(yPos >= 0, `Card ${i} must have non-negative translateY, got ${yPos}`);
            if (i > 0) {
                const prevY = +list.pool[i - 1].getAttribute("data-y");
                const expectedStride = list.pool[i - 1]._height + 2 * MARGIN;
                assert.equal(yPos, prevY + expectedStride, `Card ${i} must not overlap Card ${i - 1}`);
            }
        }

        const anchorYAfter = +anchorCard.getAttribute("data-y");
        assert.equal(anchorYAfter, 3520);
        assert.equal(scrollCalls.length, 1, "Should synchronously adjust window scroll once");
        assert.equal(scrollCalls[0].y, 1400, "Scroll delta should equal measured height delta (3520 - 2120)");

        const screenOffsetAfter = anchorYAfter - win.scrollY;
        assert.equal(screenOffsetAfter, screenOffsetBefore, "Top visible card must retain its exact screen position");
        assert.equal(list.pool.length, list.poolLimit, "Pool must retain fixed DOM node count pageSize * 2");
        delete globalThis.window;
    });

    it("does not strand #top-observer below the viewport when scrolling rapidly to scrollY = 0 during fetch latency", async () => {
        const cardHeight = 200;
        const stride = cardHeight + 2 * MARGIN; // 232
        const env = createDOMEnvironment({ heightForDatum: () => cardHeight });
        const { win } = installMockWindow(0);

        let resolvePendingTopFetch = null;
        const list = new VirtualList(globalThis.document.body, {
            getPage: (page) => {
                if (resolvePendingTopFetch === "intercept") {
                    return new Promise((resolve) => {
                        resolvePendingTopFetch = () => resolve(pages[page] ?? []);
                    });
                }
                return Promise.resolve(pages[page] ?? []);
            },
            getTemplate: env.createCard,
            updateTemplate: env.updateCard,
            pageSize: 10,
        });
        list.render();

        // Scroll down to Pages 0..3 so active pool holds items 20..39 (start = 2, topY = 4640)
        await env.triggerScroll("down");
        await env.triggerScroll("down");
        await env.triggerScroll("down");
        await env.triggerScroll("down");

        const topObserver = env.elementsById.get("top-observer");
        assert.equal(topObserver.style.transform, `translateY(${20 * stride}px)`);

        // Simulate user jumping rapidly to scrollY = 0 while DB fetch is delayed
        resolvePendingTopFetch = "intercept";
        win.dispatchScroll(0);
        assert.equal(typeof resolvePendingTopFetch, "function", "Rapid scroll above topY should initiate top page fetch");
        assert.equal(win.scrollY, 0);

        // Resolve delayed fetch for Page 1 (items 10..19, new topY = 2320)
        resolvePendingTopFetch();
        resolvePendingTopFetch = null;
        await new Promise((resolve) => setTimeout(resolve, 0));

        const newTopObserverY = +list.pool[0].getAttribute("data-y");
        assert.equal(newTopObserverY, 10 * stride);
        assert.equal(topObserver.style.transform, `translateY(${10 * stride}px)`);

        // #top-observer screen position (newTopObserverY - win.scrollY) must be inside viewport [0, innerHeight]
        const topObserverScreenY = newTopObserverY - win.scrollY;
        assert.ok(
            topObserverScreenY >= 0 && topObserverScreenY < win.innerHeight,
            `#top-observer must remain inside visible viewport, got screenY=${topObserverScreenY}`
        );
        delete globalThis.window;
    });

    it("synchronizes container.style.height across both downward and upward pagination", async () => {
        const env = createDOMEnvironment({ heightForDatum: (d) => 150 + (d.id % 3) * 30 });
        const container = () => env.elementsById.get("container");

        // Compute realistic container scrollHeight based on bottom-most positioned child/observer
        const list = new VirtualList(globalThis.document.body, {
            getPage: async (page) => pages[page] ?? [],
            getTemplate: env.createCard,
            updateTemplate: env.updateCard,
            pageSize: 10,
        });
        list.render();

        Object.defineProperty(container(), "scrollHeight", {
            get() {
                const explicitHeight = parseFloat(this.style.height) || 0;
                const bottomObs = env.elementsById.get("bottom-observer");
                const match = bottomObs.style.transform.match(/translateY\(([-\d.]+)px\)/);
                const bottomY = match ? parseFloat(match[1]) + bottomObs._height : 0;
                return Math.max(explicitHeight, bottomY);
            },
        });

        await env.triggerScroll("down");
        const heightPage0 = parseFloat(container().style.height);
        assert.ok(heightPage0 > 0);

        await env.triggerScroll("down");
        const heightPage1 = parseFloat(container().style.height);
        assert.ok(heightPage1 > heightPage0);

        await env.triggerScroll("down");
        const heightPage2 = parseFloat(container().style.height);
        assert.ok(heightPage2 > heightPage1);

        // Scroll back up to start = 0: container.style.height must synchronize back to Page 0..1 active height
        await env.triggerScroll("up");
        const heightAfterUp = parseFloat(container().style.height);
        assert.equal(heightAfterUp, heightPage1, "Container height must synchronize with active list height on upward pagination");
    });
});

describe("VirtualList terminal boundary guard", () => {
  it("halts pagination cleanly without throwing TypeError when scrolling past page index 9", async () => {
    const env = createDOMEnvironment({ heightForDatum: () => 200 });
    const requestedPages = [];

    // Mirror utils/db.js: 100 entries across 10 pages (indices 0..9), returning [] past index 9
    const dbPages = Array.from({ length: 10 }, (_, pageIndex) =>
      Array.from({ length: 10 }, (__, itemOffset) => {
        const index = pageIndex * 10 + itemOffset;
        return {
          title: `[Entry ${index}] - Frontend System Design`,
          body: `[Entry ${index}] - Frontend System Design`,
        };
      }),
    );

    // Mirror index.html updateTemplate which throws TypeError if datum is undefined
    const strictCreateCard = (datum) => {
      const card = env.createCard(datum);
      card.titleText = datum.title;
      card.bodyText = datum.body;
      return card;
    };
    const strictUpdateCard = (card, datum) => {
      // Accessing datum.title / datum.body throws TypeError if datum is undefined
      [card.titleText, card.bodyText] = [datum.title, datum.body];
      env.updateCard(card, datum);
    };

    const list = new VirtualList(globalThis.document.body, {
      getPage: async (page) => {
        requestedPages.push(page);
        return page < 0 || page > dbPages.length - 1 ? [] : dbPages[page];
      },
      getTemplate: strictCreateCard,
      updateTemplate: strictUpdateCard,
      pageSize: 10,
    });
    list.render();

    // Scroll through pages 0..9 (10 valid pages)
    for (let page = 0; page <= 9; page++) {
      await env.triggerScroll("down");
    }

    assert.equal(list.start, 8);
    assert.equal(list.end, 10);
    assert.deepEqual(
      list.pool.map((el) => el.titleText),
      Array.from(
        { length: 20 },
        (_, i) => `[Entry ${80 + i}] - Frontend System Design`,
      ),
    );

    // Scroll past page index 9: page 10 returns [], setting #hasMore = false
    await assert.doesNotReject(() => env.triggerScroll("down"));
    assert.equal(list.start, 8);
    assert.equal(list.end, 10);
    assert.deepEqual(requestedPages, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Subsequent bottom intersections must be suppressed without calling getPage again
    await env.triggerScroll("down");
    await env.triggerScroll("down");
    assert.deepEqual(
      requestedPages,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      "getPage must not be called after terminal boundary is reached",
    );
    assert.deepEqual(
      list.pool.map((el) => el.titleText),
      Array.from(
        { length: 20 },
        (_, i) => `[Entry ${80 + i}] - Frontend System Design`,
      ),
    );

    // Scrolling back up re-enables forward pagination for unloaded valid pages
    await env.triggerScroll("up");
    assert.equal(list.start, 7);
    assert.equal(list.end, 9);
    assert.deepEqual(
      list.pool.map((el) => el.titleText),
      Array.from(
        { length: 20 },
        (_, i) => `[Entry ${70 + i}] - Frontend System Design`,
      ),
    );

    await env.triggerScroll("down");
    assert.equal(list.start, 8);
    assert.equal(list.end, 10);
    assert.deepEqual(
      list.pool.map((el) => el.titleText),
      Array.from(
        { length: 20 },
        (_, i) => `[Entry ${80 + i}] - Frontend System Design`,
      ),
    );
  });

  it("exits early before recycling elements when a page shorter than pageSize is returned", async () => {
    const env = createDOMEnvironment({ heightForDatum: () => 200 });
    const requestedPages = [];
    let updateCalls = 0;

    // 25 items total with pageSize = 10: pages 0 and 1 have 10 items, page 2 has 5 items
    const partialPages = [
      Array.from({ length: 10 }, (_, i) => ({
        title: `Entry ${i}`,
        body: `Body ${i}`,
      })),
      Array.from({ length: 10 }, (_, i) => ({
        title: `Entry ${10 + i}`,
        body: `Body ${10 + i}`,
      })),
      Array.from({ length: 5 }, (_, i) => ({
        title: `Entry ${20 + i}`,
        body: `Body ${20 + i}`,
      })),
    ];

    const list = new VirtualList(globalThis.document.body, {
      getPage: async (page) => {
        requestedPages.push(page);
        return partialPages[page] ?? [];
      },
      getTemplate: (datum) => {
        const card = env.createCard(datum);
        card.titleText = datum.title;
        return card;
      },
      updateTemplate: (card, datum) => {
        updateCalls++;
        card.titleText = datum.title;
        env.updateCard(card, datum);
      },
      pageSize: 10,
    });
    list.render();

    await env.triggerScroll("down"); // page 0 (10)
    await env.triggerScroll("down"); // page 1 (10) -> pool reaches poolLimit (20)
    const snapshotBeforePartial = list.pool.map((el) => el.titleText);

    // Page 2 returns 5 items (< pageSize 10): must halt before recycling elements
    await env.triggerScroll("down");
    assert.equal(
      updateCalls,
      0,
      "Should not recycle elements on short trailing page when pool is full",
    );
    assert.equal(list.start, 0);
    assert.equal(list.end, 2);
    assert.deepEqual(
      list.pool.map((el) => el.titleText),
      snapshotBeforePartial,
    );

    // Further bottom observer events must not trigger additional fetches
    await env.triggerScroll("down");
    assert.deepEqual(requestedPages, [0, 1, 2]);
  });

  it("renders datasets with fewer items than poolLimit without errors and halts pagination", async () => {
    // Subcase 1: 5 items (< pageSize 10 and < poolLimit 20)
    const envSmall = createDOMEnvironment({ heightForDatum: () => 200 });
    const smallRequested = [];
    const smallData = [
      Array.from({ length: 5 }, (_, i) => ({
        title: `Small ${i}`,
        body: `Body ${i}`,
      })),
    ];

    const smallList = new VirtualList(globalThis.document.body, {
      getPage: async (page) => {
        smallRequested.push(page);
        return smallData[page] ?? [];
      },
      getTemplate: (datum) => {
        const card = envSmall.createCard(datum);
        card.titleText = datum.title;
        return card;
      },
      updateTemplate: (card, datum) => {
        card.titleText = datum.title;
      },
      pageSize: 10,
    });
    smallList.render();

    await envSmall.triggerScroll("down");
    assert.equal(smallList.pool.length, 5);
    assert.deepEqual(
      smallList.pool.map((el) => el.titleText),
      ["Small 0", "Small 1", "Small 2", "Small 3", "Small 4"],
    );

    // Subsequent scroll attempts do not fetch page 1 because page 0 was shorter than pageSize
    await envSmall.triggerScroll("down");
    assert.deepEqual(smallRequested, [0]);

    // Subcase 2: 15 items (page 0 has 10, page 1 has 5; total 15 < poolLimit 20)
    const envMedium = createDOMEnvironment({ heightForDatum: () => 200 });
    const mediumRequested = [];
    const mediumData = [
      Array.from({ length: 10 }, (_, i) => ({
        title: `Med ${i}`,
        body: `Body ${i}`,
      })),
      Array.from({ length: 5 }, (_, i) => ({
        title: `Med ${10 + i}`,
        body: `Body ${10 + i}`,
      })),
    ];

    const mediumList = new VirtualList(globalThis.document.body, {
      getPage: async (page) => {
        mediumRequested.push(page);
        return mediumData[page] ?? [];
      },
      getTemplate: (datum) => {
        const card = envMedium.createCard(datum);
        card.titleText = datum.title;
        return card;
      },
      updateTemplate: (card, datum) => {
        card.titleText = datum.title;
      },
      pageSize: 10,
    });
    mediumList.render();

    await envMedium.triggerScroll("down"); // page 0 (10)
    await envMedium.triggerScroll("down"); // page 1 (5) -> total 15 < poolLimit 20
    assert.equal(mediumList.pool.length, 15);
    assert.deepEqual(
      mediumList.pool.map((el) => el.titleText),
      Array.from({ length: 15 }, (_, i) => `Med ${i}`),
    );

    await envMedium.triggerScroll("down");
    assert.deepEqual(mediumRequested, [0, 1]);
  });

  it("guards updateTemplate against undefined entries in data batches", async () => {
    const env = createDOMEnvironment({ heightForDatum: () => 200 });
    const seenData = [];

    const sparsePages = [
      Array.from({ length: 4 }, (_, i) => ({
        title: `P0-${i}`,
        body: `B0-${i}`,
      })),
      Array.from({ length: 4 }, (_, i) => ({
        title: `P1-${i}`,
        body: `B1-${i}`,
      })),
      [
        { title: "P2-0", body: "B2-0" },
        undefined,
        { title: "P2-2", body: "B2-2" },
        undefined,
      ],
    ];

    const list = new VirtualList(globalThis.document.body, {
      getPage: async (page) => sparsePages[page] ?? [],
      getTemplate: (datum) => {
        const card = env.createCard(datum);
        card.titleText = datum.title;
        return card;
      },
      updateTemplate: (card, datum) => {
        seenData.push(datum);
        card.titleText = datum.title;
        env.updateCard(card, datum);
      },
      pageSize: 4,
    });
    list.render();

    await env.triggerScroll("down"); // page 0
    await env.triggerScroll("down"); // page 1 (pool reaches 8)
    await assert.doesNotReject(() => env.triggerScroll("down")); // page 2 (length 4 with undefined holes)

    assert.equal(
      seenData.length,
      2,
      "updateTemplate must only be called for defined data items",
    );
    assert.ok(seenData.every((d) => d !== undefined));
  });
});

class BoundaryMockDocumentFragment {
  constructor() {
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

class BoundaryMockElement {
  constructor(tagName, ownerDocument, id = "") {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = id;
    this.style = {};
    this.textContent = "";
    this.attributes = new Map();
    this.children = [];
    this._height = 200;
    if (id) {
      this.ownerDocument.registerById(id, this);
    }
  }

  setAttribute(name, value) {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === "id") {
      this.id = str;
      this.ownerDocument.registerById(str, this);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  appendChild(node) {
    if (node instanceof BoundaryMockDocumentFragment) {
      for (const child of node.children) {
        this.children.push(child);
      }
      node.children = [];
      return node;
    }
    this.children.push(node);
    return node;
  }

  getElementsByTagName(tagName) {
    const target = tagName.toUpperCase();
    const matches = [];
    const visit = (el) => {
      for (const child of el.children) {
        if (child.tagName === target) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  getBoundingClientRect() {
    return {
      top: 0,
      left: 0,
      right: 600,
      bottom: this._height,
      width: 600,
      height: this._height,
    };
  }

  get scrollHeight() {
    let maxBottom = 0;
    const visit = (el) => {
      const match = /translateY\(([-\d.]+)px\)/.exec(el.style.transform ?? "");
      const yOffset = match ? Number(match[1]) : 0;
      maxBottom = Math.max(maxBottom, yOffset + el._height);
      for (const child of el.children) {
        visit(child);
      }
    };
    visit(this);
    return maxBottom;
  }

  set innerHTML(html) {
    this.children = [];
    if (html.includes('id="container"')) {
      const container = new BoundaryMockElement(
        "div",
        this.ownerDocument,
        "container",
      );
      container._height = 0;
      const topObserver = new BoundaryMockElement(
        "div",
        this.ownerDocument,
        "top-observer",
      );
      topObserver._height = 100;
      const virtualList = new BoundaryMockElement(
        "main",
        this.ownerDocument,
        "virtual-list",
      );
      virtualList._height = 0;
      const bottomObserver = new BoundaryMockElement(
        "div",
        this.ownerDocument,
        "bottom-observer",
      );
      bottomObserver._height = 100;
      container.appendChild(topObserver);
      container.appendChild(virtualList);
      container.appendChild(bottomObserver);
      this.appendChild(container);
    }
  }
}

function setupDOMEnvironment() {
  const elementsById = new Map();
  const observers = [];

  const mockDocument = {
    registerById(id, element) {
      elementsById.set(id, element);
    },
    getElementById(id) {
      return elementsById.get(id) ?? null;
    },
    createElement(tag) {
      return new BoundaryMockElement(tag, mockDocument);
    },
  };

  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      this.unobserved = [];
      this.disconnected = false;
      observers.push(this);
    }

    observe(target) {
      this.observed.add(target);
    }

    unobserve(target) {
      this.observed.delete(target);
      this.unobserved.push(target);
    }

    disconnect() {
      this.observed.clear();
      this.disconnected = true;
    }

    trigger(target, isIntersecting = true) {
      if (!this.observed.has(target)) {
        return;
      }
      this.callback([{ target, isIntersecting }], this);
    }
  }

  globalThis.document = mockDocument;
  globalThis.DocumentFragment = BoundaryMockDocumentFragment;
  globalThis.IntersectionObserver = MockIntersectionObserver;

  const root = new BoundaryMockElement("body", mockDocument);

  const updateTemplate = (element, datum) => {
    const [cardTitle] = element.getElementsByTagName("h3");
    const [cardBody] = element.getElementsByTagName("section");
    cardTitle.textContent = datum.title;
    cardBody.textContent = datum.body;
  };

  const getTemplate = (datum) => {
    const card = new BoundaryMockElement("article", mockDocument);
    const title = new BoundaryMockElement("h3", mockDocument);
    const body = new BoundaryMockElement("section", mockDocument);
    card.appendChild(title);
    card.appendChild(body);
    updateTemplate(card, datum);
    return card;
  };

  return {
    root,
    mockDocument,
    observers,
    getTemplate,
    updateTemplate,
  };
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

test("stops pagination, unobserves bottom sentinel, and preserves rendered cards on data exhaustion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, mockDocument, observers, getTemplate, updateTemplate } =
    setupDOMEnvironment();

  const db = initMockDB({ title: "Card Title", body: "Card Body" }, 30, 10);
  const requestedPages = [];
  const list = new VirtualList(root, {
    getPage: (page) => {
      requestedPages.push(page);
      return db.getPage(page);
    },
    getTemplate,
    updateTemplate,
    pageSize: 10,
  });

  list.render();
  assert.equal(observers.length, 1);
  const observer = observers[0];
  assert.equal(list.observer, observer);
  assert.equal(list.hasMore, true);
  assert.equal(list.isLoading, false);

  t.mock.timers.tick(100);
  const bottomObserver = mockDocument.getElementById("bottom-observer");
  assert.equal(observer.observed.has(bottomObserver), true);

  // Load pages 0, 1, 2 (total 30 entries across 3 pages; poolLimit = 20)
  for (let expectedPage = 0; expectedPage < 3; expectedPage++) {
    observer.trigger(bottomObserver, true);
    assert.equal(list.isLoading, true);
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.equal(list.isLoading, false);
    assert.equal(list.hasMore, true);
  }

  assert.deepEqual(requestedPages, [0, 1, 2]);
  assert.equal(list.start, 1);
  assert.equal(list.end, 3);
  assert.equal(list.pool.length, 20);

  const renderedBeforeExhaustion = list.pool.map(
    (card) => card.getElementsByTagName("h3")[0].textContent,
  );
  assert.equal(renderedBeforeExhaustion[0], "[Entry 10] - Card Title");
  assert.equal(renderedBeforeExhaustion[19], "[Entry 29] - Card Title");

  // Trigger page 3 (past the end of data -> returns [])
  observer.trigger(bottomObserver, true);
  t.mock.timers.tick(1000);
  await flushMicrotasks();

  assert.deepEqual(requestedPages, [0, 1, 2, 3]);
  assert.equal(list.hasMore, false);
  assert.equal(list.isLoading, false);
  assert.equal(observer.observed.has(bottomObserver), false);
  assert.deepEqual(observer.unobserved, [bottomObserver]);

  // Pointers and rendered cards must remain completely untouched
  assert.equal(list.start, 1);
  assert.equal(list.end, 3);
  const renderedAfterExhaustion = list.pool.map(
    (card) => card.getElementsByTagName("h3")[0].textContent,
  );
  assert.deepEqual(renderedAfterExhaustion, renderedBeforeExhaustion);

  // Even if observer callback were invoked directly after exhaustion, #handleIntersection filters it out
  observer.callback(
    [{ target: bottomObserver, isIntersecting: true }],
    observer,
  );
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.deepEqual(requestedPages, [0, 1, 2, 3]);
});

test("cleanly unobserves bottom sentinel without errors when initial dataset is empty", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, mockDocument, observers, getTemplate, updateTemplate } =
    setupDOMEnvironment();

  const db = initMockDB({ title: "Empty", body: "Empty" }, 0, 10);
  let calls = 0;
  const list = new VirtualList(root, {
    getPage: (page) => {
      calls++;
      return db.getPage(page);
    },
    getTemplate,
    updateTemplate,
    pageSize: 10,
  });

  list.render();
  t.mock.timers.tick(100);

  const observer = observers[0];
  const bottomObserver = mockDocument.getElementById("bottom-observer");

  observer.trigger(bottomObserver, true);
  t.mock.timers.tick(1000);
  await flushMicrotasks();

  assert.equal(calls, 1);
  assert.equal(list.hasMore, false);
  assert.equal(list.isLoading, false);
  assert.equal(list.pool.length, 0);
  assert.equal(list.start, 0);
  assert.equal(list.end, 0);
  assert.equal(observer.observed.has(bottomObserver), false);
});

test("prevents duplicate concurrent page fetches while isLoading is true", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, mockDocument, observers, getTemplate, updateTemplate } =
    setupDOMEnvironment();

  const db = initMockDB({ title: "Item", body: "Body" }, 20, 10);
  const requestedPages = [];
  const list = new VirtualList(root, {
    getPage: (page) => {
      requestedPages.push(page);
      return db.getPage(page);
    },
    getTemplate,
    updateTemplate,
    pageSize: 10,
  });

  list.render();
  t.mock.timers.tick(100);

  const observer = observers[0];
  const bottomObserver = mockDocument.getElementById("bottom-observer");

  // First intersection starts fetch for page 0
  observer.trigger(bottomObserver, true);
  assert.equal(list.isLoading, true);

  // Overlapping intersections during network delay must be ignored
  t.mock.timers.tick(300);
  observer.trigger(bottomObserver, true);
  t.mock.timers.tick(300);
  observer.trigger(bottomObserver, true);

  assert.deepEqual(requestedPages, [0]);

  // Resolve first request
  t.mock.timers.tick(400);
  await flushMicrotasks();
  assert.equal(list.isLoading, false);
  assert.equal(list.end, 1);
  assert.equal(list.pool.length, 10);

  // Subsequent intersection now fetches page 1 normally
  observer.trigger(bottomObserver, true);
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.deepEqual(requestedPages, [0, 1]);
  assert.equal(list.end, 2);
  assert.equal(list.pool.length, 20);
});

test("preserves normal top observer backward scroll recycling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, mockDocument, observers, getTemplate, updateTemplate } =
    setupDOMEnvironment();

  const db = initMockDB({ title: "Item", body: "Body" }, 40, 10);
  const list = new VirtualList(root, {
    getPage: (page) => db.getPage(page),
    getTemplate,
    updateTemplate,
    pageSize: 10,
  });

  list.render();
  t.mock.timers.tick(100);

  const observer = observers[0];
  const topObserver = mockDocument.getElementById("top-observer");
  const bottomObserver = mockDocument.getElementById("bottom-observer");

  // Advance forward 3 pages -> pool contains entries 10..29 (start = 1, end = 3)
  for (let i = 0; i < 3; i++) {
    observer.trigger(bottomObserver, true);
    t.mock.timers.tick(1000);
    await flushMicrotasks();
  }
  assert.equal(list.start, 1);
  assert.equal(list.end, 3);

  // Scroll up -> top observer recycles entries 20..29 to render entries 0..9
  observer.trigger(topObserver, true);
  t.mock.timers.tick(1000);
  await flushMicrotasks();

  assert.equal(list.start, 0);
  assert.equal(list.end, 2);
  const titles = list.pool.map(
    (card) => card.getElementsByTagName("h3")[0].textContent,
  );
  assert.equal(titles[0], "[Entry 0] - Item");
  assert.equal(titles[19], "[Entry 19] - Item");
});
