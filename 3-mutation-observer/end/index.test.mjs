import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'mutation-observer-test-'));

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
            ws.close();
        } catch {}
        if (proc.exitCode === null) {
            proc.kill('SIGKILL');
            await new Promise((resolve) => proc.once('exit', resolve));
        }
        rmSync(userDataDir, { recursive: true, force: true });
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
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for condition: ${predicateExpr}`);
}

test('delegates MutationObserver to #list across pagination and converts heading commands only inside editable card content', async (t) => {
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(() => server.close());

    const chrome = await launchHeadlessChrome();
    t.after(async () => {
        await chrome.cleanup();
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');

    // Instrument MutationObserver before page scripts execute.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
            (() => {
                const NativeMutationObserver = window.MutationObserver;
                const nativeFocus = HTMLElement.prototype.focus;
                window.__observerStats = {
                    instances: 0,
                    observeCalls: [],
                };
                window.__focusedElements = [];

                HTMLElement.prototype.focus = function (...args) {
                    window.__focusedElements.push(this);
                    return nativeFocus.apply(this, args);
                };

                window.MutationObserver = class extends NativeMutationObserver {
                    constructor(callback) {
                        super(callback);
                        window.__observerStats.instances += 1;
                    }
                    observe(target, options) {
                        window.__observerStats.observeCalls.push({
                            id: target?.id ?? null,
                            tagName: target?.tagName ?? null,
                            className: target?.className ?? null,
                            options: options ? { ...options } : null,
                        });
                        return super.observe(target, options);
                    }
                };
            })();
        `,
    });

    await chrome.send('Page.navigate', {
        url: `${baseUrl}/3-mutation-observer/end/index.html`,
    });

    // Wait for initial page (10 cards) to load via IntersectionObserver.
    await waitForCondition(chrome.evaluate, `document.querySelectorAll('#list .card').length === 10`);

    let stats = await chrome.evaluate(`window.__observerStats`);
    assert.equal(stats.instances, 1, 'Expected exactly one MutationObserver instance');
    assert.equal(stats.observeCalls.length, 1, 'Expected a single observe() registration at initialization');
    assert.equal(stats.observeCalls[0].id, 'list', 'Expected MutationObserver to observe #list');
    assert.deepEqual(stats.observeCalls[0].options, {
        characterData: true,
        subtree: true,
    });

    // Trigger second pagination cycle (20 cards total).
    await chrome.evaluate(`
        document.getElementById('bottom-observer').scrollIntoView();
    `);
    await waitForCondition(chrome.evaluate, `document.querySelectorAll('#list .card').length === 20`);

    // Trigger third pagination cycle (30 cards total).
    await chrome.evaluate(`
        document.getElementById('bottom-observer').scrollIntoView();
    `);
    await waitForCondition(chrome.evaluate, `document.querySelectorAll('#list .card').length === 30`);

    stats = await chrome.evaluate(`window.__observerStats`);
    assert.equal(
        stats.instances,
        1,
        'Expected MutationObserver instance count to remain 1 across pagination cycles'
    );
    assert.equal(
        stats.observeCalls.length,
        1,
        'Expected observe() registration count to remain 1 across 3 pagination cycles (30 cards)'
    );

    // Verify /h1, /h2, and /h3 commands across initial and dynamically paginated cards, including real typing.
    // 1) Simulate real user typing inside Card 0 (initial batch): clear existing text to '/', then type 'h1'.
    await chrome.evaluate(`
        (() => {
            const content = document.querySelectorAll('#list .card .card__body__content')[0];
            content.focus();
            content.firstChild.data = '/';
            const range = document.createRange();
            range.setStart(content.firstChild, 1);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        })();
    `);
    await chrome.send('Input.insertText', { text: 'h' });
    await chrome.send('Input.insertText', { text: '1' });

    await waitForCondition(
        chrome.evaluate,
        `Boolean(document.querySelectorAll('#list .card .card__body__content')[0].querySelector('h1'))`
    );

    const card0Heading = await chrome.evaluate(`
        (() => {
            const content = document.querySelectorAll('#list .card .card__body__content')[0];
            const heading = content.querySelector('h1');
            return {
                tagName: heading?.tagName,
                textContent: heading?.textContent,
                contentEditable: heading?.getAttribute('contenteditable'),
                focusCalledOnHeading: window.__focusedElements.at(-1) === heading,
            };
        })()
    `);
    assert.deepEqual(card0Heading, {
        tagName: 'H1',
        textContent: 'Heading',
        contentEditable: 'true',
        focusCalledOnHeading: true,
    });

    // 2) Verify /h2 on a paginated Page 1 card (Card 12) and /h3 inside a nested line container on Page 2 (Card 25).
    const paginatedHeadings = await chrome.evaluate(`
        new Promise((resolve) => {
            const contents = document.querySelectorAll('#list .card .card__body__content');
            contents[12].firstChild.data = '/h';
            contents[12].firstChild.data = '/h2';

            const nestedLine = document.createElement('div');
            const nestedText = document.createTextNode('draft');
            nestedLine.appendChild(nestedText);
            contents[25].appendChild(nestedLine);
            nestedText.data = '/h3';

            queueMicrotask(() => {
                const h2 = contents[12].querySelector('h2');
                const h3 = contents[25].querySelector('div > h3');
                resolve({
                    h2Count: contents[12].querySelectorAll('h2').length,
                    h2Tag: h2?.tagName ?? null,
                    h2Text: h2?.textContent ?? null,
                    h3Tag: h3?.tagName ?? null,
                    h3Text: h3?.textContent ?? null,
                    focusCalledOnH2: window.__focusedElements.includes(h2),
                    lastFocusedIsH3: window.__focusedElements.at(-1) === h3,
                });
            });
        })
    `);
    assert.deepEqual(paginatedHeadings, {
        h2Count: 1,
        h2Tag: 'H2',
        h2Text: 'Heading',
        h3Tag: 'H3',
        h3Text: 'Heading',
        focusCalledOnH2: true,
        lastFocusedIsH3: true,
    });

    // 3) Verify characterData mutations outside editable card content are ignored.
    const nonEditableCheck = await chrome.evaluate(`
        new Promise((resolve) => {
            const card = document.querySelectorAll('#list .card')[1];
            const title = card.querySelector('.card__title');
            title.firstChild.data = '/h1';

            const lockedContent = document.querySelectorAll('#list .card .card__body__content')[2];
            lockedContent.setAttribute('contenteditable', 'false');
            lockedContent.firstChild.data = '/h2';

            const nonEditableChild = document.createElement('span');
            nonEditableChild.setAttribute('contenteditable', 'false');
            const nonEditableChildText = document.createTextNode('badge');
            nonEditableChild.appendChild(nonEditableChildText);
            document.querySelectorAll('#list .card .card__body__content')[3].appendChild(nonEditableChild);
            nonEditableChildText.data = '/h1';

            const strayListText = document.createTextNode('placeholder');
            document.getElementById('list').appendChild(strayListText);
            strayListText.data = '/h3';

            queueMicrotask(() => {
                resolve({
                    titleNestedH1: Boolean(title.querySelector('h1')),
                    titleText: title.textContent,
                    lockedNestedH2: Boolean(lockedContent.querySelector('h2')),
                    lockedText: lockedContent.textContent,
                    nonEditableChildH1: Boolean(nonEditableChild.querySelector('h1')),
                    nonEditableChildText: nonEditableChild.textContent,
                    strayStillTextNode: strayListText.parentNode?.id === 'list',
                });
            });
        })
    `);
    assert.deepEqual(nonEditableCheck, {
        titleNestedH1: false,
        titleText: '/h1',
        lockedNestedH2: false,
        lockedText: '/h2',
        nonEditableChildH1: false,
        nonEditableChildText: '/h1',
        strayStillTextNode: true,
    });
});
