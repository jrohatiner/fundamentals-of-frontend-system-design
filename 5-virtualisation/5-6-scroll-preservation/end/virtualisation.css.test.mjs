import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
};

const EXERCISES = [
    {
        name: '5-4-2-elements-pool-and-recycling-rendering/end',
        urlPath: '/5-virtualisation/5-4-2-elements-pool-and-recycling-rendering/end/index.html',
    },
    {
        name: '5-5-top-observer/end',
        urlPath: '/5-virtualisation/5-5-top-observer/end/index.html',
    },
    {
        name: '5-6-scroll-preservation/end',
        urlPath: '/5-virtualisation/5-6-scroll-preservation/end/index.html',
    },
];

const VIEWPORTS = [
    { label: 'desktop (1280x800)', width: 1280, height: 800, mobile: false },
    { label: 'wide desktop (1432x900)', width: 1432, height: 900, mobile: false },
    { label: 'narrow mobile (375x812)', width: 375, height: 812, mobile: false },
];

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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'virtual-list-css-test-'));

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
        rmSync(userDataDir, { recursive: true, force: true });
    }

    return { send, evaluate, cleanup };
}

async function waitForCards(evaluate, minCount = 10, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = await evaluate(`document.querySelectorAll('#virtual-list .card').length`);
        if (count >= minCount) {
            return count;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for at least ${minCount} .card elements`);
}

async function measureLayout(evaluate) {
    return evaluate(`(() => {
        const container = document.getElementById('container');
        const list = document.getElementById('virtual-list');
        const cards = Array.from(document.querySelectorAll('#virtual-list .card'));
        const containerRect = container.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);

        return {
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            rootFontSize,
            container: {
                left: containerRect.left,
                right: containerRect.right,
                width: containerRect.width,
            },
            list: {
                left: listRect.left,
                right: listRect.right,
                width: listRect.width,
            },
            cards: cards.map((card, index) => {
                const rect = card.getBoundingClientRect();
                const style = getComputedStyle(card);
                return {
                    index,
                    left: rect.left,
                    right: rect.right,
                    width: rect.width,
                    top: rect.top,
                    dataY: card.getAttribute('data-y'),
                    position: style.position,
                    marginTop: style.marginTop,
                    marginRight: style.marginRight,
                    marginBottom: style.marginBottom,
                    marginLeft: style.marginLeft,
                };
            }),
        };
    })()`);
}

describe('Virtual list .card inset offsets and dynamic width calculation', () => {
    let serverInfo;
    let chrome;

    before(async () => {
        serverInfo = await startStaticServer(REPO_ROOT);
        chrome = await launchHeadlessChrome();
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

    for (const exercise of EXERCISES) {
        it(`keeps .card within #container with symmetric 2rem gutters across viewports in ${exercise.name}`, async () => {
            await chrome.send('Emulation.setDeviceMetricsOverride', {
                width: VIEWPORTS[0].width,
                height: VIEWPORTS[0].height,
                deviceScaleFactor: 1,
                mobile: VIEWPORTS[0].mobile,
            });

            await chrome.send('Page.navigate', {
                url: `${serverInfo.baseUrl}${exercise.urlPath}`,
            });
            await waitForCards(chrome.evaluate, 10);

            for (const viewport of VIEWPORTS) {
                await chrome.send('Emulation.setDeviceMetricsOverride', {
                    width: viewport.width,
                    height: viewport.height,
                    deviceScaleFactor: 1,
                    mobile: viewport.mobile,
                });

                const layout = await measureLayout(chrome.evaluate);
                const expectedInset = 2 * layout.rootFontSize; // 2rem = 32px
                assert.equal(layout.cards.length >= 10, true, `Expected rendered cards in ${exercise.name}`);
                assert.ok(
                    layout.scrollWidth <= layout.innerWidth,
                    `Expected no horizontal document overflow on ${viewport.label} in ${exercise.name} (scrollWidth=${layout.scrollWidth}, innerWidth=${layout.innerWidth})`
                );

                for (const card of layout.cards) {
                    const leftGutter = card.left - layout.container.left;
                    const rightGutter = layout.container.right - card.right;
                    const expectedWidth = layout.list.width - 2 * expectedInset;

                    assert.equal(card.position, 'absolute');
                    assert.equal(card.marginTop, '0px');
                    assert.equal(card.marginRight, '0px');
                    assert.equal(card.marginBottom, '0px');
                    assert.equal(card.marginLeft, '0px');
                    assert.ok(
                        card.right <= layout.container.right,
                        `Card ${card.index} right edge (${card.right}) exceeded container right edge (${layout.container.right}) on ${viewport.label}`
                    );
                    assert.ok(
                        Math.abs(leftGutter - expectedInset) < 0.5,
                        `Expected 32px left gutter on ${viewport.label}, got ${leftGutter}`
                    );
                    assert.ok(
                        Math.abs(rightGutter - expectedInset) < 0.5,
                        `Expected 32px right gutter on ${viewport.label}, got ${rightGutter}`
                    );
                    assert.ok(
                        Math.abs(card.width - expectedWidth) < 0.5,
                        `Expected card width ${expectedWidth} on ${viewport.label}, got ${card.width}`
                    );
                }
            }
        });
    }

    it('preserves container boundaries during scroll recycling and when horizontal padding is applied', async () => {
        await chrome.send('Emulation.setDeviceMetricsOverride', {
            width: 1280,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false,
        });

        await chrome.send('Page.navigate', {
            url: `${serverInfo.baseUrl}/5-virtualisation/5-6-scroll-preservation/end/index.html`,
        });
        await waitForCards(chrome.evaluate, 10);

        // Scroll to bottom-observer twice to populate pool (20 cards) and trigger recycling
        for (let step = 0; step < 2; step++) {
            const prevTitles = await chrome.evaluate(
                `Array.from(document.querySelectorAll('#virtual-list .card h3')).map(h => h.textContent).join('|')`
            );
            await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                const nextTitles = await chrome.evaluate(
                    `Array.from(document.querySelectorAll('#virtual-list .card h3')).map(h => h.textContent).join('|')`
                );
                if (nextTitles !== prevTitles) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }

        const recycledLayout = await measureLayout(chrome.evaluate);
        assert.equal(recycledLayout.cards.length, 20, 'Pool should reach poolLimit (20 cards)');
        for (const card of recycledLayout.cards) {
            assert.ok(card.right <= recycledLayout.container.right);
            assert.ok(Math.abs((card.left - recycledLayout.container.left) - 32) < 0.5);
            assert.ok(Math.abs((recycledLayout.container.right - card.right) - 32) < 0.5);
        }

        // Apply horizontal padding to parent containers and verify cards stay within padded containing block
        await chrome.evaluate(`(() => {
            document.getElementById('container').style.padding = '0 24px';
            document.getElementById('virtual-list').style.padding = '0 16px';
        })()`);

        const paddedLayout = await measureLayout(chrome.evaluate);
        assert.ok(paddedLayout.scrollWidth <= paddedLayout.innerWidth, 'Expected no horizontal scrollbar with padded container');
        for (const card of paddedLayout.cards) {
            assert.ok(
                card.left >= paddedLayout.list.left + 31.5 && card.right <= paddedLayout.list.right - 31.5,
                `Card ${card.index} should stay inset 2rem inside padded #virtual-list`
            );
            assert.ok(
                card.right <= paddedLayout.container.right,
                `Card ${card.index} must not exceed padded #container right boundary`
            );
        }
    });
});
