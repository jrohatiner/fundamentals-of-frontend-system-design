import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { intersectionObserver } from './observer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

class MockElement {
    constructor(tagName = 'div', id = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.nodeType = 1;
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

    appendChild(child) {
        if (child && Array.isArray(child.children) && child.nodeType === 11) {
            this.children.push(...child.children);
            child.children = [];
            return child;
        }
        this.children.push(child);
        return child;
    }

    getBoundingClientRect() {
        const yAttr = this.getAttribute('data-y');
        const top = yAttr != null ? Number(yAttr) : 0;
        return {
            top,
            y: top,
            bottom: top + this._height,
            height: this._height,
            width: 600,
            left: 0,
            right: 600,
        };
    }

    get scrollHeight() {
        return 2400;
    }
}

describe('intersectionObserver unit tests', () => {
    let originalIntersectionObserver;
    let originalElement;
    let originalSetTimeout;
    let createdObservers;
    let setTimeoutCalls;

    class RecordingIntersectionObserver {
        constructor(callback, options) {
            this.callback = callback;
            this.options = options;
            this.observed = [];
            this.disconnected = false;
            createdObservers.push(this);
        }

        observe(target) {
            this.observed.push(target);
        }

        unobserve(target) {
            this.observed = this.observed.filter((item) => item !== target);
        }

        disconnect() {
            this.disconnected = true;
        }

        takeRecords() {
            return [];
        }
    }

    beforeEach(() => {
        originalIntersectionObserver = globalThis.IntersectionObserver;
        originalElement = globalThis.Element;
        originalSetTimeout = globalThis.setTimeout;
        createdObservers = [];
        setTimeoutCalls = 0;

        globalThis.IntersectionObserver = RecordingIntersectionObserver;
        delete globalThis.Element;
        globalThis.setTimeout = (...args) => {
            setTimeoutCalls += 1;
            return originalSetTimeout(...args);
        };
    });

    afterEach(() => {
        globalThis.IntersectionObserver = originalIntersectionObserver;
        if (originalElement === undefined) {
            delete globalThis.Element;
        } else {
            globalThis.Element = originalElement;
        }
        globalThis.setTimeout = originalSetTimeout;
    });

    it('registers targets synchronously without setTimeout and returns the IntersectionObserver instance', () => {
        const topSentinel = new MockElement('div', 'top-observer');
        const bottomSentinel = new MockElement('div', 'bottom-observer');
        const callback = () => {};

        const observer = intersectionObserver([topSentinel, bottomSentinel], callback);

        assert.ok(observer instanceof RecordingIntersectionObserver);
        assert.equal(observer, createdObservers[0]);
        assert.equal(setTimeoutCalls, 0, 'intersectionObserver must not schedule setTimeout');
        assert.deepEqual(
            observer.observed,
            [topSentinel, bottomSentinel],
            'targets must be observed synchronously before intersectionObserver returns'
        );
        assert.equal(observer.callback, callback);
    });

    it('normalizes a single target element and observes it synchronously', () => {
        const singleSentinel = new MockElement('div', 'bottom-observer');
        const observer = intersectionObserver(singleSentinel, () => {});

        assert.deepEqual(observer.observed, [singleSentinel]);
    });

    it('observes iterable Element instances (such as <select>) as a single element rather than unpacking child options', () => {
        class MockDomElement {}
        class MockSelectElement extends MockDomElement {
            constructor(options) {
                super();
                this._options = options;
            }
            [Symbol.iterator]() {
                return this._options[Symbol.iterator]();
            }
        }

        globalThis.Element = MockDomElement;
        const opt1 = new MockDomElement();
        const opt2 = new MockDomElement();
        const selectEl = new MockSelectElement([opt1, opt2]);

        const observer = intersectionObserver(selectEl, () => {});
        assert.deepEqual(observer.observed, [selectEl]);
    });

    it('supports iterable collections such as Set and NodeList-like iterables', () => {
        const first = new MockElement('div', 'first');
        const second = new MockElement('div', 'second');
        const nodeListLike = {
            *[Symbol.iterator]() {
                yield first;
                yield null;
                yield second;
            },
        };

        const fromSet = intersectionObserver(new Set([first, second]), () => {});
        assert.deepEqual(fromSet.observed, [first, second]);

        const fromIterable = intersectionObserver(nodeListLike, () => {});
        assert.deepEqual(fromIterable.observed, [first, second]);
    });

    it('skips null, undefined, primitives, plain objects, and non-Element DOM nodes without throwing', () => {
        const validTop = new MockElement('div', 'top-observer');
        const validBottom = new MockElement('div', 'bottom-observer');

        const mixedTargets = [
            null,
            validTop,
            undefined,
            false,
            0,
            'bottom-observer',
            {},
            { nodeType: 3, textContent: 'text node' },
            { nodeType: 8, textContent: 'comment node' },
            { nodeType: 9 },
            { nodeType: 11, children: [] },
            validBottom,
        ];

        const observer = intersectionObserver(mixedTargets, () => {});
        assert.deepEqual(observer.observed, [validTop, validBottom]);
    });

    it('handles empty arrays, nullish targets, and invalid single targets gracefully', () => {
        for (const invalidTarget of [[], [null, undefined], null, undefined, {}, 'selector', 123, false]) {
            const observer = intersectionObserver(invalidTarget, () => {});
            assert.ok(observer instanceof RecordingIntersectionObserver);
            assert.deepEqual(observer.observed, []);
        }
    });

    it('validates real and cross-realm Element instances when global Element is defined', () => {
        class MainRealmElement {}
        class IframeRealmElement {}

        globalThis.Element = MainRealmElement;

        const mainEl = new MainRealmElement();
        const iframeEl = Object.assign(new IframeRealmElement(), {
            ownerDocument: {
                defaultView: {
                    Element: IframeRealmElement,
                },
            },
        });
        const fakeElementLiteral = { nodeType: 1, tagName: 'DIV' };

        const observer = intersectionObserver([mainEl, fakeElementLiteral, iframeEl, null], () => {});
        assert.deepEqual(observer.observed, [mainEl, iframeEl]);
    });

    it('applies default threshold config and merges custom options without mutating defaults', () => {
        const el = new MockElement('div', 'target');

        const defaultObs = intersectionObserver(el, () => {});
        assert.deepEqual(defaultObs.options, { threshold: 0.25 });

        const emptyConfigObs = intersectionObserver(el, () => {}, {});
        assert.deepEqual(emptyConfigObs.options, { threshold: 0.25 });

        const customObs = intersectionObserver(el, () => {}, {
            threshold: [0, 0.75],
            rootMargin: '16px',
        });
        assert.deepEqual(customObs.options, {
            threshold: [0, 0.75],
            rootMargin: '16px',
        });

        const subsequentDefaultObs = intersectionObserver(el, () => {}, null);
        assert.deepEqual(subsequentDefaultObs.options, { threshold: 0.25 });
    });
});

describe('VirtualList consumer integration (5-2 and 5-6)', () => {
    let originalDocument;
    let originalDocumentFragment;
    let originalIntersectionObserver;
    let originalElement;

    beforeEach(() => {
        originalDocument = globalThis.document;
        originalDocumentFragment = globalThis.DocumentFragment;
        originalIntersectionObserver = globalThis.IntersectionObserver;
        originalElement = globalThis.Element;
        delete globalThis.Element;
    });

    afterEach(() => {
        globalThis.document = originalDocument;
        globalThis.DocumentFragment = originalDocumentFragment;
        globalThis.IntersectionObserver = originalIntersectionObserver;
        if (originalElement === undefined) {
            delete globalThis.Element;
        } else {
            globalThis.Element = originalElement;
        }
    });

    function createVirtualListDOM({ omitTopSentinel = false } = {}) {
        const elementsById = new Map();
        const observedTargets = [];
        let activeCallback = null;

        const root = new MockElement('body', 'body');
        Object.defineProperty(root, 'innerHTML', {
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
                    if (!omitTopSentinel) {
                        container.appendChild(topObserver);
                        elementsById.set('top-observer', topObserver);
                    }
                    container.appendChild(list);
                    container.appendChild(bottomObserver);
                    this.appendChild(container);
                    elementsById.set('container', container);
                    elementsById.set('virtual-list', list);
                    elementsById.set('bottom-observer', bottomObserver);
                }
            },
        });

        globalThis.DocumentFragment = class {
            constructor() {
                this.nodeType = 11;
                this.children = [];
            }
            appendChild(node) {
                this.children.push(node);
                return node;
            }
        };

        globalThis.document = {
            getElementById(id) {
                return elementsById.get(id) ?? null;
            },
        };

        globalThis.IntersectionObserver = class {
            constructor(callback) {
                activeCallback = callback;
            }
            observe(target) {
                observedTargets.push(target);
                // Simulate immediate initial boundary intersection notification on observe
                queueMicrotask(() => {
                    activeCallback([{ isIntersecting: true, target }]);
                });
            }
            disconnect() {}
        };

        return { root, elementsById, observedTargets };
    }

