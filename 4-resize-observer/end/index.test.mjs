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
    const exceptions = [];

    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') {
            exceptions.push(message.params.exceptionDetails);
        }
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

    return { send, evaluate, exceptions, cleanup };
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

test('ResizeObserver callback handles borderBoxSize arrays, single objects, and contentRect fallbacks', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(() => server.close());

    const chrome = await launchHeadlessChrome();
    t.after(async () => {
        await chrome.cleanup();
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
        `window.__resizeObserverStats.observedCount === 4 && document.querySelectorAll('.box')[0].style.borderRadius === 'unset'`
    );

    const observerMeta = await chrome.evaluate(`({
        instances: window.__resizeObserverStats.instances,
        observedCount: window.__resizeObserverStats.observedCount,
        initialStyles: Array.from(document.querySelectorAll('.box')).map((el) => ({
            borderRadius: el.style.borderRadius,
            borderWidth: el.style.borderWidth,
        })),
    })`);

    assert.equal(observerMeta.instances, 1, 'Expected a single shared ResizeObserver instance');
    assert.equal(observerMeta.observedCount, 4, 'Expected all 4 .box elements to be observed');
    assert.deepEqual(observerMeta.initialStyles, [
        { borderRadius: 'unset', borderWidth: 'unset' },
        { borderRadius: 'unset', borderWidth: 'unset' },
        { borderRadius: 'unset', borderWidth: 'unset' },
        { borderRadius: 'unset', borderWidth: 'unset' },
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
        borderRadius: document.querySelectorAll('.box')[0].style.borderRadius,
        borderWidth: document.querySelectorAll('.box')[0].style.borderWidth,
    })`);
    assert.deepEqual(resizedSmallStyle, {
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
                borderRadius: el.style.borderRadius,
                borderWidth: el.style.borderWidth,
            }));

            return results;
        })()
    `);

    const CIRCLE = { borderRadius: '100%', borderWidth: '4px' };
    const UNSET = { borderRadius: 'unset', borderWidth: 'unset' };

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
    t.after(() => server.close());

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
                `document.querySelectorAll('.box')[0].style.borderRadius === 'unset'`
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

            const boxStyles = await chrome.evaluate(`
                Array.from(document.querySelectorAll('.box')).map((el) => ({
                    borderRadius: el.style.borderRadius,
                    borderWidth: el.style.borderWidth,
                }))
            `);

            assert.deepEqual(boxStyles, [
                { borderRadius: '100%', borderWidth: '4px' },
                { borderRadius: 'unset', borderWidth: 'unset' },
                { borderRadius: 'unset', borderWidth: 'unset' },
                { borderRadius: 'unset', borderWidth: 'unset' },
            ]);
            assert.equal(chrome.exceptions.length, 0, `Expected zero runtime exceptions in ${mode} mode`);
        } finally {
            await chrome.cleanup();
        }
    }
});

