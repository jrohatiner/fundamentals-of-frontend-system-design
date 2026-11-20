import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VirtualList } from './virtual-list.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));

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
        proc.stderr.destroy();
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

describe('Transparent in-flow observer sentinels', () => {
    it('renders empty aria-hidden sentinels without visible template labels in VirtualList.toHTML()', () => {
        const list = new VirtualList({}, { pageSize: 10 });
        const html = list.toHTML();

        assert.equal(html.includes('Top Observer'), false, 'top sentinel must not contain debug text');
        assert.equal(html.includes('Bottom Observer'), false, 'bottom sentinel must not contain debug text');
        assert.match(html, /<div id="top-observer" aria-hidden="true"><\/div>/);
        assert.match(html, /<main id="virtual-list"><\/main>/);
        assert.match(html, /<div id="bottom-observer" aria-hidden="true"><\/div>/);
    });

    const chromeBin = findChromeBinary();

    describe('Browser E2E sentinel layout and IntersectionObserver triggers', { skip: !chromeBin }, () => {
        let serverInfo;
        let chrome;

        before(async () => {
            serverInfo = await startStaticServer(REPO_ROOT);
            chrome = await launchHeadlessChrome(chromeBin);
            await chrome.send('Page.enable');
            await chrome.send('Runtime.enable');
        });

        after(async () => {
            if (chrome) {
                await chrome.cleanup();
            }
            if (serverInfo?.server) {
                serverInfo.server.closeAllConnections?.();
                serverInfo.server.close();
            }
        });

        it('collapses sentinels to 1px transparent triggers and preserves bidirectional virtual scroll in 5-6', async () => {
            await chrome.send('Page.navigate', {
                url: `${serverInfo.baseUrl}/5-virtualisation/5-6-scroll-preservation/end/index.html`,
            });
            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('#virtual-list .card').length === 10`
            );

            const sentinelState = await chrome.evaluate(`(() => {
                const inspect = (id) => {
                    const el = document.getElementById(id);
                    const style = getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return {
                        textContent: el.textContent,
                        ariaHidden: el.getAttribute('aria-hidden'),
                        rectHeight: rect.height,
                        height: style.height,
                        opacity: style.opacity,
                        backgroundColor: style.backgroundColor,
                        overflow: style.overflow,
                        fontSize: style.fontSize,
                        borderTopWidth: style.borderTopWidth,
                        marginLeft: style.marginLeft,
                        marginRight: style.marginRight,
                        display: style.display,
                    };
                };
                const containerRect = document.getElementById('container').getBoundingClientRect();
                const firstCardRect = document.querySelector('#virtual-list .card').getBoundingClientRect();
                return {
                    top: inspect('top-observer'),
                    bottom: inspect('bottom-observer'),
                    firstCardOffsetFromContainerTop: firstCardRect.top - containerRect.top,
                };
            })()`);

            for (const key of ['top', 'bottom']) {
                const s = sentinelState[key];
                assert.equal(s.textContent, '', `${key} sentinel should have empty text`);
                assert.equal(s.ariaHidden, 'true', `${key} sentinel should have aria-hidden="true"`);
                assert.equal(s.rectHeight, 1, `${key} sentinel bounding box must remain 1px`);
                assert.equal(s.height, '1px');
                assert.equal(s.opacity, '0');
                assert.equal(s.backgroundColor, 'rgba(0, 0, 0, 0)');
                assert.equal(s.overflow, 'hidden');
                assert.equal(s.fontSize, '0px');
                assert.equal(s.borderTopWidth, '0px');
                assert.equal(s.marginLeft, '0px');
                assert.equal(s.marginRight, '0px');
                assert.equal(s.display, 'block');
            }
            assert.equal(
                sentinelState.firstCardOffsetFromContainerTop,
                1,
                'First card should sit directly below 1px top sentinel without 100px debug gap'
            );

            // Scroll forward twice to fill pool (20 cards: Entries 0..19) and recycle (Entries 10..29)
            await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('#virtual-list .card').length === 20`
            );
            const heightAfterPage1 = await chrome.evaluate(
                `parseFloat(document.getElementById('container').style.height)`
            );

            await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
            await waitForCondition(
                chrome.evaluate,
                `Array.from(document.querySelectorAll('#virtual-list .card h3')).some(h => h.textContent.startsWith('[Entry 20]'))`
            );
            const forwardState = await chrome.evaluate(`(() => {
                const cardsByY = Array.from(document.querySelectorAll('#virtual-list .card'))
                    .sort((a, b) => Number(a.getAttribute('data-y')) - Number(b.getAttribute('data-y')));
                const titles = cardsByY.map(card => card.querySelector('h3').textContent);
                return {
                    firstTitle: titles[0],
                    lastTitle: titles[titles.length - 1],
                    containerHeight: parseFloat(document.getElementById('container').style.height),
                    topHeight: document.getElementById('top-observer').getBoundingClientRect().height,
                    bottomHeight: document.getElementById('bottom-observer').getBoundingClientRect().height,
                };
            })()`);

            assert.match(forwardState.firstTitle, /^\[Entry 10\]/);
            assert.match(forwardState.lastTitle, /^\[Entry 29\]/);
            assert.ok(forwardState.containerHeight > heightAfterPage1, 'Container scroll height should grow smoothly');
            assert.equal(forwardState.topHeight, 1);
            assert.equal(forwardState.bottomHeight, 1);

            // Scroll backward to #top-observer to trigger #handleTopObserver and recycle back to Entries 0..19
            await chrome.evaluate(`document.getElementById('top-observer').scrollIntoView()`);
            await waitForCondition(
                chrome.evaluate,
                `Array.from(document.querySelectorAll('#virtual-list .card h3')).some(h => h.textContent.startsWith('[Entry 0]'))`
            );

            const backwardTitles = await chrome.evaluate(`(() => {
                return Array.from(document.querySelectorAll('#virtual-list .card'))
                    .sort((a, b) => Number(a.getAttribute('data-y')) - Number(b.getAttribute('data-y')))
                    .map(card => card.querySelector('h3').textContent);
            })()`);
            assert.match(backwardTitles[0], /^\[Entry 0\]/);
            assert.match(backwardTitles[backwardTitles.length - 1], /^\[Entry 19\]/);
        });

        it('keeps 1px invisible sentinel despite consumer text and triggers infinite scroll in 2-intersection-observer', async () => {
            await chrome.send('Page.navigate', {
                url: `${serverInfo.baseUrl}/2-intersection-observer/end/index.html`,
            });
            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('#list .card').length === 10`
            );

            const initialSentinel = await chrome.evaluate(`(() => {
                const el = document.getElementById('bottom-observer');
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return {
                    text: el.textContent.trim(),
                    rectHeight: rect.height,
                    opacity: style.opacity,
                    overflow: style.overflow,
                    fontSize: style.fontSize,
                    backgroundColor: style.backgroundColor,
                };
            })()`);

            assert.equal(initialSentinel.text, 'Bottom Observer');
            assert.equal(
                initialSentinel.rectHeight,
                1,
                'Leftover text in consumer markup must not expand sentinel beyond 1px'
            );
            assert.equal(initialSentinel.opacity, '0');
            assert.equal(initialSentinel.overflow, 'hidden');
            assert.equal(initialSentinel.fontSize, '0px');
            assert.equal(initialSentinel.backgroundColor, 'rgba(0, 0, 0, 0)');

            // Trigger two additional infinite scroll pages
            await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('#list .card').length === 20`
            );

            await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
            await waitForCondition(
                chrome.evaluate,
                `document.querySelectorAll('#list .card').length === 30`
            );

            const countAfterScroll = await chrome.evaluate(
                `document.querySelectorAll('#list .card').length`
            );
            assert.equal(countAfterScroll, 30);
        });
    });
});
