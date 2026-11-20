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

    return { send, evaluate, pressKey, cleanup };
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
