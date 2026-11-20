import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
    '.png': 'image/png',
    '.gif': 'image/gif',
};

const NON_CARD_LIST_PAGES = new Set([
    '1-dom/begin/index.html',
    '1-dom/end/index.html',
    '4-resize-observer/begin/index.html',
    '4-resize-observer/end/index.html',
]);

function findHtmlEntrypoints(dir, acc = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findHtmlEntrypoints(fullPath, acc);
        } else if (entry.name.endsWith('.html')) {
            acc.push(path.relative(REPO_ROOT, fullPath).split(path.sep).join('/'));
        }
    }
    return acc.sort();
}

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
            if (!resolvedPath.startsWith(rootDir) || !existsSync(resolvedPath) || statSync(resolvedPath).isDirectory()) {
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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'landmarks-skip-links-test-'));

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
    const exceptions = [];

    ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') {
            exceptions.push(
                message.params?.exceptionDetails?.exception?.description ??
                    message.params?.exceptionDetails?.text ??
                    'Unknown runtime exception'
            );
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

    async function pressKey(key, code, windowsVirtualKeyCode) {
        await send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key,
            code,
            windowsVirtualKeyCode,
            nativeVirtualKeyCode: windowsVirtualKeyCode,
        });
        await send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code,
            windowsVirtualKeyCode,
            nativeVirtualKeyCode: windowsVirtualKeyCode,
        });
    }

    async function navigate(url) {
        exceptions.length = 0;
        const loadPromise = new Promise((resolve) => {
            const listener = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.method === 'Page.loadEventFired') {
                    ws.removeEventListener('message', listener);
                    resolve();
                }
            };
            ws.addEventListener('message', listener);
        });
        await send('Page.navigate', { url });
        await loadPromise;
        await new Promise((resolve) => setTimeout(resolve, 60));
    }

    async function cleanup() {
        try {
            ws.close();
        } catch {}
        if (proc.exitCode === null) {
            proc.kill('SIGKILL');
            await new Promise((resolve) => proc.once('exit', resolve));
        }
        rmSync(userDataDir, { recursive: true, force: true });
    }

    return { send, evaluate, pressKey, navigate, exceptions, cleanup };
}

