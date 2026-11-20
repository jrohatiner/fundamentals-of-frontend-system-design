import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'resize-observer-test-'));

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
        { detached: true, stdio: ['ignore', 'ignore', 'pipe'] }
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

        proc.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        proc.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Chrome exited prematurely with code ${code}. Stderr: ${stderr}`));
        });
    });

    const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find((t) => t.type === 'page');
    assert.ok(pageTarget?.webSocketDebuggerUrl, 'Expected a debuggable page target in headless Chrome');

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });

    let nextCommandId = 0;
    const pending = new Map();
    const exceptions = [];

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Runtime.exceptionThrown') {
            exceptions.push(msg.params.exceptionDetails);
        }
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) {
                reject(new Error(`CDP ${msg.error.message}`));
            } else {
                resolve(msg.result);
            }
        }
    });

    function send(method, params = {}) {
        const id = ++nextCommandId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async function evaluate(expression) {
        const res = await send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            throw new Error(
                `Page evaluation failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`
            );
        }
        return res.result.value;
    }

    async function close() {
        try {
            ws.close();
        } catch {}
        if (proc.exitCode === null) {
            try {
                process.kill(-proc.pid, 'SIGKILL');
            } catch {
                proc.kill('SIGKILL');
            }
            await new Promise((resolve) => proc.once('exit', resolve));
        }
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    return { send, evaluate, exceptions, close };
}

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await evaluate(`Boolean(${predicateExpr})`);
        if (ok) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for condition: ${predicateExpr}`);
}

const INSTRUMENTATION_SCRIPT = `
(() => {
    window.__roStats = {
        instances: 0,
        observeCalls: [],
        deliveries: [],
        consoleLogs: 0,
        errors: [],
        styleWrites: { A: { borderRadius: 0, borderWidth: 0 }, B: { borderRadius: 0, borderWidth: 0 }, C: { borderRadius: 0, borderWidth: 0 }, D: { borderRadius: 0, borderWidth: 0 } },
        datasetWrites: { A: 0, B: 0, C: 0, D: 0 },
    };

    window.addEventListener('error', (event) => {
        window.__roStats.errors.push(event.message);
    });

    const origLog = console.log;
    console.log = function (...args) {
        window.__roStats.consoleLogs += 1;
        return origLog.apply(this, args);
    };

    function instrumentBoxStyles(el) {
        if (el.__styleInstrumented) return;
        el.__styleInstrumented = true;
        const label = el.textContent.trim();
        const nativeStyle = el.style;
        const styleProxy = new Proxy(nativeStyle, {
            get(target, prop) {
                const value = Reflect.get(target, prop, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, prop, value) {
                if (prop === 'borderRadius' || prop === 'borderWidth') {
                    window.__roStats.styleWrites[label][prop] += 1;
                }
                return Reflect.set(target, prop, value, target);
            },
        });
        Object.defineProperty(el, 'style', {
            configurable: true,
            get() {
                return styleProxy;
            },
        });

        const attrObserver = new MutationObserver((records) => {
            for (const rec of records) {
                if (rec.attributeName === 'data-small') {
                    window.__roStats.datasetWrites[label] += 1;
                }
            }
        });
        attrObserver.observe(el, { attributes: true, attributeFilter: ['data-small'] });
    }

    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class InstrumentedResizeObserver extends NativeResizeObserver {
        constructor(callback) {
            window.__roStats.instances += 1;
            super((entries, observer) => {
                window.__roStats.deliveries.push(
                    entries.map((entry) => ({
                        box: entry.target.textContent.trim(),
                        inlineSize: entry.borderBoxSize[0].inlineSize,
                        blockSize: entry.borderBoxSize[0].blockSize,
                    }))
                );
                return callback(entries, observer);
            });
        }

        observe(target, options) {
            instrumentBoxStyles(target);
            window.__roStats.observeCalls.push({
                box: target.textContent.trim(),
                options: options ?? null,
            });
            return super.observe(target, options);
        }
    };
})();
`;

async function settleFrames(evaluate, frames = 4) {
    await evaluate(`new Promise((resolve) => {
        let remaining = ${frames};
        function tick() {
            if (--remaining <= 0) resolve();
            else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    })`);
}

