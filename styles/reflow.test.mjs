import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function findHtmlFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findHtmlFiles(fullPath));
        } else if (entry.name.endsWith('.html')) {
            results.push(path.relative(REPO_ROOT, fullPath));
        }
    }
    return results.sort();
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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'wcag-reflow-test-'));

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
        await new Promise((resolve) => setTimeout(resolve, 50));
        rmSync(userDataDir, { recursive: true, force: true });
    }

    return { send, evaluate, cleanup };
}

test('all 24 exercise HTML files declare viewport metadata in <head>', () => {
    const htmlFiles = findHtmlFiles(REPO_ROOT);
    assert.equal(htmlFiles.length, 24, 'Expected exactly 24 exercise HTML files');

    for (const relPath of htmlFiles) {
        const content = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        const headMatch = content.match(/<head>([\s\S]*?)<\/head>/i);
        assert.ok(headMatch, `Expected <head> in ${relPath}`);
        assert.match(
            headMatch[1],
            /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1\.0"\s*\/?>/i,
            `Expected standard viewport meta tag inside <head> of ${relPath}`
        );
    }
});

test('all 24 exercises reflow without horizontal scrollbars at 320px mobile, 400% zoom, and 1440px desktop', async (t) => {
    const htmlFiles = findHtmlFiles(REPO_ROOT);
    const { server, baseUrl } = await startStaticServer(REPO_ROOT);
    t.after(() => server.close());

    const chrome = await launchHeadlessChrome();
    t.after(async () => {
        await chrome.cleanup();
    });

    await chrome.send('Page.enable');
    await chrome.send('Runtime.enable');

    // 1. Mobile 320px check: native viewport width (320px, no 980px downscaling) and zero horizontal overflow
    await chrome.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 640,
        deviceScaleFactor: 2,
        mobile: true,
    });

    for (const relPath of htmlFiles) {
        const htmlContent = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        const usesMockDb = htmlContent.includes('initMockDB');
        await chrome.send('Page.navigate', { url: `${baseUrl}/${relPath}` });
        await new Promise((resolve) => setTimeout(resolve, usesMockDb ? 1150 : 120));

        const metrics = await chrome.evaluate(`({
            innerWidth: window.innerWidth,
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth
        })`);

        assert.equal(metrics.innerWidth, 320, `${relPath}: expected mobile innerWidth 320`);
        assert.ok(
            metrics.scrollWidth <= metrics.clientWidth,
            `${relPath} (mobile 320px): scrollWidth (${metrics.scrollWidth}) exceeded clientWidth (${metrics.clientWidth})`
        );
    }

    // 2. Desktop 320 CSS px / 1280px at 400% zoom check across all 24 pages
    await chrome.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 256,
        deviceScaleFactor: 4,
        mobile: false,
    });

    for (const relPath of htmlFiles) {
        const htmlContent = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        const usesMockDb = htmlContent.includes('initMockDB');
        await chrome.send('Page.navigate', { url: `${baseUrl}/${relPath}` });
        await new Promise((resolve) => setTimeout(resolve, usesMockDb ? 1150 : 120));

        const audit = await chrome.evaluate(`(() => {
            const docEl = document.documentElement;
            const overflowing = [];
            for (const el of document.querySelectorAll('*')) {
                const rect = el.getBoundingClientRect();
                if (rect.right > docEl.clientWidth + 0.5 || rect.left < -0.5) {
                    overflowing.push({ tag: el.tagName, id: el.id, className: el.className });
                }
            }
            return {
                clientWidth: docEl.clientWidth,
                scrollWidth: docEl.scrollWidth,
                overflowing
            };
        })()`);

        assert.ok(
            audit.scrollWidth <= audit.clientWidth && audit.overflowing.length === 0,
            `${relPath} (400% zoom / 320 CSS px): scrollWidth=${audit.scrollWidth}, clientWidth=${audit.clientWidth}, overflowing=${JSON.stringify(audit.overflowing)}`
        );
    }

    // 3. Verify 4-resize-observer single-column reflow below 480px, 100px min resize, ResizeObserver callback, and max-width clamp
    await chrome.send('Page.navigate', { url: `${baseUrl}/4-resize-observer/end/index.html` });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const resizeCheck = await chrome.evaluate(`new Promise((resolve) => {
        const boxes = [...document.querySelectorAll('.box')];
        const initialRects = boxes.map((b) => b.getBoundingClientRect());
        boxes[0].style.width = '100px';
        boxes[0].style.height = '100px';
        boxes[1].style.width = '800px';
        setTimeout(() => {
            const r0 = boxes[0].getBoundingClientRect();
            resolve({
                singleColumn: initialRects[1].top > initialRects[0].bottom && initialRects[0].left === initialRects[1].left,
                minWidth: Math.round(r0.width),
                minHeight: Math.round(r0.height),
                borderRadius: boxes[0].style.borderRadius,
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth
            });
        }, 100);
    })`);

    assert.equal(resizeCheck.singleColumn, true, 'Expected single-column grid below 480px');
    assert.equal(resizeCheck.minWidth, 100, 'Expected .box resizable down to 100px width');
    assert.equal(resizeCheck.minHeight, 100, 'Expected .box resizable down to 100px height');
    assert.equal(resizeCheck.borderRadius, '100%', 'Expected ResizeObserver circle style below 150px');
    assert.ok(resizeCheck.scrollWidth <= resizeCheck.clientWidth, 'Expected max-width: 100% clamp to prevent overflow');

    // 4. Verify flex vertical wrapping at 400% zoom vs horizontal row at 1440px
    await chrome.send('Page.navigate', { url: `${baseUrl}/1-dom/end/index.html` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const card320 = await chrome.evaluate(`(() => {
        const img = document.querySelector('.card__body__image').getBoundingClientRect();
        const content = document.querySelector('.card__body__content').getBoundingClientRect();
        return { wrappedVertically: content.top >= img.bottom - 1 };
    })()`);
    assert.equal(card320.wrappedVertically, true, 'Expected .card__body content to wrap vertically at 320 CSS px');

    await chrome.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const card1440 = await chrome.evaluate(`(() => {
        const img = document.querySelector('.card__body__image').getBoundingClientRect();
        const content = document.querySelector('.card__body__content').getBoundingClientRect();
        return {
            sideBySide: content.left >= img.right - 1,
            scrollOk: document.documentElement.scrollWidth <= document.documentElement.clientWidth
        };
    })()`);
    assert.equal(card1440.sideBySide, true, 'Expected .card__body content side-by-side at 1440px');
    assert.equal(card1440.scrollOk, true);
});