test('exposes one top-level main#container landmark and working CSS skip links across all 24 HTML entrypoints', async (t) => {
    const entrypoints = findHtmlEntrypoints(REPO_ROOT);
    assert.equal(entrypoints.length, 24, 'Expected exactly 24 HTML exercise entrypoints');

    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(() => server.close());

    const chrome = await launchHeadlessChrome();
    t.after(async () => {
        await chrome.cleanup();
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');

    for (const relPath of entrypoints) {
        await chrome.navigate(`${baseUrl}/${relPath}`);
        assert.deepEqual(
            chrome.exceptions,
            [],
            `Expected zero runtime exceptions when loading ${relPath}`
        );

        const isCardList = !NON_CARD_LIST_PAGES.has(relPath);

        const info = await chrome.evaluate(`
            (() => {
                const mains = [...document.querySelectorAll('main')];
                const container = document.getElementById('container');
                const nav = document.querySelector('nav[aria-label="Skip links"]');
                const skipMain = nav?.querySelector('a.skip-link[href="#container"]');
                const skipCards = nav?.querySelector('a.skip-link[href="#list-end"]');
                const listEnd = document.getElementById('list-end');
                const virtualList = document.getElementById('virtual-list');

                const orphanedBodyContent = [...document.body.children].filter((el) => {
                    if (el.tagName === 'SCRIPT' || el.tagName === 'NAV' || el.tagName === 'MAIN') {
                        return false;
                    }
                    if (el.id === 'list-end' && el.textContent.trim() === '') {
                        return false;
                    }
                    return true;
                });

                return {
                    mainCount: mains.length,
                    containerTag: container?.tagName ?? null,
                    containerTabIndex: container?.getAttribute('tabindex') ?? null,
                    hasSkipNav: Boolean(nav),
                    skipMainOffscreenLeft: skipMain ? skipMain.getBoundingClientRect().left : null,
                    hasSkipCards: Boolean(skipCards),
                    hasListEnd: Boolean(listEnd),
                    listEndTabIndex: listEnd?.getAttribute('tabindex') ?? null,
                    virtualListTag: virtualList?.tagName ?? null,
                    virtualListInsideMain: virtualList ? container?.contains(virtualList) : null,
                    orphanedCount: orphanedBodyContent.length,
                };
            })()
        `);

        assert.equal(info.mainCount, 1, `${relPath}: expected exactly one <main> landmark`);
        assert.equal(info.containerTag, 'MAIN', `${relPath}: expected #container to be <main>`);
        assert.equal(info.containerTabIndex, '-1', `${relPath}: expected tabindex="-1" on main#container`);
        assert.equal(info.hasSkipNav, true, `${relPath}: expected <nav aria-label="Skip links">`);
        assert.ok(
            info.skipMainOffscreenLeft < -100,
            `${relPath}: expected .skip-link to be visually off-screen before focus`
        );
        assert.equal(info.orphanedCount, 0, `${relPath}: expected zero orphaned sibling content outside landmarks`);
        assert.equal(info.hasSkipCards, isCardList, `${relPath}: unexpected Skip card list presence`);
        assert.equal(info.hasListEnd, isCardList, `${relPath}: unexpected #list-end presence`);

        if (isCardList) {
            assert.equal(info.listEndTabIndex, '-1', `${relPath}: expected tabindex="-1" on #list-end`);
        }
        if (info.virtualListTag !== null) {
            assert.equal(info.virtualListTag, 'DIV', `${relPath}: expected #virtual-list to be a <div>`);
            assert.equal(info.virtualListInsideMain, true, `${relPath}: expected #virtual-list inside main#container`);
        }

        // Tab once -> reveals "Skip to main content"; Enter -> moves focus to main#container
        await chrome.pressKey('Tab', 'Tab', 9);
        const firstTab = await chrome.evaluate(`
            (() => {
                const el = document.activeElement;
                const rect = el.getBoundingClientRect();
                return {
                    text: el?.textContent?.trim() ?? null,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height,
                };
            })()
        `);
        assert.equal(firstTab.text, 'Skip to main content', `${relPath}: first Tab must focus Skip to main content`);
        assert.ok(firstTab.left >= 0 && firstTab.width > 50 && firstTab.height > 20, `${relPath}: focused skip link must be visible`);

        await chrome.pressKey('Enter', 'Enter', 13);
        const mainFocused = await chrome.evaluate(`({ id: document.activeElement?.id, tag: document.activeElement?.tagName })`);
        assert.deepEqual(mainFocused, { id: 'container', tag: 'MAIN' }, `${relPath}: Enter must move focus to main#container`);

        if (isCardList) {
            await chrome.navigate(`${baseUrl}/${relPath}`);
            await chrome.pressKey('Tab', 'Tab', 9);
            await chrome.pressKey('Tab', 'Tab', 9);
            const secondTab = await chrome.evaluate(`
                (() => {
                    const el = document.activeElement;
                    const rect = el.getBoundingClientRect();
                    return {
                        text: el?.textContent?.trim() ?? null,
                        left: rect.left,
                        width: rect.width,
                        height: rect.height,
                    };
                })()
            `);
            assert.equal(secondTab.text, 'Skip card list', `${relPath}: second Tab must focus Skip card list`);
            assert.ok(secondTab.left >= 0 && secondTab.width > 50 && secondTab.height > 20, `${relPath}: focused Skip card list must be visible`);

            await chrome.pressKey('Enter', 'Enter', 13);
            const listEndFocused = await chrome.evaluate(`document.activeElement?.id`);
            assert.equal(listEndFocused, 'list-end', `${relPath}: Enter must move focus to #list-end`);
        }
    }
});
