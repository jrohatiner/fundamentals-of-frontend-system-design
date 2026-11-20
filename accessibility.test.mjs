import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function findChromeBinary() {
    const candidates = [
        process.env.CHROME_BIN,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('Could not find a Chrome/Chromium binary. Set CHROME_BIN to its path.');
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

async function launchHeadlessChrome() {
    const chromeBin = findChromeBinary();
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'a11y-observer-test-'));

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
                response.exceptionDetails.exception?.description ??
                    response.exceptionDetails.text
            );
        }
        return response.result.value;
    }

    async function cleanup() {
        try {
            await send('Browser.close');
        } catch {}
        try {
            ws.close();
        } catch {}
        if (proc.exitCode === null) {
            proc.kill('SIGTERM');
            await Promise.race([
                new Promise((resolve) => proc.once('close', resolve)),
                new Promise((resolve) =>
                    setTimeout(() => {
                        if (proc.exitCode === null) {
                            proc.kill('SIGKILL');
                        }
                        resolve();
                    }, 1000)
                ),
            ]);
        }
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                rmSync(userDataDir, { recursive: true, force: true });
                break;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
    }

    return { send, evaluate, cleanup };
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 8_000) {
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

function getAXProp(node, propName) {
    return node.properties?.find((p) => p.name === propName)?.value?.value ?? null;
}

async function assertSentinelsHiddenAndStatusLiveInAXTree(chrome, sentinelIds) {
    const { nodes } = await chrome.send('Accessibility.getFullAXTree');

    // No unignored AX node may expose raw sentinel strings
    const unignoredSentinelStrings = nodes.filter(
        (node) =>
            !node.ignored &&
            (node.name?.value === 'Bottom Observer' ||
                node.name?.value === 'Top Observer' ||
                node.name?.value === 'Loading')
    );
    assert.equal(
        unignoredSentinelStrings.length,
        0,
        `Expected zero unignored AX nodes exposing raw sentinel strings, found: ${JSON.stringify(unignoredSentinelStrings)}`
    );

    // Every sentinel element must have aria-hidden="true" and remain visible for IntersectionObserver
    for (const id of sentinelIds) {
        const sentinelCheck = await chrome.evaluate(`
            (() => {
                const el = document.getElementById(${JSON.stringify(id)});
                const rect = el?.getBoundingClientRect();
                return {
                    exists: Boolean(el),
                    ariaHidden: el?.getAttribute('aria-hidden'),
                    height: rect?.height ?? 0,
                };
            })()
        `);
        assert.equal(sentinelCheck.exists, true, `Expected #${id} to exist`);
        assert.equal(sentinelCheck.ariaHidden, 'true', `Expected #${id} to have aria-hidden="true"`);
        assert.equal(sentinelCheck.height, 100, `Expected #${id} to preserve 100px visual sentinel height`);
    }

    // Status live region must be exposed in AXTree with role="status" and live="polite"
    const statusNodes = nodes.filter((node) => !node.ignored && node.role?.value === 'status');
    assert.equal(statusNodes.length, 1, 'Expected exactly one unignored status live region in AXTree');
    assert.equal(getAXProp(statusNodes[0], 'live'), 'polite', 'Expected status region to have aria-live="polite"');

    // Verify .sr-only styling keeps dimensions 1x1 out-of-flow without trapping keyboard focus
    const srOnlyStyle = await chrome.evaluate(`
        (() => {
            const status = document.querySelector('#container .sr-only[role="status"][aria-live="polite"]');
            if (!status) return null;
            const cs = getComputedStyle(status);
            return {
                position: cs.position,
                width: cs.width,
                height: cs.height,
                overflow: cs.overflow,
                tabIndex: status.tabIndex,
            };
        })()
    `);
    assert.deepEqual(srOnlyStyle, {
        position: 'absolute',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
        tabIndex: -1,
    });
}

test('hides sentinels from assistive technology trees and announces feed pagination via polite live region across modules 2, 3, and 5', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(() => server.close());

    const chrome = await launchHeadlessChrome();
    t.after(async () => {
        await chrome.cleanup();
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');
    await chrome.send('Accessibility.enable');

    // Record every status mutation inside #container [role="status"] in real time
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
            (() => {
                window.__statusHistory = [];
                const recordStatus = (text) => {
                    window.__statusHistory.push(text);
                };
                const attach = () => {
                    const statusEl = document.querySelector('#container [role="status"]');
                    if (!statusEl || statusEl.__watched) return;
                    statusEl.__watched = true;
                    if (statusEl.textContent) {
                        recordStatus(statusEl.textContent);
                    }
                    new MutationObserver(() => {
                        recordStatus(statusEl.textContent);
                    }).observe(statusEl, { childList: true, characterData: true, subtree: true });
                };
                document.addEventListener('DOMContentLoaded', attach);
                new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
            })();
        `,
    });

    // 1. Verify Module 2: Intersection Observer
    await chrome.send('Page.navigate', {
        url: `${baseUrl}/2-intersection-observer/end/index.html`,
    });

    await waitForCondition(
        chrome.evaluate,
        `document.querySelector('#container [role="status"]')?.textContent === 'Loading more items...'`
    );
    await assertSentinelsHiddenAndStatusLiveInAXTree(chrome, ['bottom-observer']);

    await waitForCondition(
        chrome.evaluate,
        `document.querySelectorAll('#list .card').length === 10`
    );
    assert.equal(
        await chrome.evaluate(`document.querySelector('#container [role="status"]').textContent`),
        'Loaded 10 items.'
    );
    await waitForCondition(
        chrome.evaluate,
        `document.querySelector('#container [role="status"]').textContent === ''`
    );
    assert.deepEqual(await chrome.evaluate(`window.__statusHistory`), [
        'Loading more items...',
        'Loaded 10 items.',
        '',
    ]);

    // Scroll through remaining pages 1..9 (up to 100 cards) and verify exhaustion handling
    for (let pageIdx = 1; pageIdx < 10; pageIdx++) {
        const expectedCount = (pageIdx + 1) * 10;
        await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
        await waitForCondition(
            chrome.evaluate,
            `document.querySelectorAll('#list .card').length === ${expectedCount}`
        );
    }
    await chrome.evaluate(`
        window.__statusHistory = [];
        document.getElementById('bottom-observer').scrollIntoView();
    `);
    await waitForCondition(
        chrome.evaluate,
        `document.getElementById('bottom-observer')?.textContent.trim() === 'No more items to load'`
    );
    assert.equal(
        await chrome.evaluate(`document.querySelector('#container [role="status"]').textContent`),
        'No more items to load.'
    );
    await assertSentinelsHiddenAndStatusLiveInAXTree(chrome, ['bottom-observer']);
    await waitForCondition(
        chrome.evaluate,
        `document.querySelector('#container [role="status"]').textContent === ''`
    );
    assert.deepEqual(await chrome.evaluate(`window.__statusHistory`), [
        'Loading more items...',
        'No more items to load.',
        '',
    ]);

    // 2. Verify Module 3: Mutation Observer
    await chrome.send('Page.navigate', {
        url: `${baseUrl}/3-mutation-observer/end/index.html`,
    });

    await waitForCondition(
        chrome.evaluate,
        `document.querySelector('#container [role="status"]')?.textContent === 'Loading more items...'`
    );
    // Even while #bottom-observer displays visual "Loading", AXTree must ignore it
    assert.equal(
        await chrome.evaluate(`document.getElementById('bottom-observer').textContent`),
        'Loading'
    );
    await assertSentinelsHiddenAndStatusLiveInAXTree(chrome, ['bottom-observer']);

    await waitForCondition(
        chrome.evaluate,
        `document.querySelectorAll('#list .card').length === 10`
    );
    assert.equal(
        await chrome.evaluate(`document.querySelector('#container [role="status"]').textContent`),
        'Loaded 10 items.'
    );
    assert.equal(
        await chrome.evaluate(`document.getElementById('bottom-observer').textContent`),
        'Bottom Observer'
    );
    await waitForCondition(
        chrome.evaluate,
        `document.querySelector('#container [role="status"]').textContent === ''`
    );

    // 3. Verify Module 5: VirtualList (5-6-scroll-preservation)
    await chrome.send('Page.navigate', {
        url: `${baseUrl}/5-virtualisation/5-6-scroll-preservation/end/index.html`,
    });

    await waitForCondition(
        chrome.evaluate,
        `document.getElementById('virtual-list-status')?.textContent === 'Loading more items...'`
    );
    await assertSentinelsHiddenAndStatusLiveInAXTree(chrome, ['top-observer', 'bottom-observer']);

    await waitForCondition(
        chrome.evaluate,
        `document.querySelectorAll('#virtual-list .card').length === 10`
    );
    assert.equal(
        await chrome.evaluate(`document.getElementById('virtual-list-status').textContent`),
        'Loaded 10 items.'
    );

    // Scroll down through two more pages to trigger element recycling, then scroll back up to trigger top-observer
    await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
    await waitForCondition(
        chrome.evaluate,
        `document.querySelectorAll('#virtual-list .card').length === 20`
    );

    await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
    await waitForCondition(
        chrome.evaluate,
        `document.querySelector('#virtual-list .card h3')?.textContent?.includes('[Entry 20]')`
    );

    await chrome.evaluate(`window.scrollTo(0, 0); document.getElementById('top-observer').scrollIntoView();`);
    await waitForCondition(
        chrome.evaluate,
        `document.getElementById('virtual-list-status').textContent === 'Loaded 10 previous items.'`
    );
    await waitForCondition(
        chrome.evaluate,
        `document.getElementById('virtual-list-status').textContent === ''`
    );
});

test('VirtualList clears loading message immediately on empty batches and handles overlapping loads', async () => {
    const { VirtualList } = await import('./5-virtualisation/5-6-scroll-preservation/end/virtual-list.js');

    const elementsById = new Map();
    let observerCallback = null;

    class SimpleElement {
        constructor(tagName, id = '') {
            this.tagName = tagName;
            this.id = id;
            this.children = [];
            this.attributes = new Map();
            this.style = {};
            this.textContent = '';
            this.scrollHeight = 1000;
        }
        setAttribute(k, v) {
            this.attributes.set(k, String(v));
        }
        getAttribute(k) {
            return this.attributes.get(k) ?? null;
        }
        appendChild(node) {
            if (node.children && node.isFragment) {
                this.children.push(...node.children);
                node.children = [];
            } else {
                this.children.push(node);
            }
            return node;
        }
        getBoundingClientRect() {
            return { height: 100 };
        }
    }

    const root = new SimpleElement('body');
    Object.defineProperty(root, 'innerHTML', {
        get() {
            return this._html ?? '';
        },
        set(html) {
            this._html = html;
            elementsById.clear();
            const container = new SimpleElement('div', 'container');
            const status = new SimpleElement('div', 'virtual-list-status');
            const top = new SimpleElement('div', 'top-observer');
            const list = new SimpleElement('main', 'virtual-list');
            const bottom = new SimpleElement('div', 'bottom-observer');
            elementsById.set('container', container);
            elementsById.set('virtual-list-status', status);
            elementsById.set('top-observer', top);
            elementsById.set('virtual-list', list);
            elementsById.set('bottom-observer', bottom);
        },
    });

    globalThis.document = {
        getElementById: (id) => elementsById.get(id) ?? null,
    };
    globalThis.DocumentFragment = class {
        constructor() {
            this.isFragment = true;
            this.children = [];
        }
        appendChild(node) {
            this.children.push(node);
            return node;
        }
    };
    globalThis.IntersectionObserver = class {
        constructor(cb) {
            observerCallback = cb;
        }
        observe() {}
    };

    let resolvers = [];
    const vl = new VirtualList(root, {
        pageSize: 2,
        getPage: () =>
            new Promise((resolve) => {
                resolvers.push(resolve);
            }),
        getTemplate: (d) => {
            const el = new SimpleElement('article');
            el.textContent = d.title;
            return el;
        },
        updateTemplate: (el, d) => {
            el.textContent = d.title;
        },
    });

    const html = vl.toHTML();
    assert.match(html, /id="virtual-list-status"[^>]*class="sr-only"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="top-observer"[^>]*aria-hidden="true"/);
    assert.match(html, /id="bottom-observer"[^>]*aria-hidden="true"/);

    vl.render();
    const status = elementsById.get('virtual-list-status');
    const bottom = elementsById.get('bottom-observer');

    // Trigger two rapid consecutive bottom intersections before first resolves
    observerCallback([{ isIntersecting: true, target: bottom }]);
    observerCallback([{ isIntersecting: true, target: bottom }]);
    assert.equal(status.textContent, 'Loading more items...');

    // First load finishes while second is still pending
    resolvers[0]([{ title: 'A' }, { title: 'B' }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(status.textContent, 'Loaded 2 items. Loading more items...');

    // Second load returns empty batch -> clears loading state cleanly
    resolvers[1]([]);
    await new Promise((r) => setImmediate(r));
    assert.equal(status.textContent, '');
});

