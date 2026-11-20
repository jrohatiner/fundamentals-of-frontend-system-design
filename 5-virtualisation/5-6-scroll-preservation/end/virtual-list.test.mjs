import test from 'node:test';
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
    constructor(tagName, ownerDocument, id = '') {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.id = id;
        this.style = {};
        this.textContent = '';
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
        if (name === 'id') {
            this.id = str;
            this.ownerDocument.registerById(str, this);
        }
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(node) {
        if (node instanceof MockDocumentFragment) {
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
            const match = /translateY\(([-\d.]+)px\)/.exec(el.style.transform ?? '');
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
            const container = new MockElement('div', this.ownerDocument, 'container');
            container._height = 0;
            const topObserver = new MockElement('div', this.ownerDocument, 'top-observer');
            topObserver._height = 100;
            const virtualList = new MockElement('main', this.ownerDocument, 'virtual-list');
            virtualList._height = 0;
            const bottomObserver = new MockElement('div', this.ownerDocument, 'bottom-observer');
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
            return new MockElement(tag, mockDocument);
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
    globalThis.DocumentFragment = MockDocumentFragment;
    globalThis.IntersectionObserver = MockIntersectionObserver;

    const root = new MockElement('body', mockDocument);

    const updateTemplate = (element, datum) => {
        const [cardTitle] = element.getElementsByTagName('h3');
        const [cardBody] = element.getElementsByTagName('section');
        cardTitle.textContent = datum.title;
        cardBody.textContent = datum.body;
    };

    const getTemplate = (datum) => {
        const card = new MockElement('article', mockDocument);
        const title = new MockElement('h3', mockDocument);
        const body = new MockElement('section', mockDocument);
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

test('stops pagination, unobserves bottom sentinel, and preserves rendered cards on data exhaustion', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { root, mockDocument, observers, getTemplate, updateTemplate } = setupDOMEnvironment();

    const db = initMockDB({ title: 'Card Title', body: 'Card Body' }, 30, 10);
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

    // Advance 100ms so intersectionObserver registers top and bottom sentinels
    t.mock.timers.tick(100);
    const bottomObserver = mockDocument.getElementById('bottom-observer');
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
        (card) => card.getElementsByTagName('h3')[0].textContent
    );
    assert.equal(renderedBeforeExhaustion[0], '[Entry 10] - Card Title');
    assert.equal(renderedBeforeExhaustion[19], '[Entry 29] - Card Title');

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
        (card) => card.getElementsByTagName('h3')[0].textContent
    );
    assert.deepEqual(renderedAfterExhaustion, renderedBeforeExhaustion);

    // Even if observer callback were invoked directly after exhaustion, #handleIntersection filters it out
    observer.callback([{ target: bottomObserver, isIntersecting: true }], observer);
    t.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.deepEqual(requestedPages, [0, 1, 2, 3]);
});

test('cleanly unobserves bottom sentinel without errors when initial dataset is empty', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { root, mockDocument, observers, getTemplate, updateTemplate } = setupDOMEnvironment();

    const db = initMockDB({ title: 'Empty', body: 'Empty' }, 0, 10);
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
    const bottomObserver = mockDocument.getElementById('bottom-observer');

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

test('prevents duplicate concurrent page fetches while isLoading is true', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { root, mockDocument, observers, getTemplate, updateTemplate } = setupDOMEnvironment();

    const db = initMockDB({ title: 'Item', body: 'Body' }, 20, 10);
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
    const bottomObserver = mockDocument.getElementById('bottom-observer');

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

test('preserves normal top observer backward scroll recycling', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { root, mockDocument, observers, getTemplate, updateTemplate } = setupDOMEnvironment();

    const db = initMockDB({ title: 'Item', body: 'Body' }, 40, 10);
    const list = new VirtualList(root, {
        getPage: (page) => db.getPage(page),
        getTemplate,
        updateTemplate,
        pageSize: 10,
    });

    list.render();
    t.mock.timers.tick(100);

    const observer = observers[0];
    const topObserver = mockDocument.getElementById('top-observer');
    const bottomObserver = mockDocument.getElementById('bottom-observer');

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
    const titles = list.pool.map((card) => card.getElementsByTagName('h3')[0].textContent);
    assert.equal(titles[0], '[Entry 0] - Item');
    assert.equal(titles[19], '[Entry 19] - Item');
});