    it('5-2-observer-handling VirtualList observes sentinels synchronously on render and tolerates null sentinels', async () => {
        const { VirtualList } = await import('../5-virtualisation/5-2-observer-handling/end/virtual-list.js');

        const fullDom = createVirtualListDOM();
        const list = new VirtualList(fullDom.root, {});
        list.render();

        assert.equal(fullDom.observedTargets.length, 2, 'both sentinels must be registered synchronously during render()');
        assert.deepEqual(
            fullDom.observedTargets.map((el) => el.id),
            ['bottom-observer', 'top-observer']
        );

        // Verify null sentinel resilience when top-observer is absent
        const partialDom = createVirtualListDOM({ omitTopSentinel: true });
        const partialList = new VirtualList(partialDom.root, {});
        assert.doesNotThrow(() => partialList.render());
        assert.deepEqual(
            partialDom.observedTargets.map((el) => el.id),
            ['bottom-observer']
        );
    });

    it('5-6-scroll-preservation VirtualList observes sentinels synchronously and loads initial page immediately on mount', async () => {
        const { VirtualList } = await import('../5-virtualisation/5-6-scroll-preservation/end/virtual-list.js');

        const dom = createVirtualListDOM();
        const requestedPages = [];
        const pageData = Array.from({ length: 5 }, (_, idx) => ({ id: idx, title: `Card ${idx}` }));

        const list = new VirtualList(dom.root, {
            pageSize: 5,
            getPage: async (page) => {
                requestedPages.push(page);
                return page === 0 ? pageData : [];
            },
            getTemplate: (datum) => {
                const card = new MockElement('article');
                card.textContent = datum.title;
                return card;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
        });

        list.render();

        // Sentinels are registered synchronously before any timer ticks
        assert.deepEqual(
            dom.observedTargets.map((el) => el.id),
            ['top-observer', 'bottom-observer']
        );

        // Flush microtasks for immediate initial intersection handling
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(requestedPages, [0]);
        assert.equal(list.pool.length, 5);
        assert.equal(dom.elementsById.get('virtual-list').children.length, 5);
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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'sync-observer-test-'));
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
            '--window-size=1280,800',
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
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }

