import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

class MockElement {
    constructor(tagName, id = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.children = [];
        this.attributes = new Map();
        this.style = {};
        this.textContent = '';
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
        return { height: this._height, top: 0, bottom: this._height, left: 0, right: 400, width: 400 };
    }

    get scrollHeight() {
        return this.children.reduce((maxBottom, child) => {
            const childBottom = child.children.reduce((acc, item) => {
                const yAttr = item.getAttribute('data-y');
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

    const root = new MockElement('main', 'container');
    elementsById.set('container', root);
    Object.defineProperty(root, 'innerHTML', {
        get() {
            return this._innerHTML ?? '';
        },
        set(html) {
            this._innerHTML = html;
            elementsById.clear();
            elementsById.set('container', this);
            this.children = [];
            if (html.includes('id="virtual-list"')) {
                const topObserver = new MockElement('div', 'top-observer');
                const list = new MockElement('div', 'virtual-list');
                const bottomObserver = new MockElement('div', 'bottom-observer');
                this.appendChild(topObserver);
                this.appendChild(list);
                this.appendChild(bottomObserver);
                elementsById.set('top-observer', topObserver);
                elementsById.set('virtual-list', list);
                elementsById.set('bottom-observer', bottomObserver);
            }
        }
    });

    globalThis.document = {
        getElementById(id) {
            return elementsById.get(id) ?? null;
        },
        createElement(tag) {
            return new MockElement(tag);
        }
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
            const bottom = elementsById.get('bottom-observer');
            observerCallback([{ isIntersecting: true, target: bottom }]);
            await flushTasks();
        },
        async triggerTop() {
            const top = elementsById.get('top-observer');
            observerCallback([{ isIntersecting: true, target: top }]);
            await flushTasks();
        }
    };
}

const { VirtualList } = await import('./virtual-list.js');

describe('VirtualList DOM allocation and recycling', () => {
    let dom;
    const pageSize = 5;

    beforeEach(() => {
        dom = setupMockDOM();
    });

    function createFixture({ totalPages = 6 } = {}) {
        let getTemplateCalls = 0;
        let updateTemplateCalls = 0;
        const requestedPages = [];

        const pages = Array.from({ length: totalPages }, (_, pageIdx) =>
            Array.from({ length: pageSize }, (__, itemIdx) => ({
                id: pageIdx * pageSize + itemIdx,
                title: `Entry ${pageIdx * pageSize + itemIdx}`
            }))
        );

        const getTemplate = (datum) => {
            getTemplateCalls++;
            const el = new MockElement('article');
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
            pageSize
        });

        virtualList.render();

        return {
            virtualList,
            getStats: () => ({
                getTemplateCalls,
                updateTemplateCalls,
                fragmentAllocations: MockDocumentFragment.allocationCount,
                requestedPages: [...requestedPages],
                mountedCount: dom.elementsById.get('virtual-list').children.length
            })
        };
    }

    it('allocates DOM nodes and DocumentFragments only while populating pool up to poolLimit', async () => {
        const { virtualList, getStats } = createFixture();

        // Page 0: pool grows 0 -> 5 (< poolLimit 10)
        await dom.triggerBottom();
        assert.equal(virtualList.pool.length, 5);
        assert.deepEqual(getStats(), {
            getTemplateCalls: 5,
            updateTemplateCalls: 0,
            fragmentAllocations: 1,
            requestedPages: [0],
            mountedCount: 5
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
            mountedCount: 10
        });
    });

    it('ceases props.getTemplate calls and DocumentFragment allocations once pool reaches poolLimit', async () => {
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
        assert.equal(stats.getTemplateCalls, virtualList.poolLimit, 'getTemplate must not be called after pool reaches poolLimit');
        assert.equal(stats.fragmentAllocations, 2, 'DocumentFragment must not be allocated after pool reaches poolLimit');
        assert.equal(stats.updateTemplateCalls, pageSize * 3, 'updateTemplate should update recycled elements for each recycled page');
        assert.equal(stats.mountedCount, virtualList.poolLimit, 'mounted DOM child count must stay capped at poolLimit');
        assert.equal(virtualList.start, 3);
        assert.equal(virtualList.end, 5);

        // Pool must contain the exact same HTMLElement instances (rotated, never re-created)
        assert.equal(virtualList.pool.length, virtualList.poolLimit);
        for (const node of virtualList.pool) {
            assert.ok(initialPoolNodes.includes(node), 'pool should reuse existing DOM elements');
        }
        assert.deepEqual(
            virtualList.pool.map((el) => el.textContent),
            Array.from({ length: 10 }, (_, idx) => `Entry ${15 + idx}`)
        );
    });

    it('preserves zero additional allocations across upward and downward scroll recycling', async () => {
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
            Array.from({ length: 10 }, (_, idx) => `Entry ${5 + idx}`)
        );

        await dom.triggerBottom();
        assert.deepEqual(
            virtualList.pool.map((el) => el.textContent),
            Array.from({ length: 10 }, (_, idx) => `Entry ${10 + idx}`)
        );

        const stats = getStats();
        assert.equal(stats.getTemplateCalls, virtualList.poolLimit);
        assert.equal(stats.fragmentAllocations, 2);
    });

    it('does not allocate elements or modify pool contents when getPage returns an empty batch', async () => {
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
        assert.deepEqual(virtualList.pool, poolSnapshot, 'pool order and references must remain unchanged');
        assert.deepEqual(virtualList.pool.map((el) => el.textContent), textSnapshot, 'pool element content must remain unchanged');
        assert.equal(virtualList.start, 0);
        assert.equal(virtualList.end, 2);
        assert.equal(getStats().getTemplateCalls, virtualList.poolLimit);
        assert.equal(getStats().fragmentAllocations, 2);
        assert.equal(getStats().updateTemplateCalls, 0);
    });
});
