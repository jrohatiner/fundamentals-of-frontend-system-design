import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { VirtualList } from "./virtual-list.js";
import { initMockDB } from "../../../utils/db.js";

describe("VirtualList DOM allocation and recycling", () => {
  class MockElement {
    constructor(tagName, id = "") {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.children = [];
      this.attributes = new Map();
      this.style = {};
      this.textContent = "";
      this._height = 120;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(node) {
      if (node instanceof MockDocumentFragment) {
        this.children.push(...node.children);
        node.children = [];
        return node;
      }
      this.children.push(node);
      return node;
    }

    getBoundingClientRect() {
      return {
        height: this._height,
        top: 0,
        bottom: this._height,
        left: 0,
        right: 400,
        width: 400,
      };
    }

    get scrollHeight() {
      return this.children.reduce((maxBottom, child) => {
        const childBottom = child.children.reduce((acc, item) => {
          const yAttr = item.getAttribute("data-y");
          const yPos = yAttr != null ? Number(yAttr) : 0;
          return Math.max(acc, yPos + item._height);
        }, 0);
        return Math.max(maxBottom, childBottom);
      }, 0);
    }
  }

  class MockDocumentFragment {
    static allocationCount = 0;

    constructor() {
      MockDocumentFragment.allocationCount++;
      this.children = [];
    }

    appendChild(node) {
      this.children.push(node);
      return node;
    }
  }

  function setupMockDOM() {
    MockDocumentFragment.allocationCount = 0;
    const elementsById = new Map();
    let observerCallback = null;
    const observedTargets = [];

    const root = new MockElement("body");
    Object.defineProperty(root, "innerHTML", {
      get() {
        return this._innerHTML ?? "";
      },
      set(html) {
        this._innerHTML = html;
        elementsById.clear();
        this.children = [];
        if (html.includes('id="container"')) {
          const container = new MockElement("div", "container");
          const topObserver = new MockElement("div", "top-observer");
          const list = new MockElement("main", "virtual-list");
          const bottomObserver = new MockElement("div", "bottom-observer");
          container.appendChild(topObserver);
          container.appendChild(list);
          container.appendChild(bottomObserver);
          this.appendChild(container);
          elementsById.set("container", container);
          elementsById.set("top-observer", topObserver);
          elementsById.set("virtual-list", list);
          elementsById.set("bottom-observer", bottomObserver);
        }
      },
    });

    globalThis.document = {
      getElementById(id) {
        return elementsById.get(id) ?? null;
      },
      createElement(tag) {
        return new MockElement(tag);
      },
    };

    globalThis.DocumentFragment = MockDocumentFragment;

    globalThis.IntersectionObserver = class {
      constructor(callback) {
        observerCallback = callback;
      }
      observe(target) {
        observedTargets.push(target);
      }
      disconnect() {}
    };

    const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

    return {
      root,
      elementsById,
      observedTargets,
      async triggerBottom() {
        const bottom = elementsById.get("bottom-observer");
        observerCallback([{ isIntersecting: true, target: bottom }]);
        await flushTasks();
      },
      async triggerTop() {
        const top = elementsById.get("top-observer");
        observerCallback([{ isIntersecting: true, target: top }]);
        await flushTasks();
      },
    };
  }

  let dom;
  const pageSize = 5;

  beforeEach(() => {
    dom = setupMockDOM();
  });

  afterEach(() => {
    delete globalThis.document;
    delete globalThis.DocumentFragment;
    delete globalThis.IntersectionObserver;
  });

  function createFixture({ totalPages = 6 } = {}) {
    let getTemplateCalls = 0;
    let updateTemplateCalls = 0;
    const requestedPages = [];

    const pages = Array.from({ length: totalPages }, (_, pageIdx) =>
      Array.from({ length: pageSize }, (__, itemIdx) => ({
        id: pageIdx * pageSize + itemIdx,
        title: `Entry ${pageIdx * pageSize + itemIdx}`,
      })),
    );

    const getTemplate = (datum) => {
      getTemplateCalls++;
      const el = new MockElement("article");
      el.textContent = datum.title;
      return el;
    };

    const updateTemplate = (element, datum) => {
      updateTemplateCalls++;
      element.textContent = datum.title;
    };

    const getPage = async (page) => {
      requestedPages.push(page);
      if (page < 0 || page >= pages.length) {
        return [];
      }
      return pages[page];
    };

    const virtualList = new VirtualList(dom.root, {
      getPage,
      getTemplate,
      updateTemplate,
      pageSize,
    });

    virtualList.render();

    return {
      virtualList,
      getStats: () => ({
        getTemplateCalls,
        updateTemplateCalls,
        fragmentAllocations: MockDocumentFragment.allocationCount,
        requestedPages: [...requestedPages],
        mountedCount: dom.elementsById.get("virtual-list").children.length,
      }),
    };
  }

  it("allocates DOM nodes and DocumentFragments only while populating pool up to poolLimit", async () => {
    const { virtualList, getStats } = createFixture();

    // Page 0: pool grows 0 -> 5 (< poolLimit 10)
    await dom.triggerBottom();
    assert.equal(virtualList.pool.length, 5);
    assert.deepEqual(getStats(), {
      getTemplateCalls: 5,
      updateTemplateCalls: 0,
      fragmentAllocations: 1,
      requestedPages: [0],
      mountedCount: 5,
    });

    // Page 1: pool grows 5 -> 10 (=== poolLimit 10)
    await dom.triggerBottom();
    assert.equal(virtualList.pool.length, 10);
    assert.equal(virtualList.pool.length, virtualList.poolLimit);
    assert.deepEqual(getStats(), {
      getTemplateCalls: 10,
      updateTemplateCalls: 0,
      fragmentAllocations: 2,
      requestedPages: [0, 1],
      mountedCount: 10,
    });
  });

  it("ceases props.getTemplate calls and DocumentFragment allocations once pool reaches poolLimit", async () => {
    const { virtualList, getStats } = createFixture();

    // Populate pool to capacity (pages 0 and 1)
    await dom.triggerBottom();
    await dom.triggerBottom();
    const initialPoolNodes = [...virtualList.pool];
    assert.equal(getStats().getTemplateCalls, virtualList.poolLimit);
    assert.equal(getStats().fragmentAllocations, 2);

    // Scroll through pages 2, 3, and 4: pool is at capacity, must recycle in place
    await dom.triggerBottom();
    await dom.triggerBottom();
    await dom.triggerBottom();

    const stats = getStats();
    assert.equal(
      stats.getTemplateCalls,
      virtualList.poolLimit,
      "getTemplate must not be called after pool reaches poolLimit",
    );
    assert.equal(
      stats.fragmentAllocations,
      2,
      "DocumentFragment must not be allocated after pool reaches poolLimit",
    );
    assert.equal(
      stats.updateTemplateCalls,
      pageSize * 3,
      "updateTemplate should update recycled elements for each recycled page",
    );
    assert.equal(
      stats.mountedCount,
      virtualList.poolLimit,
      "mounted DOM child count must stay capped at poolLimit",
    );
    assert.equal(virtualList.start, 3);
    assert.equal(virtualList.end, 5);

    // Pool must contain the exact same HTMLElement instances (rotated, never re-created)
    assert.equal(virtualList.pool.length, virtualList.poolLimit);
    for (const node of virtualList.pool) {
      assert.ok(
        initialPoolNodes.includes(node),
        "pool should reuse existing DOM elements",
      );
    }
    assert.deepEqual(
      virtualList.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, idx) => `Entry ${15 + idx}`),
    );
  });

  it("preserves zero additional allocations across upward and downward scroll recycling", async () => {
    const { virtualList, getStats } = createFixture();

    // Pages 0, 1 (populate), then 2, 3 (recycle down -> pool holds entries 10..19)
    await dom.triggerBottom();
    await dom.triggerBottom();
    await dom.triggerBottom();
    await dom.triggerBottom();

    // Scroll up once (page 1 -> pool holds entries 5..14), then down once (page 3 -> entries 10..19)
    await dom.triggerTop();
    assert.deepEqual(
      virtualList.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, idx) => `Entry ${5 + idx}`),
    );

    await dom.triggerBottom();
    assert.deepEqual(
      virtualList.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, idx) => `Entry ${10 + idx}`),
    );

    const stats = getStats();
    assert.equal(stats.getTemplateCalls, virtualList.poolLimit);
    assert.equal(stats.fragmentAllocations, 2);
  });

  it("does not allocate elements or modify pool contents when getPage returns an empty batch", async () => {
    // Case 1: Empty dataset on initial load (pool is empty)
    const emptyFixture = createFixture({ totalPages: 0 });
    await dom.triggerBottom();
    assert.equal(emptyFixture.virtualList.pool.length, 0);
    assert.equal(emptyFixture.virtualList.start, 0);
    assert.equal(emptyFixture.virtualList.end, 0);
    assert.equal(emptyFixture.getStats().getTemplateCalls, 0);
    assert.equal(emptyFixture.getStats().fragmentAllocations, 0);
    assert.equal(emptyFixture.getStats().updateTemplateCalls, 0);

    // Case 2: End-of-dataset empty batch after pool reaches poolLimit
    dom = setupMockDOM();
    const { virtualList, getStats } = createFixture({ totalPages: 2 });
    await dom.triggerBottom(); // page 0
    await dom.triggerBottom(); // page 1 (pool at poolLimit)
    const poolSnapshot = [...virtualList.pool];
    const textSnapshot = virtualList.pool.map((el) => el.textContent);

    await dom.triggerBottom(); // page 2 -> []
    assert.deepEqual(
      virtualList.pool,
      poolSnapshot,
      "pool order and references must remain unchanged",
    );
    assert.deepEqual(
      virtualList.pool.map((el) => el.textContent),
      textSnapshot,
      "pool element content must remain unchanged",
    );
    assert.equal(virtualList.start, 0);
    assert.equal(virtualList.end, 2);
    assert.equal(getStats().getTemplateCalls, virtualList.poolLimit);
    assert.equal(getStats().fragmentAllocations, 2);
    assert.equal(getStats().updateTemplateCalls, 0);
  });
});

