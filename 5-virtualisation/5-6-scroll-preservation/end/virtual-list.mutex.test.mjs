import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

const MARGIN = 16;

function parseTranslateY(transformValue) {
    if (!transformValue) {
        return 0;
    }
    const match = /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(transformValue);
    return match ? Number(match[1]) : 0;
}

/**
 * Viewport-aware mock DOM harness that models scrollY, element heights,
 * translateY coordinates, and asynchronous getPage resolution to test
 * in-flight mutex locking and post-fetch sentinel visibility checks.
 */
function createViewportMockDOM({
    viewportHeight = 800,
    cardHeight = 200,
    sentinelHeight = 100,
    enableWindow = true,
} = {}) {
    let scrollY = 0;
    let observerCallback = null;
    const elementsById = new Map();

    class MockElement {
        constructor(tagName, id = "", height = cardHeight) {
            this.tagName = tagName.toUpperCase();
            this.id = id;
            this.children = [];
            this.attributes = new Map();
            this.style = { transform: "", height: "" };
            this.textContent = "";
            this._height = height;
            this.onMeasure = null;
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
            if (typeof this.onMeasure === "function") {
                this.onMeasure();
            }
            let docTop = 0;
            if (this.id === "top-observer") {
                docTop = parseTranslateY(this.style.transform);
            } else if (this.id === "bottom-observer") {
                // In flex flow after #top-observer (100px) and 0px #virtual-list
                docTop = sentinelHeight + parseTranslateY(this.style.transform);
            } else {
                const yAttr = this.getAttribute("data-y");
                docTop = yAttr != null ? Number(yAttr) : parseTranslateY(this.style.transform);
            }
            const top = docTop - scrollY;
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

        get scrollHeight() {
            const list = elementsById.get("virtual-list");
            if (!list || list.children.length === 0) {
                return sentinelHeight * 2;
            }
            return list.children.reduce((maxBottom, item) => {
                const yAttr = item.getAttribute("data-y");
                const yPos = yAttr != null ? Number(yAttr) : 0;
                return Math.max(maxBottom, yPos + item._height + MARGIN * 2);
            }, 0);
        }
    }

    class MockDocumentFragment {
        constructor() {
            this.children = [];
        }

        appendChild(node) {
            this.children.push(node);
            return node;
        }
    }

    const root = new MockElement("body", "body", viewportHeight);
    Object.defineProperty(root, "innerHTML", {
        get() {
            return this._innerHTML ?? "";
        },
        set(html) {
            this._innerHTML = html;
            elementsById.clear();
            this.children = [];
            if (html.includes('id="container"')) {
                const container = new MockElement("div", "container", 0);
                const topObserver = new MockElement("div", "top-observer", sentinelHeight);
                const list = new MockElement("main", "virtual-list", 0);
                const bottomObserver = new MockElement("div", "bottom-observer", sentinelHeight);
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
        body: root,
        getElementById(id) {
            return elementsById.get(id) ?? null;
        },
        createElement(tag) {
            return new MockElement(tag);
        },
    };
    globalThis.DocumentFragment = MockDocumentFragment;
    globalThis.IntersectionObserver = class {
        constructor(cb) {
            observerCallback = cb;
        }
        observe() {}
        disconnect() {}
    };

    if (enableWindow) {
        globalThis.window = { innerHeight: viewportHeight };
    } else {
        delete globalThis.window;
    }

    return {
        root,
        elementsById,
        MockElement,
        setScrollY(nextY) {
            scrollY = nextY;
        },
        getScrollY() {
            return scrollY;
        },
        dispatchEntries(entries) {
            observerCallback(entries);
        },
        fireBottom(isIntersecting = true) {
            observerCallback([{ isIntersecting, target: elementsById.get("bottom-observer") }]);
        },
        fireTop(isIntersecting = true) {
            observerCallback([{ isIntersecting, target: elementsById.get("top-observer") }]);
        },
    };
}

function createDeferredQueue(totalPages = 8, pageSize = 5) {
    const pages = Array.from({ length: totalPages }, (_, pageIdx) =>
        Array.from({ length: pageSize }, (__, itemOffset) => {
            const index = pageIdx * pageSize + itemOffset;
            return { id: index, title: `[Entry ${index}]` };
        })
    );

    let inFlight = 0;
    let maxConcurrent = 0;
    const requestedPages = [];
    const pending = [];

    const getPage = (page) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        requestedPages.push(page);
        return new Promise((resolve, reject) => {
            pending.push({
                page,
                resolve(customData) {
                    inFlight--;
                    if (customData !== undefined) {
                        resolve(customData);
                        return;
                    }
                    resolve(page >= 0 && page < pages.length ? pages[page] : []);
                },
                reject(err) {
                    inFlight--;
                    reject(err);
                },
            });
        });
    };

    return {
        getPage,
        pending,
        requestedPages,
        getInFlight: () => inFlight,
        getMaxConcurrent: () => maxConcurrent,
    };
}

const flushMicrotasks = async (ticks = 6) => {
    for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
    }
};

const { VirtualList } = await import("./virtual-list.js");

describe("VirtualList in-flight mutex lock and post-fetch sentinel visibility", () => {
    beforeEach(() => {
        delete globalThis.window;
    });

    afterEach(() => {
        delete globalThis.window;
    });

    it("exits observer entry dispatches immediately while a fetch is active and prevents multi-entry concurrency", async () => {
        const pageSize = 5;
        const cardHeight = 200;
        const stride = cardHeight + MARGIN * 2;
        const dom = createViewportMockDOM({ viewportHeight: 800, cardHeight, enableWindow: true });
        const queue = createDeferredQueue(8, pageSize);

        const list = new VirtualList(dom.root, {
            getPage: queue.getPage,
            getTemplate: (datum) => {
                const el = new dom.MockElement("article");
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
            pageSize,
        });
        list.render();

        // Start Page 0 fetch
        dom.fireBottom(true);
        assert.equal(queue.getInFlight(), 1);
        assert.deepEqual(queue.requestedPages, [0]);

        // Rapid concurrent observer callbacks while Page 0 is still active must exit immediately
        dom.fireBottom(true);
        dom.fireBottom(true);
        dom.fireTop(true);
        dom.dispatchEntries([
            { isIntersecting: true, target: dom.elementsById.get("bottom-observer") },
            { isIntersecting: true, target: dom.elementsById.get("top-observer") },
        ]);

        assert.equal(queue.getInFlight(), 1, "Only one fetch may be active at a time");
        assert.equal(queue.getMaxConcurrent(), 1);
        assert.deepEqual(queue.requestedPages, [0], "Concurrent dispatches must not invoke getPage");

        // Complete Page 0 at scrollY = 0 (5 cards * 232px = 1160px > 800px viewport, so bottom is off-screen)
        queue.pending.shift().resolve();
        await flushMicrotasks();

        assert.equal(queue.getInFlight(), 0);
        assert.equal(list.start, 0);
        assert.equal(list.end, 1);
        assert.equal(list.pool.length, 5);
        assert.equal(dom.elementsById.get("top-observer").style.transform, "translateY(0px)");
        assert.equal(dom.elementsById.get("bottom-observer").style.transform, `translateY(${5 * stride}px)`);

        // Populate Page 1 and Page 2 so list.start becomes 1 (> 0), then verify a simultaneous [top, bottom] batch only starts one fetch
        dom.setScrollY(600);
        dom.fireBottom(true);
        queue.pending.shift().resolve(); // Page 1 -> bottom at 2320px (> 600 + 800)
        await flushMicrotasks();

        dom.setScrollY(1800);
        dom.fireBottom(true);
        queue.pending.shift().resolve(); // Page 2 -> start = 1, end = 3, bottom at 3480px (> 1800 + 800), top at 1160px (< 1800)
        await flushMicrotasks();
        assert.equal(list.start, 1);
        assert.equal(list.end, 3);

        // Dispatch a single IntersectionObserver batch containing BOTH top and bottom intersecting
        dom.dispatchEntries([
            { isIntersecting: true, target: dom.elementsById.get("top-observer") },
            { isIntersecting: true, target: dom.elementsById.get("bottom-observer") },
        ]);

        assert.equal(queue.getInFlight(), 1, "Multi-entry observer batch must only start a single fetch");
        assert.equal(queue.getMaxConcurrent(), 1);
        assert.deepEqual(queue.requestedPages, [0, 1, 2, 0]);
    });

    it("keeps the lock held until element recycling and coordinate updates complete", async () => {
        const pageSize = 5;
        const dom = createViewportMockDOM({ viewportHeight: 800, cardHeight: 200, enableWindow: false });
        const queue = createDeferredQueue(6, pageSize);
        let callbackAttemptedDuringRecycle = false;

        const list = new VirtualList(dom.root, {
            getPage: queue.getPage,
            getTemplate: (datum) => {
                const el = new dom.MockElement("article");
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
                // Attempt re-entrant observer dispatch mid-recycle before #updateElement completes
                callbackAttemptedDuringRecycle = true;
                dom.fireBottom(true);
                dom.fireTop(true);
            },
            pageSize,
        });
        list.render();

        // Load Page 0 and Page 1 to reach poolLimit (10)
        dom.fireBottom(true);
        queue.pending.shift().resolve();
        await flushMicrotasks();

        dom.fireBottom(true);
        queue.pending.shift().resolve();
        await flushMicrotasks();

        // Trigger Page 2 (recycles elements and triggers re-entrant observer callback inside updateTemplate)
        dom.fireBottom(true);
        queue.pending.shift().resolve();
        await flushMicrotasks();

        assert.equal(callbackAttemptedDuringRecycle, true);
        assert.equal(queue.getMaxConcurrent(), 1);
        assert.deepEqual(queue.requestedPages, [0, 1, 2], "Lock must block observer dispatches until recycling and coordinate updates finish");
    });

    it("serially advances pages via post-fetch sentinel visibility check during rapid downward scrolling", async () => {
        const pageSize = 5;
        const cardHeight = 200;
        const stride = cardHeight + MARGIN * 2; // 232px per card, 1160px per 5-card page
        const dom = createViewportMockDOM({ viewportHeight: 800, cardHeight, enableWindow: true });
        const queue = createDeferredQueue(8, pageSize);

        const list = new VirtualList(dom.root, {
            getPage: queue.getPage,
            getTemplate: (datum) => {
                const el = new dom.MockElement("article");
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
            pageSize,
        });
        list.render();

        // Initial load starts Page 0
        dom.fireBottom(true);
        assert.deepEqual(queue.requestedPages, [0]);

        // User scrolls rapidly down to scrollY = 3900px while Page 0 is still fetching
        // (Viewport covers 3900..4700px -> requires Pages 0, 1, 2, 3 so bottomObserver reaches 4 * 1160 = 4640px;
        //  actually at 4640 + 100 = 4740, bottomRect.top = 4740 - 3900 = 840 > 775, so it stops right after Page 3!)
        dom.setScrollY(3900);
        dom.fireBottom(true);
        dom.fireBottom(true);
        assert.equal(queue.getInFlight(), 1, "Concurrent scroll bursts during Page 0 fetch are blocked");

        // Resolve Page 0 -> post-fetch check sees bottom boundary still above/inside viewport -> starts Page 1 serially
        queue.pending.shift().resolve();
        await flushMicrotasks();
        assert.equal(queue.getMaxConcurrent(), 1);
        assert.deepEqual(queue.requestedPages, [0, 1]);

        // Resolve Page 1 -> starts Page 2 serially
        queue.pending.shift().resolve();
        await flushMicrotasks();
        assert.equal(queue.getMaxConcurrent(), 1);
        assert.deepEqual(queue.requestedPages, [0, 1, 2]);

        // Resolve Page 2 -> starts Page 3 serially
        queue.pending.shift().resolve();
        await flushMicrotasks();
        assert.equal(queue.getMaxConcurrent(), 1);
        assert.deepEqual(queue.requestedPages, [0, 1, 2, 3]);

        // Resolve Page 3 -> bottomObserver is now below viewport (docTop = 4740, scrollY = 3900 -> top = 840 > 800), stops!
        queue.pending.shift().resolve();
        await flushMicrotasks();
        assert.equal(queue.getInFlight(), 0);
        assert.equal(queue.pending.length, 0);
        assert.equal(queue.getMaxConcurrent(), 1);
        assert.deepEqual(queue.requestedPages, [0, 1, 2, 3]);

        // Verify pool cap, sequential element ordering (Pages 2 & 3 -> Entries 10..19), and exact transforms
        assert.equal(list.pool.length, list.poolLimit);
        assert.equal(dom.elementsById.get("virtual-list").children.length, list.poolLimit);
        assert.equal(list.start, 2);
        assert.equal(list.end, 4);
        assert.deepEqual(
            list.pool.map((el) => el.textContent),
            Array.from({ length: 10 }, (_, idx) => `[Entry ${10 + idx}]`)
        );
        assert.deepEqual(
            list.pool.map((el) => Number(el.getAttribute("data-y"))),
            Array.from({ length: 10 }, (_, idx) => (10 + idx) * stride)
        );
        assert.equal(dom.elementsById.get("top-observer").style.transform, `translateY(${10 * stride}px)`);
        assert.equal(dom.elementsById.get("bottom-observer").style.transform, `translateY(${20 * stride}px)`);
    });

    it("recovers cleanly across rapid bidirectional scroll reversals without pool corruption or coordinate drift", async () => {
        const pageSize = 5;
        const cardHeight = 200;
        const stride = cardHeight + MARGIN * 2; // 232px per card, 1160px per page
        const dom = createViewportMockDOM({ viewportHeight: 800, cardHeight, enableWindow: true });
        const queue = createDeferredQueue(8, pageSize);

        const list = new VirtualList(dom.root, {
            getPage: queue.getPage,
            getTemplate: (datum) => {
                const el = new dom.MockElement("article");
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
            pageSize,
        });
        list.render();

        // Advance down to Pages 2 & 3 (start = 2, end = 4, items 10..19)
        dom.setScrollY(3900);
        dom.fireBottom(true);
        for (let i = 0; i < 4; i++) {
            queue.pending.shift().resolve();
            await flushMicrotasks();
        }
        assert.equal(list.start, 2);
        assert.equal(list.end, 4);

        // User scrolls down further to trigger Page 4 fetch, then IMMEDIATELY reverses to scrollY = 0 while Page 4 is active!
        dom.setScrollY(4100);
        dom.fireBottom(true);
        assert.equal(queue.getInFlight(), 1);
        assert.equal(queue.pending[0].page, 4);

        // Mid-flight upward reversal: topObserver fires while Page 4 is still loading
        dom.setScrollY(0);
        dom.fireTop(true);
        dom.fireTop(true);
        assert.equal(queue.getInFlight(), 1, "Top observer event during active bottom fetch must not execute concurrently");
        assert.equal(queue.pending.length, 1);

        // Resolve in-flight Page 4 -> pool temporarily holds Pages 3 & 4 (start = 3, end = 5),
        // then post-fetch check detects user at scrollY = 0 (above topObserver) and serially fetches Pages 2, 1, 0!
        queue.pending.shift().resolve(); // finishes Page 4 -> triggers Page 2
        await flushMicrotasks();
        assert.equal(list.start, 3);
        assert.equal(list.end, 5);
        assert.equal(queue.getInFlight(), 1);
        assert.equal(queue.pending[0].page, 2);

        queue.pending.shift().resolve(); // finishes Page 2 -> triggers Page 1
        await flushMicrotasks();
        assert.equal(list.start, 2);
        assert.equal(list.end, 4);
        assert.equal(queue.getInFlight(), 1);
        assert.equal(queue.pending[0].page, 1);

        queue.pending.shift().resolve(); // finishes Page 1 -> triggers Page 0
        await flushMicrotasks();
        assert.equal(list.start, 1);
        assert.equal(list.end, 3);
        assert.equal(queue.getInFlight(), 1);
        assert.equal(queue.pending[0].page, 0);

        queue.pending.shift().resolve(); // finishes Page 0 -> start === 0, stops!
        await flushMicrotasks();
        assert.equal(queue.getInFlight(), 0);
        assert.equal(queue.pending.length, 0);
        assert.equal(queue.getMaxConcurrent(), 1);

        // Verify pool holds Entries 0..9 in strict chronological order with aligned transforms
        assert.equal(list.start, 0);
        assert.equal(list.end, 2);
        assert.equal(list.pool.length, list.poolLimit);
        assert.deepEqual(
            list.pool.map((el) => el.textContent),
            Array.from({ length: 10 }, (_, idx) => `[Entry ${idx}]`)
        );
        const yCoords = list.pool.map((el) => Number(el.getAttribute("data-y")));
        assert.deepEqual(
            yCoords,
            Array.from({ length: 10 }, (_, idx) => idx * stride)
        );
        assert.equal(dom.elementsById.get("top-observer").style.transform, "translateY(0px)");
        assert.equal(dom.elementsById.get("bottom-observer").style.transform, `translateY(${10 * stride}px)`);
    });

    it("does not loop infinitely at end of dataset and releases lock cleanly if getPage rejects", async () => {
        const pageSize = 5;
        const dom = createViewportMockDOM({ viewportHeight: 800, cardHeight: 200, enableWindow: true });
        const queue = createDeferredQueue(2, pageSize); // Only Pages 0 and 1 exist

        const list = new VirtualList(dom.root, {
            getPage: queue.getPage,
            getTemplate: (datum) => {
                const el = new dom.MockElement("article");
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
            pageSize,
        });
        list.render();

        // Scroll to bottom of dataset (scrollY = 2000 keeps bottomObserver inside viewport for Pages 0, 1, and empty Page 2)
        dom.setScrollY(2000);
        dom.fireBottom(true);

        // Simulate transient error on first attempt to verify lock is released without unhandled rejection or retry loop
        const firstPending = queue.pending.shift();
        firstPending.reject(new Error("transient network error"));
        await flushMicrotasks();
        assert.equal(list.start, 0);
        assert.equal(list.end, 0);
        assert.equal(queue.getInFlight(), 0);
        assert.equal(queue.pending.length, 0, "Failed fetch must not auto-retry in a tight loop");

        // Subsequent scroll after error succeeds and stops cleanly once Page 2 returns []
        dom.fireBottom(true);
        queue.pending.shift().resolve(); // Page 0
        await flushMicrotasks();
        queue.pending.shift().resolve(); // Page 1
        await flushMicrotasks();
        assert.equal(queue.pending[0].page, 2);
        queue.pending.shift().resolve(); // Page 2 -> []
        await flushMicrotasks();

        assert.equal(queue.getInFlight(), 0);
        assert.equal(queue.pending.length, 0, "Empty batch at end of dataset must not re-trigger bottom fetch");
        assert.equal(list.start, 0);
        assert.equal(list.end, 2);
        assert.equal(list.pool.length, 10);
    });
});