test('ResizeObserver guards threshold state, avoids secondary loops, and eliminates console logging', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    const chrome = await launchHeadlessChrome();

    t.after(async () => {
        await chrome.close();
        await new Promise((resolve) => server.close(resolve));
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION_SCRIPT });

    await chrome.send('Page.navigate', { url: `${baseUrl}/4-resize-observer/end/index.html` });
    await settleFrames(chrome.evaluate, 5);

    // 1. Verify initial render (>= 150px)
    const initial = await chrome.evaluate(`(() => {
        const boxes = [...document.querySelectorAll('.box')].map((el) => ({
            label: el.textContent.trim(),
            small: el.dataset.small,
            borderRadius: el.style.borderRadius,
            borderWidth: el.style.borderWidth,
            computedBorderWidth: getComputedStyle(el).borderTopWidth,
        }));
        return { stats: window.__roStats, boxes };
    })()`);

    assert.equal(initial.stats.instances, 1, 'Expected a single ResizeObserver instance');
    assert.equal(initial.stats.observeCalls.length, 4, 'Expected all 4 .box elements to be observed');
    for (const call of initial.stats.observeCalls) {
        assert.deepEqual(call.options, { box: 'border-box' }, 'Expected border-box observation');
    }
    assert.equal(initial.stats.deliveries.length, 1, 'Expected exactly 1 initial ResizeObserver delivery batch');
    assert.equal(initial.stats.consoleLogs, 0, 'Expected zero console.log calls');
    assert.deepEqual(initial.stats.errors, [], 'Expected zero ResizeObserver loop errors');

    for (const box of initial.boxes) {
        assert.equal(box.small, 'false', `Expected initial data-small="false" on box ${box.label}`);
        assert.equal(box.borderRadius, '', `Expected initial inline borderRadius to remain unset on box ${box.label}`);
        assert.equal(box.borderWidth, '', `Expected initial inline borderWidth to remain unset on box ${box.label}`);
        assert.equal(box.computedBorderWidth, '2px', `Expected initial 2px CSS border preserved on box ${box.label}`);
        assert.deepEqual(
            initial.stats.styleWrites[box.label],
            { borderRadius: 0, borderWidth: 0 },
            `Expected zero style mutations on initial >=150px render for box ${box.label}`
        );
    }

    // Helper to resize Box A and return deltas
    async function resizeBox(index, widthPx, heightPx) {
        await chrome.evaluate(`(() => {
            window.__roStats.deliveries = [];
            const box = document.querySelectorAll('.box')[${index}];
            box.style.width = '${widthPx}px';
            box.style.height = '${heightPx}px';
        })()`);
        await settleFrames(chrome.evaluate, 4);
        return chrome.evaluate(`(() => {
            const box = document.querySelectorAll('.box')[${index}];
            return {
                deliveries: window.__roStats.deliveries,
                consoleLogs: window.__roStats.consoleLogs,
                errors: window.__roStats.errors,
                styleWrites: window.__roStats.styleWrites,
                datasetWrites: window.__roStats.datasetWrites,
                small: box.dataset.small,
                borderRadius: box.style.borderRadius,
                borderWidth: box.style.borderWidth,
                computedBorderWidth: getComputedStyle(box).borderTopWidth,
            };
        })()`);
    }

    // 2. Resize above threshold, asymmetric single-axis <150px, and exact 150x150 boundary
    for (const [w, h] of [
        [260, 180],
        [200, 160],
        [140, 160], // inlineSize < 150, blockSize >= 150 -> still not small
        [160, 140], // inlineSize >= 150, blockSize < 150 -> still not small
        [150, 150], // exact 150px boundary -> leaves styles unset
    ]) {
        const res = await resizeBox(0, w, h);
        assert.equal(res.deliveries.length, 1, `Expected 1 ResizeObserver delivery at ${w}x${h}`);
        assert.equal(res.small, 'false', `Expected data-small="false" at ${w}x${h}`);
        assert.equal(res.borderRadius, '', `Expected inline borderRadius left unset at ${w}x${h}`);
        assert.equal(res.borderWidth, '', `Expected inline borderWidth left unset at ${w}x${h}`);
        assert.deepEqual(res.styleWrites.A, { borderRadius: 0, borderWidth: 0 }, `Expected zero style writes at ${w}x${h}`);
        assert.equal(res.datasetWrites.A, 1, `Expected zero redundant data-small writes at ${w}x${h}`);
        assert.equal(res.consoleLogs, 0);
        assert.deepEqual(res.errors, []);
    }

    // 3. Cross below 150px threshold (149x149) -> mutates style once, zero secondary loop deliveries
    const crossedSmall = await resizeBox(0, 149, 149);
    assert.equal(crossedSmall.deliveries.length, 1, 'Expected zero secondary loop deliveries when crossing below 150px');
    assert.equal(crossedSmall.small, 'true');
    assert.equal(crossedSmall.borderRadius, '100%');
    assert.equal(crossedSmall.borderWidth, '4px');
    assert.equal(crossedSmall.computedBorderWidth, '4px');
    assert.deepEqual(crossedSmall.styleWrites.A, { borderRadius: 1, borderWidth: 1 });
    assert.equal(crossedSmall.datasetWrites.A, 2);
    assert.deepEqual(crossedSmall.errors, []);

    // 4. Resize repeatedly while remaining below 150px -> zero additional style or dataset writes
    for (const [w, h] of [
        [130, 130],
        [115, 115],
        [100, 100],
    ]) {
        const res = await resizeBox(0, w, h);
        assert.equal(res.deliveries.length, 1, `Expected 1 delivery at ${w}x${h}`);
        assert.equal(res.small, 'true');
        assert.equal(res.borderRadius, '100%');
        assert.equal(res.borderWidth, '4px');
        assert.deepEqual(res.styleWrites.A, { borderRadius: 1, borderWidth: 1 }, `Expected no extra style writes at ${w}x${h}`);
        assert.equal(res.datasetWrites.A, 2, `Expected no extra data-small writes at ${w}x${h}`);
        assert.deepEqual(res.errors, []);
    }

    // 5. Cross back to exact 150x150 boundary -> unsets styles once, zero secondary loop deliveries
    const crossedExact150 = await resizeBox(0, 150, 150);
    assert.equal(crossedExact150.deliveries.length, 1, 'Expected zero secondary loop deliveries when crossing to 150x150');
    assert.equal(crossedExact150.small, 'false');
    assert.equal(crossedExact150.borderRadius, 'unset');
    assert.equal(crossedExact150.borderWidth, 'unset');
    assert.deepEqual(crossedExact150.styleWrites.A, { borderRadius: 2, borderWidth: 2 });
    assert.equal(crossedExact150.datasetWrites.A, 3);
    assert.deepEqual(crossedExact150.errors, []);

    // 6. Resize further above 150px -> zero additional style writes, and independent state on Box B
    const stayLarge = await resizeBox(0, 200, 190);
    assert.deepEqual(stayLarge.styleWrites.A, { borderRadius: 2, borderWidth: 2 });
    assert.equal(stayLarge.datasetWrites.A, 3);

    const boxBSmall = await resizeBox(1, 120, 120);
    assert.equal(boxBSmall.small, 'true');
    assert.equal(boxBSmall.borderRadius, '100%');
    assert.equal(boxBSmall.borderWidth, '4px');
    assert.deepEqual(boxBSmall.styleWrites.B, { borderRadius: 1, borderWidth: 1 });
    assert.deepEqual(boxBSmall.styleWrites.A, { borderRadius: 2, borderWidth: 2 });
    assert.equal(boxBSmall.consoleLogs, 0);
    assert.deepEqual(boxBSmall.errors, []);
});

