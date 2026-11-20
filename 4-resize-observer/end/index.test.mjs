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

const KEY_CODES = {
    Tab: 9,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
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
            '--window-size=1280,900',
            '--remote-debugging-port=0',
            'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], detached: true }
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

    const targetsResponse = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await targetsResponse.json();
    const pageTarget = targets.find((target) => target.type === 'page');
    assert.ok(pageTarget?.webSocketDebuggerUrl, 'Expected a debuggable page target in headless Chrome');

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
                reject(new Error(`CDP ${message.error.message}`));
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
                `Page evaluation failed: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`
            );
        }
        return response.result.value;
    }

    async function pressKey(key, { shift = false } = {}) {
        const vk = KEY_CODES[key];
        assert.ok(vk, `Unsupported key: ${key}`);
        const modifiers = shift ? 8 : 0;
        await send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key,
            code: key,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers,
        });
        await send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code: key,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers,
        });
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
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }

    return { send, evaluate, pressKey, cleanup, close: cleanup };
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

async function waitForCondition(evaluate, predicateExpr, timeoutMs = 5_000) {
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

test('provides keyboard-operable sliders, direct box arrow-key resizing, visible focus indicators, and polite live status announcements', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(() => server.close());

    const chrome = await launchHeadlessChrome();
    t.after(async () => {
        await chrome.cleanup();
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');
    await chrome.send('Accessibility.enable');

    await chrome.send('Page.navigate', {
        url: `${baseUrl}/4-resize-observer/end/index.html`,
    });

    await waitForCondition(chrome.evaluate, `document.querySelectorAll('.box').length === 4`);

    // Verify native CSS resize: both is retained on all boxes and initial status region is quiet.
    const initialCheck = await chrome.evaluate(`
        (() => {
            const boxes = Array.from(document.querySelectorAll('.box'));
            const status = document.getElementById('resize-status');
            return {
                boxCount: boxes.length,
                allCssResizeBoth: boxes.every((b) => getComputedStyle(b).resize === 'both'),
                sliderCount: document.querySelectorAll('input[type="range"]').length,
                statusLive: status?.getAttribute('aria-live'),
                statusRole: status?.getAttribute('role'),
                initialStatusText: status?.textContent ?? null,
            };
        })()
    `);
    assert.deepEqual(initialCheck, {
        boxCount: 4,
        allCssResizeBoth: true,
        sliderCount: 8,
        statusLive: 'polite',
        statusRole: 'status',
        initialStatusText: '',
    });

    // Verify sequential Tab order visits all 4 boxes and all 8 range sliders with visible focus outlines and no keyboard traps.
    const expectedTabSequence = [
        'box-a',
        'box-a-width',
        'box-a-height',
        'box-b',
        'box-b-width',
        'box-b-height',
        'box-c',
        'box-c-width',
        'box-c-height',
        'box-d',
        'box-d-width',
        'box-d-height',
    ];

    const visitedIds = [];
    for (const expectedId of expectedTabSequence) {
        await chrome.pressKey('Tab');
        const activeInfo = await chrome.evaluate(`
            (() => {
                const el = document.activeElement;
                const cs = getComputedStyle(el);
                return {
                    id: el?.id ?? null,
                    outlineStyle: cs.outlineStyle,
                    outlineWidth: parseFloat(cs.outlineWidth),
                    matchesFocusVisible: el?.matches(':focus-visible') ?? false,
                };
            })()
        `);
        visitedIds.push(activeInfo.id);
        assert.equal(activeInfo.id, expectedId);
        assert.equal(activeInfo.matchesFocusVisible, true, `Expected :focus-visible on #${expectedId}`);
        assert.equal(activeInfo.outlineStyle, 'solid', `Expected solid focus outline on #${expectedId}`);
        assert.ok(activeInfo.outlineWidth >= 2, `Expected >=2px focus outline on #${expectedId}`);
    }
    assert.deepEqual(visitedIds, expectedTabSequence);

    // Verify Shift+Tab moves focus backward without trapping focus.
    await chrome.pressKey('Tab', { shift: true });
    assert.equal(await chrome.evaluate(`document.activeElement?.id`), 'box-d-width');

    // Focus Box A width slider and use ArrowLeft keys to shrink width from 180px to 140px (< 150),
    // then Tab to Box A height slider and shrink height from 160px to 140px (< 150) to trigger circle transformation.
    await chrome.evaluate(`document.getElementById('box-a-width').focus()`);
    for (let i = 0; i < 4; i++) {
        await chrome.pressKey('ArrowLeft');
    }
    await chrome.pressKey('Tab');
    assert.equal(await chrome.evaluate(`document.activeElement?.id`), 'box-a-height');
    for (let i = 0; i < 2; i++) {
        await chrome.pressKey('ArrowDown');
    }

    await waitForCondition(
        chrome.evaluate,
        `document.getElementById('box-a').style.borderRadius === '100%'`
    );

    const boxACircleState = await chrome.evaluate(`
        (() => {
            const box = document.getElementById('box-a');
            const rect = box.getBoundingClientRect();
            return {
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                borderRadius: box.style.borderRadius,
                borderWidth: box.style.borderWidth,
                statusText: document.getElementById('resize-status').textContent,
            };
        })()
    `);
    assert.equal(boxACircleState.width, 140);
    assert.equal(boxACircleState.height, 140);
    assert.equal(boxACircleState.borderRadius, '100%');
    assert.equal(boxACircleState.borderWidth, '4px');
    assert.match(boxACircleState.statusText, /Box A.*circle/i);

    // Verify direct Arrow key resizing on focused Box B updates dimensions, syncs sliders, morphs into a circle, and restores to rectangle.
    await chrome.evaluate(`document.getElementById('box-b').focus()`);
    for (let i = 0; i < 4; i++) {
        await chrome.pressKey('ArrowLeft');
    }
    for (let i = 0; i < 2; i++) {
        await chrome.pressKey('ArrowDown');
    }

    await waitForCondition(
        chrome.evaluate,
        `document.getElementById('box-b').style.borderRadius === '100%'`
    );

    const boxBCircleState = await chrome.evaluate(`
        (() => {
            const box = document.getElementById('box-b');
            return {
                borderRadius: box.style.borderRadius,
                widthSliderValue: document.getElementById('box-b-width').value,
                heightSliderValue: document.getElementById('box-b-height').value,
                statusText: document.getElementById('resize-status').textContent,
            };
        })()
    `);
    assert.equal(boxBCircleState.borderRadius, '100%');
    assert.equal(boxBCircleState.widthSliderValue, '140');
    assert.equal(boxBCircleState.heightSliderValue, '140');
    assert.match(boxBCircleState.statusText, /Box B.*circle/i);

    // Press ArrowRight and ArrowUp on Box B to restore above 150px and verify rectangle announcement.
    await chrome.pressKey('ArrowRight');
    await chrome.pressKey('ArrowUp');

    await waitForCondition(
        chrome.evaluate,
        `document.getElementById('box-b').style.borderRadius === 'unset'`
    );

    const boxBRectState = await chrome.evaluate(`
        ({
            borderRadius: document.getElementById('box-b').style.borderRadius,
            statusText: document.getElementById('resize-status').textContent,
        })
    `);
    assert.equal(boxBRectState.borderRadius, 'unset');
    assert.match(boxBRectState.statusText, /Box B.*rectangle/i);

    // Verify Accessibility Tree exposes names, roles, and values for boxes and sliders.
    const axTree = await chrome.send('Accessibility.getFullAXTree');
    const sliders = axTree.nodes.filter((n) => n.role?.value === 'slider');
    assert.equal(sliders.length, 8, 'Expected 8 slider roles in accessibility tree');
    for (const slider of sliders) {
        assert.ok(slider.name?.value?.length > 0, 'Expected every slider to have a non-empty accessible name');
    }

    const boxGroups = axTree.nodes.filter(
        (n) => n.role?.value === 'group' && /^Box [ABCD]$/.test(n.name?.value ?? '')
    );
    assert.equal(boxGroups.length, 4, 'Expected 4 named Box groups in accessibility tree');
    for (const group of boxGroups) {
        assert.match(group.description?.value ?? '', /sliders|Arrow keys/i);
    }
});