    return { send, evaluate, cleanup };
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await evaluate(`Boolean(${predicateExpr})`);
        if (ok) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for condition: ${predicateExpr}`);
}

const chromeBin = findChromeBinary();

describe('Browser E2E verification with real W3C IntersectionObserver', { skip: !chromeBin }, () => {
    it('synchronously registers sentinels and triggers immediate mount intersections in 5-2 and 5-6', async (t) => {
        const { server, baseUrl } = await startStaticServer(REPO_ROOT);
        t.after(() => server.close());

        const chrome = await launchHeadlessChrome(chromeBin);
        t.after(async () => {
            await chrome.cleanup();
        });

        await chrome.send('Page.enable');
        await chrome.send('Runtime.enable');

        await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `
                (() => {
                    const NativeIO = window.IntersectionObserver;
                    window.__ioTrace = {
                        constructed: 0,
                        observedIds: [],
                        intersectedIds: [],
                        setTimeoutRegistered: false,
                    };
                    const nativeSetTimeout = window.setTimeout;
                    window.setTimeout = function (fn, delay, ...rest) {
                        if (String(fn).includes('observe')) {
                            window.__ioTrace.setTimeoutRegistered = true;
                        }
                        return nativeSetTimeout.call(this, fn, delay, ...rest);
                    };
                    window.IntersectionObserver = class extends NativeIO {
                        constructor(callback, options) {
                            super((entries, obs) => {
                                for (const entry of entries) {
                                    if (entry.isIntersecting && entry.target?.id) {
                                        window.__ioTrace.intersectedIds.push(entry.target.id);
                                    }
                                }
                                callback(entries, obs);
                            }, options);
                            window.__ioTrace.constructed += 1;
                        }
                        observe(target) {
                            window.__ioTrace.observedIds.push(target?.id || target?.tagName || null);
                            return super.observe(target);
                        }
                    };
                })();
            `,
        });

        // 1. Verify 5-2-observer-handling/end/index.html
        await chrome.send('Page.navigate', {
            url: `${baseUrl}/5-virtualisation/5-2-observer-handling/end/index.html`,
        });
        await waitForCondition(chrome.evaluate, `window.__ioTrace.intersectedIds.length >= 2`);

        const trace52 = await chrome.evaluate(`window.__ioTrace`);
        assert.equal(trace52.constructed, 1);
        assert.equal(trace52.setTimeoutRegistered, false);
        assert.deepEqual(trace52.observedIds, ['bottom-observer', 'top-observer']);
        assert.ok(trace52.intersectedIds.includes('bottom-observer'));
        assert.ok(trace52.intersectedIds.includes('top-observer'));

        // Also test single element, null sentinel array, and <select> directly in real browser DOM
        const browserDirectCheck = await chrome.evaluate(`
            (async () => {
                const { intersectionObserver } = await import('/utils/observer.js');
                const singleDiv = document.createElement('div');
                singleDiv.id = 'single-sentinel';
                const selectEl = document.createElement('select');
                selectEl.id = 'select-sentinel';
                selectEl.appendChild(document.createElement('option'));

                const beforeCount = window.__ioTrace.observedIds.length;
                const obs1 = intersectionObserver(singleDiv, () => {});
                const obs2 = intersectionObserver([null, selectEl, undefined, document.createTextNode('skip')], () => {});
                const obs3 = intersectionObserver([], () => {});

                return {
                    allInstancesValid:
                        obs1 instanceof IntersectionObserver &&
                        obs2 instanceof IntersectionObserver &&
                        obs3 instanceof IntersectionObserver,
                    newlyObserved: window.__ioTrace.observedIds.slice(beforeCount),
                };
            })()
        `);
        assert.equal(browserDirectCheck.allInstancesValid, true);
        assert.deepEqual(browserDirectCheck.newlyObserved, ['single-sentinel', 'select-sentinel']);

        // 2. Verify 5-6-scroll-preservation/end/index.html
        await chrome.send('Page.navigate', {
            url: `${baseUrl}/5-virtualisation/5-6-scroll-preservation/end/index.html`,
        });
        await waitForCondition(
            chrome.evaluate,
            `document.querySelectorAll('#virtual-list .card').length === 10`
        );

        const trace56 = await chrome.evaluate(`({
            trace: window.__ioTrace,
            cardCount: document.querySelectorAll('#virtual-list .card').length,
        })`);
        assert.equal(trace56.trace.constructed, 1);
        assert.equal(trace56.trace.setTimeoutRegistered, false);
        assert.deepEqual(trace56.trace.observedIds, ['top-observer', 'bottom-observer']);
        assert.equal(trace56.cardCount, 10);
    });
});