test('Elements initializing below 150px or at exact 150px on first render handle styles cleanly', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    const chrome = await launchHeadlessChrome();

    t.after(async () => {
        await chrome.close();
        await new Promise((resolve) => server.close(resolve));
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
            ${INSTRUMENTATION_SCRIPT}
            document.addEventListener('DOMContentLoaded', () => {
                const boxes = document.querySelectorAll('.box');
                // Box A starts below 150px on first render
                boxes[0].style.width = '120px';
                boxes[0].style.height = '120px';
                // Box B starts at exact 150x150 on first render
                boxes[1].style.width = '150px';
                boxes[1].style.height = '150px';
            }, { capture: true });
        `,
    });

    await chrome.send('Page.navigate', { url: `${baseUrl}/4-resize-observer/end/index.html` });
    await settleFrames(chrome.evaluate, 5);

    const firstRender = await chrome.evaluate(`(() => {
        const boxes = [...document.querySelectorAll('.box')].map((el) => ({
            label: el.textContent.trim(),
            small: el.dataset.small,
            borderRadius: el.style.borderRadius,
            borderWidth: el.style.borderWidth,
            computedBorderWidth: getComputedStyle(el).borderTopWidth,
        }));
        return { stats: window.__roStats, boxes };
    })()`);

    assert.equal(firstRender.stats.deliveries.length, 1, 'Expected single initial notification batch even when Box A starts < 150px');
    assert.equal(firstRender.stats.consoleLogs, 0);
    assert.deepEqual(firstRender.stats.errors, []);

    // Box A initialized at 120x120 -> small styles applied on first notification
    assert.equal(firstRender.boxes[0].small, 'true');
    assert.equal(firstRender.boxes[0].borderRadius, '100%');
    assert.equal(firstRender.boxes[0].borderWidth, '4px');
    assert.equal(firstRender.boxes[0].computedBorderWidth, '4px');
    assert.deepEqual(firstRender.stats.styleWrites.A, { borderRadius: 1, borderWidth: 1 });

    // Box B initialized at exact 150x150 -> styles left unset
    assert.equal(firstRender.boxes[1].small, 'false');
    assert.equal(firstRender.boxes[1].borderRadius, '');
    assert.equal(firstRender.boxes[1].borderWidth, '');
    assert.equal(firstRender.boxes[1].computedBorderWidth, '2px');
    assert.deepEqual(firstRender.stats.styleWrites.B, { borderRadius: 0, borderWidth: 0 });
});

test('ResizeObserver callback handles borderBoxSize arrays, single objects, and contentRect fallbacks', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    const chrome = await launchHeadlessChrome();

    t.after(async () => {
        await chrome.close();
        await new Promise((resolve) => server.close(resolve));
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');

    await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
            (() => {
                const NativeResizeObserver = window.ResizeObserver;
                window.__resizeObserverStats = {
                    instances: 0,
                    observedCount: 0,
                    callback: null,
                    instance: null,
                };

                window.ResizeObserver = class extends NativeResizeObserver {
                    constructor(callback) {
                        super(callback);
                        window.__resizeObserverStats.instances += 1;
                        window.__resizeObserverStats.callback = callback;
                        window.__resizeObserverStats.instance = this;
                    }
                    observe(target, options) {
                        window.__resizeObserverStats.observedCount += 1;
                        return super.observe(target, options);
                    }
                };
            })();
        `,
    });

    await chrome.send('Page.navigate', {
        url: `${baseUrl}/4-resize-observer/end/index.html`,
    });

    await waitForCondition(
        chrome.evaluate,
        `window.__resizeObserverStats.observedCount === 4 && document.querySelectorAll('.box')[0].dataset.small === 'false'`
    );

    const observerMeta = await chrome.evaluate(`({
        instances: window.__resizeObserverStats.instances,
        observedCount: window.__resizeObserverStats.observedCount,
        initialBoxes: Array.from(document.querySelectorAll('.box')).map((el) => ({
            small: el.dataset.small,
            borderRadius: el.style.borderRadius,
            borderWidth: el.style.borderWidth,
        })),
    })`);

    assert.equal(observerMeta.instances, 1, 'Expected a single shared ResizeObserver instance');
    assert.equal(observerMeta.observedCount, 4, 'Expected all 4 .box elements to be observed');
    assert.deepEqual(observerMeta.initialBoxes, [
        { small: 'false', borderRadius: '', borderWidth: '' },
        { small: 'false', borderRadius: '', borderWidth: '' },
        { small: 'false', borderRadius: '', borderWidth: '' },
        { small: 'false', borderRadius: '', borderWidth: '' },
    ]);

    // 1. Verify real native ResizeObserver reaction when resizing a .box element in the DOM.
    await chrome.evaluate(`
        (() => {
            const box0 = document.querySelectorAll('.box')[0];
            box0.style.width = '120px';
            box0.style.height = '120px';
        })();
    `);
    await waitForCondition(
        chrome.evaluate,
        `document.querySelectorAll('.box')[0].style.borderRadius === '100%'`
    );

    const resizedSmallStyle = await chrome.evaluate(`({
        small: document.querySelectorAll('.box')[0].dataset.small,
        borderRadius: document.querySelectorAll('.box')[0].style.borderRadius,
        borderWidth: document.querySelectorAll('.box')[0].style.borderWidth,
    })`);
    assert.deepEqual(resizedSmallStyle, {
        small: 'true',
        borderRadius: '100%',
        borderWidth: '4px',
    });

    await chrome.evaluate(`
        (() => {
            const box0 = document.querySelectorAll('.box')[0];
            box0.style.width = '180px';
            box0.style.height = '180px';
        })();
    `);
    await waitForCondition(
        chrome.evaluate,
        `document.querySelectorAll('.box')[0].style.borderRadius === 'unset'`
    );

    // 2. Verify simulated ResizeObserverEntry payloads directly against the registered callback.
    const simulatedResults = await chrome.evaluate(`
        (() => {
            const { callback, instance } = window.__resizeObserverStats;
            const boxes = Array.from(document.querySelectorAll('.box'));
            // Disconnect native observer so synthetic style assertions aren't overwritten asynchronously.
            instance.disconnect();

            const runCase = (entry) => {
                callback([entry], instance);
                return {
                    small: entry.target.dataset.small,
                    borderRadius: entry.target.style.borderRadius,
                    borderWidth: entry.target.style.borderWidth,
                };
            };

            const results = {
                // Standard W3C borderBoxSize array sequence
                arrayBelowThreshold: runCase({
                    target: boxes[0],
                    borderBoxSize: [{ inlineSize: 149, blockSize: 149 }],
                    contentRect: { width: 145, height: 145 },
                }),
                arrayAtThreshold: runCase({
                    target: boxes[0],
                    borderBoxSize: [{ inlineSize: 150, blockSize: 149 }],
                    contentRect: { width: 146, height: 145 },
                }),
                arrayZeroDimensions: runCase({
                    target: boxes[0],
                    borderBoxSize: [{ inlineSize: 0, blockSize: 0 }],
                    contentRect: { width: 200, height: 200 },
                }),
                arrayAboveThreshold: runCase({
                    target: boxes[0],
                    borderBoxSize: [{ inlineSize: 200, blockSize: 200 }],
                    contentRect: { width: 196, height: 196 },
                }),

                // Legacy single-object borderBoxSize (e.g., Firefox 69-91 / early spec drafts)
                objectBelowThreshold: runCase({
                    target: boxes[1],
                    borderBoxSize: { inlineSize: 120, blockSize: 135 },
                    contentRect: { width: 116, height: 131 },
                }),
                objectOneAxisAbove: runCase({
                    target: boxes[1],
                    borderBoxSize: { inlineSize: 120, blockSize: 150 },
                    contentRect: { width: 116, height: 146 },
                }),

                // Legacy contentRect-only payloads (e.g., Safari < 15.4 / polyfills)
                contentRectOnlySmall: runCase({
                    target: boxes[2],
                    contentRect: { width: 140, height: 140 },
                }),
                contentRectOnlyAtThreshold: runCase({
                    target: boxes[2],
                    borderBoxSize: undefined,
                    contentRect: { width: 150, height: 150 },
                }),
                nullBorderBoxSizeSmall: runCase({
                    target: boxes[2],
                    borderBoxSize: null,
                    contentRect: { width: 146, height: 146 },
                }),
                emptyArrayBorderBoxSizeSmall: runCase({
                    target: boxes[3],
                    borderBoxSize: [],
                    contentRect: { width: 125, height: 125 },
                }),
                emptyArrayBorderBoxSizeLarge: runCase({
                    target: boxes[3],
                    borderBoxSize: [],
                    contentRect: { width: 165, height: 165 },
                }),
            };

            // Prime opposite states so every entry in the mixed batch actively transitions
            boxes[0].dataset.small = 'false';
            boxes[0].style.borderRadius = 'unset';
            boxes[0].style.borderWidth = 'unset';
            boxes[1].dataset.small = 'true';
            boxes[1].style.borderRadius = '100%';
            boxes[1].style.borderWidth = '4px';
            boxes[2].dataset.small = 'false';
            boxes[2].style.borderRadius = 'unset';
            boxes[2].style.borderWidth = 'unset';
            boxes[3].dataset.small = 'true';
            boxes[3].style.borderRadius = '100%';
            boxes[3].style.borderWidth = '4px';

            // Multi-entry mixed payload batch in a single callback invocation
            callback(
                [
                    { target: boxes[0], borderBoxSize: [{ inlineSize: 110, blockSize: 110 }] },
                    { target: boxes[1], borderBoxSize: { inlineSize: 180, blockSize: 180 } },
                    { target: boxes[2], contentRect: { width: 115, height: 115 } },
                    { target: boxes[3], contentRect: { width: 175, height: 175 } },
                ],
                instance
            );

            results.mixedBatch = boxes.map((el) => ({
                small: el.dataset.small,
                borderRadius: el.style.borderRadius,
                borderWidth: el.style.borderWidth,
            }));

            return results;
        })()
    `);

    const CIRCLE = { small: 'true', borderRadius: '100%', borderWidth: '4px' };
    const UNSET = { small: 'false', borderRadius: 'unset', borderWidth: 'unset' };

    assert.deepEqual(simulatedResults.arrayBelowThreshold, CIRCLE);
    assert.deepEqual(simulatedResults.arrayAtThreshold, UNSET);
    assert.deepEqual(simulatedResults.arrayZeroDimensions, CIRCLE);
    assert.deepEqual(simulatedResults.arrayAboveThreshold, UNSET);

    assert.deepEqual(simulatedResults.objectBelowThreshold, CIRCLE);
    assert.deepEqual(simulatedResults.objectOneAxisAbove, UNSET);

    assert.deepEqual(simulatedResults.contentRectOnlySmall, CIRCLE);
    assert.deepEqual(simulatedResults.contentRectOnlyAtThreshold, UNSET);
    assert.deepEqual(simulatedResults.nullBorderBoxSizeSmall, CIRCLE);
    assert.deepEqual(simulatedResults.emptyArrayBorderBoxSizeSmall, CIRCLE);
    assert.deepEqual(simulatedResults.emptyArrayBorderBoxSizeLarge, UNSET);

    assert.deepEqual(simulatedResults.mixedBatch, [CIRCLE, UNSET, CIRCLE, UNSET]);
    assert.equal(chrome.exceptions.length, 0, 'Expected zero uncaught runtime exceptions');
});