describe("VirtualList in-flight pagination lock", () => {
  class MockDocumentFragment {
    constructor() {
      this.children = [];
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }
  }

  class MockElement {
    constructor(tagName, id = "", registry = null, height = 120) {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this._registry = registry;
      this._height = height;
      this.attributes = new Map();
      this.children = [];
      this.style = { transform: "", height: "" };
      this.textContent = "";
      this._innerHTML = "";
      if (id && registry) {
        registry.set(id, this);
      }
    }

    set innerHTML(html) {
      this._innerHTML = html;
      this.children = [];
      if (this._registry) {
        this._registry.clear();
        if (this.id) {
          this._registry.set(this.id, this);
        }
      }
      if (html.includes('id="container"')) {
        const container = new MockElement(
          "div",
          "container",
          this._registry,
          0,
        );
        const topObserver = new MockElement(
          "div",
          "top-observer",
          this._registry,
          100,
        );
        topObserver.textContent = "Top Observer";
        const virtualList = new MockElement(
          "main",
          "virtual-list",
          this._registry,
          0,
        );
        const bottomObserver = new MockElement(
          "div",
          "bottom-observer",
          this._registry,
          100,
        );
        bottomObserver.textContent = "Bottom Observer";
        container.appendChild(topObserver);
        container.appendChild(virtualList);
        container.appendChild(bottomObserver);
        this.children.push(container);
      }
    }

    get innerHTML() {
      return this._innerHTML;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(node) {
      if (node instanceof MockDocumentFragment) {
        this.children.push(...node.children);
        node.children = [];
      } else {
        this.children.push(node);
      }
      return node;
    }

    getBoundingClientRect() {
      return {
        top: 0,
        left: 0,
        width: 600,
        height: this._height,
        bottom: this._height,
        right: 600,
      };
    }

    get scrollHeight() {
      const list = this._registry?.get("virtual-list");
      if (!list || list.children.length === 0) {
        return 200;
      }
      let maxBottom = 0;
      for (const item of list.children) {
        const itemY = Number(item.getAttribute("data-y") ?? 0);
        const bottom = itemY + item.getBoundingClientRect().height;
        if (bottom > maxBottom) {
          maxBottom = bottom;
        }
      }
      return maxBottom + 100;
    }
  }

  function setupMockDOM() {
    const registry = new Map();
    const observers = [];

    class MockIntersectionObserver {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = [];
        observers.push(this);
      }

      observe(target) {
        this.targets.push(target);
      }

      unobserve(target) {
        this.targets = this.targets.filter((t) => t !== target);
      }

      disconnect() {
        this.targets = [];
      }

      trigger(entries) {
        this.callback(entries, this);
      }
    }

    const root = new MockElement("body", "root", registry, 800);

    globalThis.document = {
      body: root,
      getElementById(id) {
        return registry.get(id) ?? null;
      },
      createElement(tag) {
        return new MockElement(tag, "", registry, 120);
      },
    };
    globalThis.DocumentFragment = MockDocumentFragment;
    globalThis.IntersectionObserver = MockIntersectionObserver;

    return {
      root,
      registry,
      getActiveObserver() {
        assert.equal(
          observers.length,
          1,
          "Expected one IntersectionObserver instance",
        );
        return observers[0];
      },
      getTopSentinel() {
        return registry.get("top-observer");
      },
      getBottomSentinel() {
        return registry.get("bottom-observer");
      },
    };
  }

  async function flushMicrotasks(ticks = 6) {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
  }

  function createTemplateHelpers(registry) {
    const updateTemplate = (element, datum) => {
      element.datum = datum;
      element.textContent = datum.title;
    };
    const getTemplate = (datum) => {
      const element = new MockElement("article", "", registry, 120);
      updateTemplate(element, datum);
      return element;
    };
    return { getTemplate, updateTemplate };
  }

  let dom;

  beforeEach(() => {
    dom = setupMockDOM();
  });

  afterEach(() => {
    delete globalThis.document;
    delete globalThis.DocumentFragment;
    delete globalThis.IntersectionObserver;
  });

  it("deduplicates overlapping bottom intersection triggers during delayed initMockDB.getPage responses", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const pageSize = 5;
    const db = initMockDB({ title: "Card", body: "Content" }, 50, pageSize);
    const requestedPages = [];

    const { getTemplate, updateTemplate } = createTemplateHelpers(dom.registry);
    const list = new VirtualList(dom.root, {
      getPage: (pointer) => {
        requestedPages.push(pointer);
        return db.getPage(pointer);
      },
      getTemplate,
      updateTemplate,
      pageSize,
    });

    list.render();
    // Advance 100ms for intersectionObserver target registration in utils/observer.js
    t.mock.timers.tick(100);

    const observer = dom.getActiveObserver();
    const bottomSentinel = dom.getBottomSentinel();
    assert.equal(observer.targets.length, 2);

    // Trigger multiple overlapping bottom intersections while the 1000ms DB fetch is in flight
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    t.mock.timers.tick(250);
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    t.mock.timers.tick(250);
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    t.mock.timers.tick(250);
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);

    // Still in flight (750ms < 1000ms): only page 0 was requested and pointers have not drifted
    assert.deepEqual(requestedPages, [0]);
    assert.equal(list.end, 0);
    assert.equal(list.pool.length, 0);

    // Complete the 1000ms delayed DB response and flush async handler continuation
    t.mock.timers.tick(250);
    await flushMicrotasks();

    assert.deepEqual(requestedPages, [0]);
    assert.equal(list.start, 0);
    assert.equal(list.end, 1);
    assert.equal(list.pool.length, 5);
    assert.deepEqual(
      list.pool.map((el) => el.textContent),
      Array.from({ length: 5 }, (_, i) => `[Entry ${i}] - Card`),
    );

    // Load page 1 (fills pool up to poolLimit = 10) with overlapping triggers
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    assert.deepEqual(requestedPages, [0, 1]);

    t.mock.timers.tick(1000);
    await flushMicrotasks();

    assert.equal(list.start, 0);
    assert.equal(list.end, 2);
    assert.equal(list.pool.length, 10);

    // Load page 2 (recycles top 5 elements cleanly) with overlapping triggers
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    t.mock.timers.tick(400);
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    assert.deepEqual(requestedPages, [0, 1, 2]);

    t.mock.timers.tick(600);
    await flushMicrotasks();

    assert.equal(list.start, 1);
    assert.equal(list.end, 3);
    assert.equal(list.pool.length, 10);
    assert.deepEqual(
      list.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, i) => `[Entry ${i + 5}] - Card`),
    );
  });

  it("deduplicates overlapping top intersection triggers and mixed single-batch entries", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const pageSize = 5;
    const db = initMockDB({ title: "Card", body: "Content" }, 50, pageSize);
    const requestedPages = [];

    const { getTemplate, updateTemplate } = createTemplateHelpers(dom.registry);
    const list = new VirtualList(dom.root, {
      getPage: (pointer) => {
        requestedPages.push(pointer);
        return db.getPage(pointer);
      },
      getTemplate,
      updateTemplate,
      pageSize,
    });

    list.render();
    t.mock.timers.tick(100);

    const observer = dom.getActiveObserver();
    const topSentinel = dom.getTopSentinel();
    const bottomSentinel = dom.getBottomSentinel();

    // Advance sequentially through pages 0, 1, 2, 3 -> start = 2, end = 4 (entries 10..19)
    for (let page = 0; page < 4; page++) {
      observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
      t.mock.timers.tick(1000);
      await flushMicrotasks();
    }
    assert.equal(list.start, 2);
    assert.equal(list.end, 4);
    assert.deepEqual(requestedPages, [0, 1, 2, 3]);

    // Fire overlapping top-observer and bottom-observer triggers while top fetch (page 1) is in flight
    observer.trigger([{ target: topSentinel, isIntersecting: true }]);
    t.mock.timers.tick(300);
    observer.trigger([{ target: topSentinel, isIntersecting: true }]);
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);

    assert.deepEqual(requestedPages, [0, 1, 2, 3, 1]);

    t.mock.timers.tick(700);
    await flushMicrotasks();

    assert.equal(list.start, 1);
    assert.equal(list.end, 3);
    assert.deepEqual(
      list.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, i) => `[Entry ${i + 5}] - Card`),
    );

    // Fire a single IntersectionObserver callback batch where BOTH top and bottom sentinels intersect
    observer.trigger([
      { target: topSentinel, isIntersecting: true },
      { target: bottomSentinel, isIntersecting: true },
    ]);
    assert.deepEqual(requestedPages, [0, 1, 2, 3, 1, 0]);

    t.mock.timers.tick(1000);
    await flushMicrotasks();

    assert.equal(list.start, 0);
    assert.equal(list.end, 2);
    assert.deepEqual(
      list.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, i) => `[Entry ${i}] - Card`),
    );
  });

  it("resets #isLoading to false when getPage rejects or throws on bottom pagination, allowing retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const pageSize = 5;
    const db = initMockDB({ title: "Card", body: "Content" }, 50, pageSize);
    const attempts = [];
    let callCount = 0;

    const { getTemplate, updateTemplate } = createTemplateHelpers(dom.registry);
    const list = new VirtualList(dom.root, {
      getPage: (pointer) => {
        callCount++;
        attempts.push({ callCount, pointer });
        if (callCount === 1) {
          return new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("Simulated network timeout")),
              500,
            );
          });
        }
        if (callCount === 2) {
          throw new Error("Simulated synchronous error");
        }
        return db.getPage(pointer);
      },
      getTemplate,
      updateTemplate,
      pageSize,
    });

    list.render();
    t.mock.timers.tick(100);

    const observer = dom.getActiveObserver();
    const bottomSentinel = dom.getBottomSentinel();

    // Attempt 1: async rejection; overlapping trigger while pending must be ignored
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    t.mock.timers.tick(200);
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    assert.equal(attempts.length, 1);

    t.mock.timers.tick(300);
    await flushMicrotasks();

    // Pointer did not advance on failure and pool remains uncorrupted
    assert.equal(list.end, 0);
    assert.equal(list.pool.length, 0);

    // Attempt 2: synchronous throw inside getPage also releases #isLoading via finally
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    await flushMicrotasks();
    assert.equal(attempts.length, 2);
    assert.equal(list.end, 0);

    // Attempt 3: lock was released, so retrying page 0 succeeds cleanly
    observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
    t.mock.timers.tick(1000);
    await flushMicrotasks();

    assert.deepEqual(attempts, [
      { callCount: 1, pointer: 0 },
      { callCount: 2, pointer: 0 },
      { callCount: 3, pointer: 0 },
    ]);
    assert.equal(list.start, 0);
    assert.equal(list.end, 1);
    assert.equal(list.pool.length, 5);
    assert.deepEqual(
      list.pool.map((el) => el.textContent),
      Array.from({ length: 5 }, (_, i) => `[Entry ${i}] - Card`),
    );
  });

  it("resets #isLoading to false when getPage rejects on top pagination without deadlocking start pointer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const pageSize = 5;
    const db = initMockDB({ title: "Card", body: "Content" }, 50, pageSize);
    let shouldFailNextTopLoad = false;
    const requestedPages = [];

    const { getTemplate, updateTemplate } = createTemplateHelpers(dom.registry);
    const list = new VirtualList(dom.root, {
      getPage: (pointer) => {
        requestedPages.push(pointer);
        if (shouldFailNextTopLoad) {
          shouldFailNextTopLoad = false;
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Top page fetch failed")), 400);
          });
        }
        return db.getPage(pointer);
      },
      getTemplate,
      updateTemplate,
      pageSize,
    });

    list.render();
    t.mock.timers.tick(100);

    const observer = dom.getActiveObserver();
    const topSentinel = dom.getTopSentinel();
    const bottomSentinel = dom.getBottomSentinel();

    // Populate pages 0, 1, 2 -> start = 1, end = 3 (entries 5..14)
    for (let page = 0; page < 3; page++) {
      observer.trigger([{ target: bottomSentinel, isIntersecting: true }]);
      t.mock.timers.tick(1000);
      await flushMicrotasks();
    }
    assert.equal(list.start, 1);
    assert.equal(list.end, 3);

    // Fail the next top pagination call for page 0
    shouldFailNextTopLoad = true;
    observer.trigger([{ target: topSentinel, isIntersecting: true }]);
    t.mock.timers.tick(200);
    // Overlapping trigger during pending rejection is ignored
    observer.trigger([{ target: topSentinel, isIntersecting: true }]);
    assert.deepEqual(requestedPages, [0, 1, 2, 0]);

    t.mock.timers.tick(200);
    await flushMicrotasks();

    // start must remain 1 (> 0) and end must remain 3 so subsequent top pagination can retry page 0
    assert.equal(list.start, 1);
    assert.equal(list.end, 3);
    assert.deepEqual(
      list.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, i) => `[Entry ${i + 5}] - Card`),
    );

    // Retry top pagination -> succeeds and loads page 0 cleanly
    observer.trigger([{ target: topSentinel, isIntersecting: true }]);
    t.mock.timers.tick(1000);
    await flushMicrotasks();

    assert.deepEqual(requestedPages, [0, 1, 2, 0, 0]);
    assert.equal(list.start, 0);
    assert.equal(list.end, 2);
    assert.deepEqual(
      list.pool.map((el) => el.textContent),
      Array.from({ length: 10 }, (_, i) => `[Entry ${i}] - Card`),
    );
  });
});
