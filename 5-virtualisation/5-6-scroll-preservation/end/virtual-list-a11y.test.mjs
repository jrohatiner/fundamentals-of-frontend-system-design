import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function parseAttributes(attrSource) {
    const attrs = new Map();
    const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
    let match;
    while ((match = attrRegex.exec(attrSource)) !== null) {
        attrs.set(match[1], match[2]);
    }
    return attrs;
}

class MockElement {
    constructor(tagName, id = '', initialAttrs = new Map()) {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.children = [];
        this.attributes = new Map(initialAttrs);
        if (id) {
            this.attributes.set('id', id);
        }
        this.style = {};
        this._textContent = '';
        this._height = 120;
        this.onTextChange = null;
    }

    get textContent() {
        return this._textContent;
    }

    set textContent(val) {
        this._textContent = String(val);
        if (typeof this.onTextChange === 'function') {
            this.onTextChange(this._textContent);
        }
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
        return 2400;
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

function setupA11yMockDOM() {
    const elementsById = new Map();
    let observerCallback = null;

    const root = new MockElement('body');
    Object.defineProperty(root, 'innerHTML', {
        get() {
            return this._innerHTML ?? '';
        },
        set(html) {
            this._innerHTML = html;
            elementsById.clear();
            this.children = [];

            const tagRegex = /<([a-zA-Z0-9]+)\s+([^>]*id="([^"]+)"[^>]*)>/g;
            let container = null;
            let match;
            while ((match = tagRegex.exec(html)) !== null) {
                const [, tag, attrStr, id] = match;
                const attrs = parseAttributes(attrStr);
                const el = new MockElement(tag, id, attrs);
                elementsById.set(id, el);
                if (id === 'container') {
                    container = el;
                    this.appendChild(container);
                } else if (container) {
                    container.appendChild(el);
                }
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
        constructor(cb) {
            observerCallback = cb;
        }
        observe() {}
        disconnect() {}
    };

    const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

    return {
        root,
        elementsById,
        triggerObserver(id) {
            const target = elementsById.get(id);
            observerCallback([{ isIntersecting: true, target }]);
        },
        flushMicrotasks,
    };
}

const { VirtualList } = await import('./virtual-list.js');

describe('VirtualList ARIA feed semantics, busy state, status region, and item posinset', () => {
    let dom;
    const pageSize = 5;

    beforeEach(() => {
        dom = setupA11yMockDOM();
    });

    it('renders #virtual-list with role="feed", aria-label="Feed", aria-busy="false" and a polite status live region inside #container', () => {
        const virtualList = new VirtualList(dom.root, {
            getPage: async () => [],
            getTemplate: () => new MockElement('article'),
            updateTemplate: () => {},
            pageSize,
            totalItems: 30,
        });
        virtualList.render();

        const container = dom.elementsById.get('container');
        const list = dom.elementsById.get('virtual-list');
        const status = dom.elementsById.get('virtual-list-status');

        assert.ok(container, 'Expected #container to be rendered');
        assert.ok(list, 'Expected #virtual-list to be rendered');
        assert.ok(status, 'Expected #virtual-list-status live region to be rendered');
        assert.ok(container.children.includes(status), 'Expected status region to be a child of #container');

        assert.equal(list.getAttribute('role'), 'feed');
        assert.equal(list.getAttribute('aria-label'), 'Feed');
        assert.equal(list.getAttribute('aria-busy'), 'false');

        assert.equal(status.getAttribute('role'), 'status');
        assert.equal(status.getAttribute('aria-live'), 'polite');
        assert.equal(status.textContent, '');
    });

    it('toggles aria-busy during async bottom and top loads and announces new ranges only after busy clears', async () => {
        const pendingResolvers = [];
        const pages = Array.from({ length: 6 }, (_, pageIdx) =>
            Array.from({ length: pageSize }, (__, idx) => ({
                title: `Entry ${pageIdx * pageSize + idx}`,
            }))
        );

        const virtualList = new VirtualList(dom.root, {
            getPage: (page) =>
                new Promise((resolve) => {
                    pendingResolvers.push({ page, resolve: () => resolve(pages[page] ?? []) });
                }),
            getTemplate: (datum) => {
                const el = new MockElement('article');
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
            pageSize,
            totalItems: 30,
        });
        virtualList.render();

        const list = dom.elementsById.get('virtual-list');
        const status = dom.elementsById.get('virtual-list-status');
        const observedStatusTransitions = [];
        status.onTextChange = (text) => {
            observedStatusTransitions.push({
                text,
                busyAtAnnouncement: list.getAttribute('aria-busy'),
            });
        };

        // Start Page 0 load -> aria-busy must be true while awaiting
        dom.triggerObserver('bottom-observer');
        assert.equal(list.getAttribute('aria-busy'), 'true');
        assert.equal(pendingResolvers.length, 1);

        pendingResolvers.shift().resolve();
        await dom.flushMicrotasks();

        assert.equal(list.getAttribute('aria-busy'), 'false');
        assert.equal(status.textContent, 'Loaded items 1 to 5 of 30.');

        // Load Page 1 (fill pool) and Page 2 (recycle downward)
        dom.triggerObserver('bottom-observer');
        assert.equal(list.getAttribute('aria-busy'), 'true');
        pendingResolvers.shift().resolve();
        await dom.flushMicrotasks();
        assert.equal(status.textContent, 'Loaded items 6 to 10 of 30.');

        dom.triggerObserver('bottom-observer');
        assert.equal(list.getAttribute('aria-busy'), 'true');
        pendingResolvers.shift().resolve();
        await dom.flushMicrotasks();
        assert.equal(list.getAttribute('aria-busy'), 'false');
        assert.equal(status.textContent, 'Loaded items 11 to 15 of 30.');

        // Trigger upward load back to Page 0
        dom.triggerObserver('top-observer');
        assert.equal(list.getAttribute('aria-busy'), 'true');
        pendingResolvers.shift().resolve();
        await dom.flushMicrotasks();
        assert.equal(list.getAttribute('aria-busy'), 'false');
        assert.equal(status.textContent, 'Loaded items 1 to 5 of 30.');

        // Every status announcement occurred with aria-busy already cleared to "false"
        assert.equal(observedStatusTransitions.length, 4);
        for (const entry of observedStatusTransitions) {
            assert.equal(entry.busyAtAnnouncement, 'false');
        }
    });

    it('updates aria-posinset and aria-setsize accurately across instantiation, downward recycling, upward recycling, and dynamic end discovery', async () => {
        const pages = [
            Array.from({ length: 5 }, (_, i) => ({ title: `Entry ${i}` })),
            Array.from({ length: 5 }, (_, i) => ({ title: `Entry ${5 + i}` })),
            Array.from({ length: 5 }, (_, i) => ({ title: `Entry ${10 + i}` })),
        ];

        // Omit totalItems initially so setSize starts at -1 (unknown) and resolves to 15 on empty page 3
        const virtualList = new VirtualList(dom.root, {
            getPage: async (page) => pages[page] ?? [],
            getTemplate: (datum) => {
                const el = new MockElement('article');
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
            pageSize,
        });
        virtualList.render();

        const status = dom.elementsById.get('virtual-list-status');

        // Page 0: posinset 1..5, setsize -1
        dom.triggerObserver('bottom-observer');
        await dom.flushMicrotasks();
        assert.deepEqual(
            virtualList.pool.map((el) => el.getAttribute('aria-posinset')),
            ['1', '2', '3', '4', '5']
        );
        assert.deepEqual(
            virtualList.pool.map((el) => el.getAttribute('aria-setsize')),
            ['-1', '-1', '-1', '-1', '-1']
        );
        assert.equal(status.textContent, 'Loaded items 1 to 5.');

        // Page 1: posinset 1..10, setsize -1
        dom.triggerObserver('bottom-observer');
        await dom.flushMicrotasks();
        assert.deepEqual(
            virtualList.pool.map((el) => el.getAttribute('aria-posinset')),
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
        );

        // Page 2 (downward recycle): pool holds items 6..15
        dom.triggerObserver('bottom-observer');
        await dom.flushMicrotasks();
        assert.deepEqual(
            virtualList.pool.map((el) => el.getAttribute('aria-posinset')),
            ['6', '7', '8', '9', '10', '11', '12', '13', '14', '15']
        );
        assert.equal(status.textContent, 'Loaded items 11 to 15.');

        // Page 3 (empty batch -> discovers end of feed = 15 items and syncs aria-setsize)
        dom.triggerObserver('bottom-observer');
        await dom.flushMicrotasks();
        assert.equal(dom.elementsById.get('virtual-list').getAttribute('aria-busy'), 'false');
        assert.deepEqual(
            virtualList.pool.map((el) => el.getAttribute('aria-setsize')),
            Array(10).fill('15')
        );

        // Upward recycle back to Page 0: pool holds items 1..10 of 15
        dom.triggerObserver('top-observer');
        await dom.flushMicrotasks();
        assert.deepEqual(
            virtualList.pool.map((el) => el.getAttribute('aria-posinset')),
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
        );
        assert.deepEqual(
            virtualList.pool.map((el) => el.getAttribute('aria-setsize')),
            Array(10).fill('15')
        );
        assert.equal(status.textContent, 'Loaded items 1 to 5 of 15.');
    });
});

function findChromeBinary() {
    const candidates = [
        process.env.CHROME_BIN,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function startStaticServer(rootDir) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const urlPath = new URL(req.url, 'http://127.0.0.1').pathname;
            const resolvedPath = path.resolve(rootDir, `.${urlPath}`);
            if (!resolvedPath.startsWith(rootDir) || !existsSync(resolvedPath)) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            const ext = path.extname(resolvedPath);
            res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
            res.end(readFileSync(resolvedPath));
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

async function launchHeadlessChrome(chromeBin) {
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'virtual-list-a11y-'));
    const proc = spawn(
        chromeBin,
        [
            '--headless',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            `--user-data-dir=${userDataDir}`,
            '--window-size=1280,900',
            '--remote-debugging-port=0',
            'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    const debugPort = await new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for Chrome DevTools port. Stderr: ${stderr}`));
        }, 10_000);

        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
            if (match) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });

        proc.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Chrome exited prematurely with code ${code}. Stderr: ${stderr}`));
        });
    });

    const targetsResponse = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await targetsResponse.json();
    const pageTarget = targets.find((target) => target.type === 'page');
    assert.ok(pageTarget?.webSocketDebuggerUrl, 'Expected a debuggable page target');

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map();

    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
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

    function send(method, params = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async function evaluate(expression) {
        const response = await send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (response.exceptionDetails) {
            throw new Error(
                response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
            );
        }
        return response.result.value;
    }

    async function cleanup() {
        try {
            ws.close();
        } catch {}
        if (proc.exitCode === null) {
            proc.kill('SIGKILL');
            await new Promise((resolve) => proc.once('exit', resolve));
        }
        try {
            rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {}
    }

    return { send, evaluate, cleanup };
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await evaluate(`Boolean(${predicateExpr})`);
        if (ok) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out waiting for condition: ${predicateExpr}`);
}

const chromeBin = findChromeBinary();

describe('index.html Headless Chrome Accessibility Tree & Pagination Integration', { skip: !chromeBin }, () => {
    it('exposes feed role, accessible name, busy state, polite status updates, posinset/setsize, and editable content in browser', async (t) => {
        const { server, baseUrl } = await startStaticServer(REPO_ROOT);
        t.after(() => server.close());

        const chrome = await launchHeadlessChrome(chromeBin);
        t.after(async () => {
            await chrome.cleanup();
        });

        await chrome.send('Page.enable');
        await chrome.send('Runtime.enable');
        await chrome.send('Accessibility.enable');

        await chrome.send('Page.navigate', {
            url: `${baseUrl}/5-virtualisation/5-6-scroll-preservation/end/index.html`,
        });

        // During initial 1000ms mock DB delay, #virtual-list must report aria-busy="true"
        await waitForCondition(
            chrome.evaluate,
            `document.getElementById('virtual-list')?.getAttribute('aria-busy') === 'true'`
        );

        const axDuringLoad = await chrome.send('Accessibility.getFullAXTree');
        const feedBusyNode = axDuringLoad.nodes.find((n) => n.role?.value === 'feed');
        assert.ok(feedBusyNode, 'Expected feed node in Accessibility Tree during loading');
        assert.equal(feedBusyNode.name?.value, 'Feed');
        const busyProp = (feedBusyNode.properties ?? []).find((p) => p.name === 'busy');
        assert.ok(busyProp?.value?.value, 'Expected feed AXNode to expose busy=true while awaiting getPage');

        // Wait for initial batch (Page 0: items 1..10) to finish rendering
        await waitForCondition(
            chrome.evaluate,
            `document.querySelectorAll('#virtual-list article.card').length === 10 && document.getElementById('virtual-list').getAttribute('aria-busy') === 'false'`
        );

        const axAtRest = await chrome.send('Accessibility.getFullAXTree');
        const feedNode = axAtRest.nodes.find((n) => n.role?.value === 'feed');
        const statusNode = axAtRest.nodes.find((n) => n.role?.value === 'status');
        const articleNodes = axAtRest.nodes.filter((n) => n.role?.value === 'article');

        assert.equal(feedNode?.name?.value, 'Feed');
        assert.ok(statusNode, 'Expected status live region in Accessibility Tree');
        const liveProp = (statusNode.properties ?? []).find((p) => p.name === 'live');
        assert.equal(liveProp?.value?.value, 'polite');
        assert.equal(articleNodes.length, 10);

        const initialSnapshot = await chrome.evaluate(`
            (() => {
                const articles = Array.from(document.querySelectorAll('#virtual-list article.card'));
                return {
                    statusText: document.getElementById('virtual-list-status').textContent,
                    posInSet: articles.map((el) => el.getAttribute('aria-posinset')),
                    setSize: articles.map((el) => el.getAttribute('aria-setsize')),
                    editableCount: document.querySelectorAll('#virtual-list article.card section.card__body__content[contenteditable="true"]').length,
                };
            })()
        `);

        assert.equal(initialSnapshot.statusText, 'Loaded items 1 to 10 of 100.');
        assert.deepEqual(
            initialSnapshot.posInSet,
            Array.from({ length: 10 }, (_, i) => String(i + 1))
        );
        assert.deepEqual(initialSnapshot.setSize, Array(10).fill('100'));
        assert.equal(initialSnapshot.editableCount, 10);

        // Scroll to trigger Page 1 (items 11..20) and Page 2 (recycled: pool holds items 11..30)
        await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
        await waitForCondition(
            chrome.evaluate,
            `document.getElementById('virtual-list-status').textContent === 'Loaded items 11 to 20 of 100.'`
        );

        await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
        await waitForCondition(
            chrome.evaluate,
            `document.getElementById('virtual-list-status').textContent === 'Loaded items 21 to 30 of 100.'`
        );

        const recycledDownSnapshot = await chrome.evaluate(`
            (() => {
                const articles = Array.from(document.querySelectorAll('#virtual-list article.card'))
                    .sort((a, b) => Number(a.getAttribute('data-y')) - Number(b.getAttribute('data-y')));
                return {
                    count: articles.length,
                    posInSet: articles.map((el) => el.getAttribute('aria-posinset')),
                    setSize: articles.map((el) => el.getAttribute('aria-setsize')),
                    firstTitle: articles[0].querySelector('h3').textContent,
                    lastTitle: articles.at(-1).querySelector('h3').textContent,
                };
            })()
        `);

        assert.equal(recycledDownSnapshot.count, 20);
        assert.deepEqual(
            recycledDownSnapshot.posInSet,
            Array.from({ length: 20 }, (_, i) => String(11 + i))
        );
        assert.deepEqual(recycledDownSnapshot.setSize, Array(20).fill('100'));
        assert.match(recycledDownSnapshot.firstTitle, /\[Entry 10\]/);
        assert.match(recycledDownSnapshot.lastTitle, /\[Entry 29\]/);

        // Scroll back up to top-observer -> prepends Page 0 (items 1..10)
        await chrome.evaluate(`document.getElementById('top-observer').scrollIntoView()`);
        await waitForCondition(
            chrome.evaluate,
            `document.getElementById('virtual-list-status').textContent === 'Loaded items 1 to 10 of 100.'`
        );

        const recycledUpSnapshot = await chrome.evaluate(`
            (() => {
                const articles = Array.from(document.querySelectorAll('#virtual-list article.card'))
                    .sort((a, b) => Number(a.getAttribute('data-y')) - Number(b.getAttribute('data-y')));
                return {
                    posInSet: articles.map((el) => el.getAttribute('aria-posinset')),
                    setSize: articles.map((el) => el.getAttribute('aria-setsize')),
                };
            })()
        `);

        assert.deepEqual(
            recycledUpSnapshot.posInSet,
            Array.from({ length: 20 }, (_, i) => String(1 + i))
        );
        assert.deepEqual(recycledUpSnapshot.setSize, Array(20).fill('100'));
    });
});
