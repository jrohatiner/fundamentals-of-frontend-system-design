import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const MARGIN = 16;
const CARD_HEIGHT = 120;
const STRIDE = CARD_HEIGHT + MARGIN * 2;

function createFocusTestEnvironment({ viewportHeight = 0 } = {}) {
    const elementsById = new Map();
    let observerCallback = null;
    let scrollY = 0;
    const focusHistory = [];

    class MockElement {
        constructor(tagName, id = '') {
            this.tagName = tagName.toUpperCase();
            this.id = id;
            this.children = [];
            this.parentNode = null;
            this.attributes = new Map();
            this.style = {};
            this._textContent = '';
            this._height = CARD_HEIGHT;
        }

        get textContent() {
            if (this.children.length > 0 && !this._textContent) {
                return this.children.map((c) => c.textContent).join('');
            }
            return this._textContent;
        }

        set textContent(value) {
            // Mirror browser behavior: setting textContent replaces child nodes
            if (this.children.length > 0) {
                for (const child of this.children) {
                    if (child === globalThis.document.activeElement || child.contains(globalThis.document.activeElement)) {
                        globalThis.document.activeElement = globalThis.document.body;
                    }
                    child.parentNode = null;
                }
                this.children = [];
            }
            this._textContent = String(value);
        }

        setAttribute(name, value) {
            this.attributes.set(name, String(value));
        }

        getAttribute(name) {
            return this.attributes.has(name) ? this.attributes.get(name) : null;
        }

        appendChild(node) {
            if (node instanceof MockDocumentFragment) {
                for (const child of node.children) {
                    child.parentNode = this;
                    this.children.push(child);
                }
                node.children = [];
                return node;
            }
            node.parentNode = this;
            this.children.push(node);
            return node;
        }

        replaceChildren(...nodes) {
            for (const existing of this.children) {
                if (existing === globalThis.document.activeElement || existing.contains(globalThis.document.activeElement)) {
                    globalThis.document.activeElement = globalThis.document.body;
                }
                existing.parentNode = null;
            }
            this.children = [];
            for (const node of nodes) {
                this.appendChild(node);
            }
        }

        contains(target) {
            if (!target) {
                return false;
            }
            if (this === target) {
                return true;
            }
            return this.children.some((child) => child.contains(target));
        }

        focus(options) {
            globalThis.document.activeElement = this;
            focusHistory.push({ target: this, options });
        }

        blur() {
            if (globalThis.document.activeElement === this) {
                globalThis.document.activeElement = globalThis.document.body;
            }
        }

        getElementsByTagName(tag) {
            const upper = tag.toUpperCase();
            const results = [];
            for (const child of this.children) {
                if (child.tagName === upper) {
                    results.push(child);
                }
                results.push(...child.getElementsByTagName(tag));
            }
            return results;
        }

        getBoundingClientRect() {
            const yAttr = this.getAttribute('data-y');
            const absTop = yAttr != null ? Number(yAttr) : 0;
            const top = absTop - scrollY;
            return {
                top,
                y: top,
                bottom: top + this._height,
                height: this._height,
                left: 0,
                right: 400,
                width: 400,
                x: 0,
            };
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
        constructor() {
            this.children = [];
        }

        appendChild(node) {
            this.children.push(node);
            return node;
        }
    }

    const body = new MockElement('body', 'body');
    const documentElement = new MockElement('html', 'html');
    documentElement.appendChild(body);

    Object.defineProperty(body, 'innerHTML', {
        get() {
            return this._innerHTML ?? '';
        },
        set(html) {
            this._innerHTML = html;
            elementsById.clear();
            this.children = [];
            if (html.includes('id="container"')) {
                const container = new MockElement('div', 'container');
                const topObserver = new MockElement('div', 'top-observer');
                const list = new MockElement('main', 'virtual-list');
                const bottomObserver = new MockElement('div', 'bottom-observer');
                container.appendChild(topObserver);
                container.appendChild(list);
                container.appendChild(bottomObserver);
                this.appendChild(container);
                elementsById.set('container', container);
                elementsById.set('top-observer', topObserver);
                elementsById.set('virtual-list', list);
                elementsById.set('bottom-observer', bottomObserver);
            }
        },
    });

    globalThis.DocumentFragment = MockDocumentFragment;
    globalThis.IntersectionObserver = class {
        constructor(callback) {
            observerCallback = callback;
        }
        observe() {}
        disconnect() {}
    };

    globalThis.document = {
        body,
        documentElement,
        activeElement: body,
        getElementById(id) {
            return elementsById.get(id) ?? null;
        },
        createElement(tag) {
            return new MockElement(tag);
        },
    };

    if (viewportHeight > 0) {
        globalThis.window = { innerHeight: viewportHeight };
    } else {
        delete globalThis.window;
    }

    /**
     * Builds the exact card DOM structure from 5-6-scroll-preservation/end/index.html:
     * <article class="card">
     *   <h3></h3>
     *   <div class="card__body">
     *     <div class="card__body__image"></div>
     *     <section class="card__body__content" contenteditable="true"></section>
     *   </div>
     * </article>
     */
    function buildCardSubtree(datum) {
        const h3 = new MockElement('h3');
        h3.textContent = datum.title;

        const bodyWrapper = new MockElement('div');
        bodyWrapper.setAttribute('class', 'card__body');

        const image = new MockElement('div');
        image.setAttribute('class', 'card__body__image');

        const editableSection = new MockElement('section');
        editableSection.setAttribute('class', 'card__body__content');
        editableSection.setAttribute('contenteditable', 'true');
        editableSection.textContent = datum.body;

        bodyWrapper.appendChild(image);
        bodyWrapper.appendChild(editableSection);
        return [h3, bodyWrapper];
    }

    const getTemplate = (datum) => {
        const card = new MockElement('article');
        card.setAttribute('class', 'card');
        for (const child of buildCardSubtree(datum)) {
            card.appendChild(child);
        }
        return card;
    };

    const updateTemplate = (element, datum) => {
        const [cardTitle] = element.getElementsByTagName('h3');
        const [cardBody] = element.getElementsByTagName('section');
        [cardTitle.textContent, cardBody.textContent] = [datum.title, datum.body];
    };

    const destructiveUpdateTemplate = (element, datum) => {
        element.replaceChildren(...buildCardSubtree(datum));
    };

    const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

    return {
        MockElement,
        body,
        elementsById,
        focusHistory,
        getTemplate,
        updateTemplate,
        destructiveUpdateTemplate,
        setScrollY(nextScrollY) {
            scrollY = nextScrollY;
        },
        getEditableSection(card) {
            return card.getElementsByTagName('section')[0];
        },
        getCardTitle(card) {
            return card.getElementsByTagName('h3')[0].textContent;
        },
        async triggerBottom() {
            const bottom = elementsById.get('bottom-observer');
            observerCallback([{ isIntersecting: true, target: bottom }]);
            await flushTasks();
        },
        async triggerTop() {
            const top = elementsById.get('top-observer');
            observerCallback([{ isIntersecting: true, target: top }]);
            await flushTasks();
        },
    };
}

const { VirtualList } = await import('./virtual-list.js');

describe('VirtualList active element focus preservation', () => {
    const pageSize = 5;

    function createPages(totalPages = 6) {
        return Array.from({ length: totalPages }, (_, pageIdx) =>
            Array.from({ length: pageSize }, (__, itemIdx) => {
                const index = pageIdx * pageSize + itemIdx;
                return {
                    id: index,
                    title: `[Entry ${index}] - Title`,
                    body: `[Entry ${index}] - Body`,
                };
            })
        );
    }

    let env;

    beforeEach(() => {
        env = createFocusTestEnvironment();
    });

    it('retains focus and user edits on unchanged editable elements across forward and backward recycling', async () => {
        const pages = createPages();
        const list = new VirtualList(env.body, {
            getPage: async (p) => pages[p] ?? [],
            getTemplate: env.getTemplate,
            updateTemplate: env.updateTemplate,
            pageSize,
        });
        list.render();

        // Populate pool to capacity: Page 0 (0..4) and Page 1 (5..9)
        await env.triggerBottom();
        await env.triggerBottom();

        // Focus editable section on Entry 6 (index 6 in pool, part of Page 1 = unchanged on downward scroll)
        const targetCard = list.pool[6];
        const editable = env.getEditableSection(targetCard);
        editable.focus();
        editable.textContent = 'User custom note on Entry 6';
        assert.equal(globalThis.document.activeElement, editable);

        // Forward recycle: Page 0 recycled into Page 2 -> pool holds Entries 5..14
        await env.triggerBottom();
        assert.equal(globalThis.document.activeElement, editable, 'Focus must remain on the active editable section');
        assert.equal(editable.textContent, 'User custom note on Entry 6', 'User edits in unchanged item must be preserved');
        assert.equal(list.pool[1], targetCard);

        // Backward recycle: Page 2 recycled back into Page 0 -> pool holds Entries 0..9
        await env.triggerTop();
        assert.equal(globalThis.document.activeElement, editable, 'Focus must remain on the active editable section after upward recycle');
        assert.equal(editable.textContent, 'User custom note on Entry 6');
        assert.equal(list.pool[6], targetCard);
    });

    it('relocates focus from a recycled editable element to the nearest retained item during forward and backward recycling', async () => {
        const pages = createPages();
        const list = new VirtualList(env.body, {
            getPage: async (p) => pages[p] ?? [],
            getTemplate: env.getTemplate,
            updateTemplate: env.destructiveUpdateTemplate,
            pageSize,
        });
        list.render();

        // Populate Pages 0 and 1 (Entries 0..9)
        await env.triggerBottom();
        await env.triggerBottom();

        // Focus Entry 2 (in Page 0 -> will be recycled on downward scroll)
        const page0Editable = env.getEditableSection(list.pool[2]);
        page0Editable.focus();
        assert.equal(globalThis.document.activeElement, page0Editable);

        // Forward recycle (down): Page 0 recycled into Page 2; unchanged is Page 1 (Entries 5..9)
        // Nearest retained item in unchanged is unchanged[0] = Entry 5 (list.pool[0])
        await env.triggerBottom();
        const expectedForwardTarget = env.getEditableSection(list.pool[0]);
        assert.notEqual(globalThis.document.activeElement, env.body, 'Focus must not drop to document.body');
        assert.equal(globalThis.document.activeElement, expectedForwardTarget, 'Focus should relocate to nearest retained editable section (Entry 5)');
        assert.equal(env.getCardTitle(list.pool[0]), '[Entry 5] - Title');
        assert.deepEqual(env.focusHistory.at(-1)?.options, { preventScroll: true });

        // Now focus Entry 12 (list.pool[7], in Page 2 -> will be recycled on upward scroll)
        const page2Editable = env.getEditableSection(list.pool[7]);
        page2Editable.focus();
        assert.equal(globalThis.document.activeElement, page2Editable);

        // Backward recycle (up): Page 2 recycled into Page 0; unchanged is Page 1 (Entries 5..9, now at indices 5..9)
        // Nearest retained item in unchanged is unchanged[unchanged.length - 1] = Entry 9 (list.pool[9])
        await env.triggerTop();
        const expectedBackwardTarget = env.getEditableSection(list.pool[9]);
        assert.notEqual(globalThis.document.activeElement, env.body, 'Focus must not drop to document.body on upward recycle');
        assert.equal(globalThis.document.activeElement, expectedBackwardTarget, 'Focus should relocate to nearest retained editable section (Entry 9)');
        assert.equal(env.getCardTitle(list.pool[9]), '[Entry 9] - Title');
    });

    it('moves focus to the nearest visible sibling when an active editable element moves completely out of viewport bounds', async () => {
        env = createFocusTestEnvironment({ viewportHeight: 400 });
        const pages = createPages();
        const list = new VirtualList(env.body, {
            getPage: async (p) => pages[p] ?? [],
            getTemplate: env.getTemplate,
            updateTemplate: env.updateTemplate,
            pageSize,
        });
        list.render();

        // Populate Pages 0 and 1 (10 items, STRIDE = 152px each: Entry i is at y = i * 152)
        await env.triggerBottom();
        await env.triggerBottom();

        // Case 1: Focus is in unchanged[0] (Entry 5 at y = 760..880), but user scrolled down to scrollY = 1080
        // Viewport is [1080, 1480]:
        //   Entry 5 (760..880) -> off-screen above (bottom = -200)
        //   Entry 6 (912..1032) -> off-screen above (bottom = -48)
        //   Entry 7 (1064..1184) -> visible (bottom = +104, top = -16) -> nearest visible sibling!
        //   Entry 8 (1216..1336) -> visible
        //   Entry 9 (1368..1488) -> visible
        const entry5Editable = env.getEditableSection(list.pool[5]);
        entry5Editable.focus();
        env.setScrollY(1080);

        await env.triggerBottom();
        const entry7Editable = env.getEditableSection(list.pool[2]); // Entry 7 is at index 2 after downward shift
        assert.equal(env.getCardTitle(list.pool[2]), '[Entry 7] - Title');
        assert.equal(
            globalThis.document.activeElement,
            entry7Editable,
            'Off-screen active editable element should transfer focus to nearest visible sibling (Entry 7)'
        );

        // Case 2: Recycled element focused when scrolling up, with bottom of unchanged below viewport
        // Pool currently holds Entries 5..14 (y = 760..2280). Focus Entry 13 (in recycled bottom half).
        // User scrolled up to scrollY = 760, viewport is [760, 1160]:
        //   Entry 5 (760..880) -> visible
        //   Entry 6 (912..1032) -> visible
        //   Entry 7 (1064..1184) -> visible (bottommost visible item in unchanged!)
        //   Entry 8 (1216..1336) -> off-screen below (top = 456 >= 400)
        //   Entry 9 (1368..1488) -> off-screen below (top = 608 >= 400)
        const entry13Editable = env.getEditableSection(list.pool[8]);
        entry13Editable.focus();
        env.setScrollY(760);

        await env.triggerTop();
        // After upward recycle, pool holds Entries 0..9, so Entry 7 is at index 7
        assert.equal(env.getCardTitle(list.pool[7]), '[Entry 7] - Title');
        assert.equal(
            globalThis.document.activeElement,
            env.getEditableSection(list.pool[7]),
            'Upward recycle should transfer focus to nearest visible item in unchanged (Entry 7) rather than off-screen Entry 9'
        );
    });

    it('guards #updateData against focus destruction when updateTemplate replaces inner DOM nodes', async () => {
        const pages = createPages();
        const list = new VirtualList(env.body, {
            getPage: async (p) => pages[p] ?? [],
            getTemplate: env.getTemplate,
            updateTemplate: env.destructiveUpdateTemplate,
            pageSize,
        });
        // Configure single-page pool (poolLimit === pageSize) so unchanged is empty and #updateData handles active focus directly
        list.poolLimit = pageSize;
        list.render();

        await env.triggerBottom(); // Loads Page 0 (Entries 0..4)
        const card2 = list.pool[2];
        const oldEditable = env.getEditableSection(card2);
        oldEditable.focus();
        assert.equal(globalThis.document.activeElement, oldEditable);

        // Recycling single-page pool calls #updateData directly on [card0..card4], replacing inner children
        await env.triggerBottom(); // Loads Page 1 (Entries 5..9)
        const newEditable = env.getEditableSection(card2);
        assert.notEqual(newEditable, oldEditable, 'destructiveUpdateTemplate should have replaced the section node');
        assert.equal(
            globalThis.document.activeElement,
            newEditable,
            '#updateData must restore focus to the replacement editable element instead of dropping to body'
        );
        assert.equal(env.getCardTitle(card2), '[Entry 7] - Title');
    });

    it('handles null activeElement and elements outside the virtual list container without interference', async () => {
        const pages = createPages();
        const list = new VirtualList(env.body, {
            getPage: async (p) => pages[p] ?? [],
            getTemplate: env.getTemplate,
            updateTemplate: env.destructiveUpdateTemplate,
            pageSize,
        });
        list.render();

        // External button outside #virtual-list
        const externalButton = new env.MockElement('button', 'external-filter');
        env.body.appendChild(externalButton);

        await env.triggerBottom();
        await env.triggerBottom();

        // Subcase 1: document.activeElement is null
        globalThis.document.activeElement = null;
        env.focusHistory.length = 0;
        await env.triggerBottom();
        assert.equal(globalThis.document.activeElement, null, 'Null activeElement should remain untouched');
        assert.equal(env.focusHistory.length, 0, 'Should not invoke focus() when activeElement is null');

        // Subcase 2: document.activeElement belongs to an element outside #virtual-list
        externalButton.focus();
        env.focusHistory.length = 0;
        await env.triggerTop();
        await env.triggerBottom();
        assert.equal(
            globalThis.document.activeElement,
            externalButton,
            'Focus on element outside #virtual-list must remain untouched across forward and backward recycling'
        );
        assert.equal(env.focusHistory.length, 0, 'Should not steal focus from external elements');
    });
});