test('ResizeObserver works end-to-end when engine omits borderBoxSize (Safari < 15.4 / polyfill) or exposes single object', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    for (const mode of ['contentRect-only', 'single-object']) {
        const chrome = await launchHeadlessChrome();
        try {
            await chrome.send('Page.enable');
            await chrome.send('Runtime.enable');

            await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
                source: `
                    (() => {
                        const mode = ${JSON.stringify(mode)};
                        const NativeResizeObserver = window.ResizeObserver;
                        window.ResizeObserver = class extends NativeResizeObserver {
                            constructor(callback) {
                                super((entries, observer) => {
                                    const legacyEntries = entries.map((entry) => {
                                        if (mode === 'contentRect-only') {
                                            return {
                                                target: entry.target,
                                                contentRect: entry.contentRect,
                                            };
                                        }
                                        return {
                                            target: entry.target,
                                            borderBoxSize: entry.borderBoxSize[0],
                                            contentRect: entry.contentRect,
                                        };
                                    });
                                    callback(legacyEntries, observer);
                                });
                            }
                        };
                    })();
                `,
            });

            await chrome.send('Page.navigate', {
                url: `${baseUrl}/4-resize-observer/end/index.html`,
            });

            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('.box')[0].dataset.small === 'false'`
            );

            await chrome.evaluate(`
                (() => {
                    const box = document.querySelectorAll('.box')[0];
                    box.style.width = '120px';
                    box.style.height = '120px';
                })();
            `);

            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('.box')[0].style.borderRadius === '100%'`
            );

            const boxStylesAfterShrink = await chrome.evaluate(`
                Array.from(document.querySelectorAll('.box')).map((el) => ({
                    small: el.dataset.small,
                    borderRadius: el.style.borderRadius,
                    borderWidth: el.style.borderWidth,
                }))
            `);

            assert.deepEqual(boxStylesAfterShrink, [
                { small: 'true', borderRadius: '100%', borderWidth: '4px' },
                { small: 'false', borderRadius: '', borderWidth: '' },
                { small: 'false', borderRadius: '', borderWidth: '' },
                { small: 'false', borderRadius: '', borderWidth: '' },
            ]);

            await chrome.evaluate(`
                (() => {
                    const box = document.querySelectorAll('.box')[0];
                    box.style.width = '180px';
                    box.style.height = '180px';
                })();
            `);

            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('.box')[0].style.borderRadius === 'unset'`
            );

            const box0AfterEnlarge = await chrome.evaluate(`({
                small: document.querySelectorAll('.box')[0].dataset.small,
                borderRadius: document.querySelectorAll('.box')[0].style.borderRadius,
                borderWidth: document.querySelectorAll('.box')[0].style.borderWidth,
            })`);

            assert.deepEqual(box0AfterEnlarge, {
                small: 'false',
                borderRadius: 'unset',
                borderWidth: 'unset',
            });
            assert.equal(chrome.exceptions.length, 0, `Expected zero runtime exceptions in ${mode} mode`);
        } finally {
            await chrome.close();
        }
    }
});
