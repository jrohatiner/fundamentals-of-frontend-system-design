import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualList } from './virtual-list.js';
import { initMockDB } from '../../../utils/db.js';

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
    constructor(tagName, id = '', registry = null, height = 120) {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this._registry = registry;
        this._height = height;
        this.attributes = new Map();
        this.children = [];
        this.style = { transform: '', height: '' };
        this.textContent = '';
        this._innerHTML = '';
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
            const container = new MockElement('div', 'container', this._registry, 0);
            const topObserver = new MockElement('div', 'top-observer', this._registry, 100);
            topObserver.textContent = 'Top Observer';
            const virtualList = new MockElement('main', 'virtual-list', this._registry, 0);
            const bottomObserver = new MockElement('div', 'bottom-observer', this._registry, 100);
            bottomObserver.textContent = 'Bottom Observer';
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
        const list = this._registry?.get('virtual-list');
        if (!list || list.children.length === 0) {
            return 200;
        }
        let maxBottom = 0;
        for (const item of list.children) {
            const itemY = Number(item.getAttribute('data-y') ?? 0);
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

    const root = new MockElement('body', 'root', registry, 800);

    globalThis.document = {
        body: root,
        getElementById(id) {
            return registry.get(id) ?? null;
        },
        createElement(tag) {
            return new MockElement(tag, '', registry, 120);
        },
    };
    globalThis.DocumentFragment = MockDocumentFragment;
    globalThis.IntersectionObserver = MockIntersectionObserver;

    return {
        root,
        registry,
        getActiveObserver() {
            assert.equal(observers.length, 1, 'Expected one IntersectionObserver instance');
            return observers[0];
        },
        getTopSentinel() {
            return registry.get('top-observer');
        },
        getBottomSentinel() {
            return registry.get('bottom-observer');
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
        const element = new MockElement('article', '', registry, 120);
        updateTemplate(element, datum);
        return element;
    };
    return { getTemplate, updateTemplate };
}

describe('VirtualList in-flight pagination lock', () => {
    let dom;

    beforeEach(() => {
        dom = setupMockDOM();
    });

    afterEach(() => {
        delete globalThis.document;
        delete globalThis.DocumentFragment;
        delete globalThis.IntersectionObserver;
    });

    it('deduplicates overlapping bottom intersection triggers during delayed initMockDB.getPage responses', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        const pageSize = 5;
        const db = initMockDB({ title: 'Card', body: 'Content' }, 50, pageSize);
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
            Array.from({ length: 5 }, (_, i) => `[Entry ${i}] - Card`)
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
            Array.from({ length: 10 }, (_, i) => `[Entry ${i + 5}] - Card`)
        );
    });

    it('deduplicates overlapping top intersection triggers and mixed single-batch entries', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        const pageSize = 5;
        const db = initMockDB({ title: 'Card', body: 'Content' }, 50, pageSize);
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
            Array.from({ length: 10 }, (_, i) => `[Entry ${i + 5}] - Card`)
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
            Array.from({ length: 10 }, (_, i) => `[Entry ${i}] - Card`)
        );
    });

    it('resets #isLoading to false when getPage rejects or throws on bottom pagination, allowing retry', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        const pageSize = 5;
        const db = initMockDB({ title: 'Card', body: 'Content' }, 50, pageSize);
        const attempts = [];
        let callCount = 0;

        const { getTemplate, updateTemplate } = createTemplateHelpers(dom.registry);
        const list = new VirtualList(dom.root, {
            getPage: (pointer) => {
                callCount++;
                attempts.push({ callCount, pointer });
                if (callCount === 1) {
                    return new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Simulated network timeout')), 500);
                    });
                }
                if (callCount === 2) {
                    throw new Error('Simulated synchronous error');
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
            Array.from({ length: 5 }, (_, i) => `[Entry ${i}] - Card`)
        );
    });

    it('resets #isLoading to false when getPage rejects on top pagination without deadlocking start pointer', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        const pageSize = 5;
        const db = initMockDB({ title: 'Card', body: 'Content' }, 50, pageSize);
        let shouldFailNextTopLoad = false;
        const requestedPages = [];

        const { getTemplate, updateTemplate } = createTemplateHelpers(dom.registry);
        const list = new VirtualList(dom.root, {
            getPage: (pointer) => {
                requestedPages.push(pointer);
                if (shouldFailNextTopLoad) {
                    shouldFailNextTopLoad = false;
                    return new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Top page fetch failed')), 400);
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
            Array.from({ length: 10 }, (_, i) => `[Entry ${i + 5}] - Card`)
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
            Array.from({ length: 10 }, (_, i) => `[Entry ${i}] - Card`)
        );
    });
});
