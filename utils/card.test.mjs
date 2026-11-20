import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createCardElement,
    getOrUpdateCardElement,
    normalizeHeadingTag,
    updateCardElement,
} from './card.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function createMockDOMWithTemplate() {
    class MockClassList {
        constructor(owner) {
            this.owner = owner;
        }
        #set() {
            const raw = this.owner.attributes.get('class') ?? '';
            return new Set(raw.split(/\s+/).filter(Boolean));
        }
        contains(token) {
            return this.#set().has(token);
        }
        add(token) {
            const set = this.#set();
            set.add(token);
            this.owner.attributes.set('class', [...set].join(' '));
        }
    }

    class MockNode {
        constructor(tagName, ownerDocument) {
            this.nodeType = 1;
            this.tagName = tagName.toUpperCase();
            this.ownerDocument = ownerDocument;
            this.parentNode = null;
            this.children = [];
            this.attributes = new Map();
            this.textContent = '';
            this.classList = new MockClassList(this);
        }

        get className() {
            return this.attributes.get('class') ?? '';
        }

        set className(val) {
            this.attributes.set('class', String(val));
        }

        get firstElementChild() {
            return this.children[0] ?? null;
        }

        setAttribute(name, value) {
            this.attributes.set(name, String(value));
        }

        getAttribute(name) {
            return this.attributes.has(name) ? this.attributes.get(name) : null;
        }

        hasAttribute(name) {
            return this.attributes.has(name);
        }

        removeAttribute(name) {
            this.attributes.delete(name);
        }

        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        }

        replaceWith(replacement) {
            if (!this.parentNode) {
                return;
            }
            const idx = this.parentNode.children.indexOf(this);
            if (idx !== -1) {
                replacement.parentNode = this.parentNode;
                this.parentNode.children[idx] = replacement;
                this.parentNode = null;
            }
        }

        cloneNode(deep = false) {
            const copy = new MockNode(this.tagName, this.ownerDocument);
            for (const [k, v] of this.attributes.entries()) {
                copy.attributes.set(k, v);
            }
            copy.textContent = this.textContent;
            if (deep) {
                for (const child of this.children) {
                    copy.appendChild(child.cloneNode(true));
                }
            }
            return copy;
        }

        querySelector(selector) {
            const parts = selector.split(',').map((s) => s.trim());
            const matches = (node, sel) => {
                if (sel.startsWith('.')) {
                    return node.classList.contains(sel.slice(1));
                }
                return node.tagName.toLowerCase() === sel.toLowerCase();
            };
            const visit = (root) => {
                for (const child of root.children) {
                    if (parts.some((sel) => matches(child, sel))) {
                        return child;
                    }
                    const found = visit(child);
                    if (found) {
                        return found;
                    }
                }
                return null;
            };
            return visit(this);
        }

        get [Symbol.iterator]() {
            return undefined;
        }
    }

    // Make `attributes` iterable as `{ name, value }` like NamedNodeMap
    Object.defineProperty(MockNode.prototype, 'attributes', {
        configurable: true,
        writable: true,
        value: undefined,
    });

    class AttrMap extends Map {
        *[Symbol.iterator]() {
            for (const [name, value] of super.entries()) {
                yield { name, value };
            }
        }
    }

    const createElement = (doc, tag) => {
        const el = new MockNode(tag, doc);
        el.attributes = new AttrMap();
        doc.createdElements.push(el);
        return el;
    };

    const doc = {
        createdElements: [],
        createElement(tag) {
            return createElement(doc, tag);
        },
        getElementById(id) {
            return id === 'card_template' ? template : null;
        },
    };

    const article = createElement(doc, 'article');
    article.className = 'card';
    const title = createElement(doc, 'h2');
    title.className = 'card__title';
    const body = createElement(doc, 'div');
    body.className = 'card__body';
    const image = createElement(doc, 'div');
    image.className = 'card__body__image';
    image.setAttribute('aria-hidden', 'true');
    const content = createElement(doc, 'section');
    content.className = 'card__body__content';
    content.setAttribute('contenteditable', 'true');

    body.appendChild(image);
    body.appendChild(content);
    article.appendChild(title);
    article.appendChild(body);

    const template = {
        ownerDocument: doc,
        content: {
            firstElementChild: article,
        },
    };

    doc.createdElements.length = 0;
    return { doc, template };
}

function collectHtmlFiles(dir, results = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectHtmlFiles(fullPath, results);
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            results.push(fullPath);
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
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('Could not find a Chrome/Chromium binary.');
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
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'card-a11y-test-'));

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

describe('Shared card template utility (utils/card.js)', () => {
    it('normalizes numeric and tag heading levels with h2 as default', () => {
        assert.equal(normalizeHeadingTag(undefined), 'h2');
        assert.equal(normalizeHeadingTag(null), 'h2');
        assert.equal(normalizeHeadingTag(''), 'h2');
        assert.equal(normalizeHeadingTag(0), 'h2');
        assert.equal(normalizeHeadingTag(7), 'h2');
        assert.equal(normalizeHeadingTag('div'), 'h2');

        for (let level = 1; level <= 6; level++) {
            assert.equal(normalizeHeadingTag(level), `h${level}`);
            assert.equal(normalizeHeadingTag(String(level)), `h${level}`);
            assert.equal(normalizeHeadingTag(`h${level}`), `h${level}`);
            assert.equal(normalizeHeadingTag(`H${level}`), `h${level}`);
        }
    });

    it('renders default h2 heading and aria-hidden decorative avatar while preserving CSS selectors', () => {
        const { doc, template } = createMockDOMWithTemplate();
        globalThis.document = doc;

        const card = createCardElement('System Design Topic', 'Card body copy', { template });
        assert.equal(card.tagName, 'ARTICLE');
        assert.equal(card.className, 'card');

        const heading = card.firstElementChild;
        assert.equal(heading.tagName, 'H2');
        assert.ok(heading.classList.contains('card__title'));
        assert.equal(heading.textContent, 'System Design Topic');

        const image = card.querySelector('.card__body__image');
        assert.equal(image.getAttribute('aria-hidden'), 'true');
        assert.equal(image.getAttribute('role'), null);
        assert.equal(image.getAttribute('aria-label'), null);

        const content = card.querySelector('.card__body__content');
        assert.equal(content.textContent, 'Card body copy');
        assert.equal(content.getAttribute('contenteditable'), 'true');
        assert.equal(doc.createdElements.length, 0, 'Should not allocate extra elements when template already uses h2');
    });

    it('configures custom heading levels and sets role="img" + aria-label when alt is provided', () => {
        const { doc, template } = createMockDOMWithTemplate();
        globalThis.document = doc;

        const card = createCardElement('Architecture Diagram', 'Detailed overview', {
            alt: 'Author avatar for Jane Doe',
            headingLevel: 3,
            template,
        });

        const heading = card.firstElementChild;
        assert.equal(heading.tagName, 'H3');
        assert.ok(heading.classList.contains('card__title'));
        assert.equal(heading.textContent, 'Architecture Diagram');

        const image = card.querySelector('.card__body__image');
        assert.equal(image.getAttribute('role'), 'img');
        assert.equal(image.getAttribute('aria-label'), 'Author avatar for Jane Doe');
        assert.equal(image.hasAttribute('aria-hidden'), false);
    });

    it('treats empty or whitespace-only alt strings as decorative (aria-hidden="true")', () => {
        const { doc, template } = createMockDOMWithTemplate();
        globalThis.document = doc;

        for (const emptyAlt of ['', '   ', null, undefined]) {
            const card = createCardElement('Card Heading', 'Body', {
                alt: emptyAlt,
                template,
            });
            const image = card.querySelector('.card__body__image');
            assert.equal(image.getAttribute('aria-hidden'), 'true');
            assert.equal(image.hasAttribute('role'), false);
            assert.equal(image.hasAttribute('aria-label'), false);
        }
    });

    it('updates recycled VirtualList elements in place across alt and headingLevel transitions', () => {
        const { doc, template } = createMockDOMWithTemplate();
        globalThis.document = doc;

        const card = getOrUpdateCardElement(
            undefined,
            { title: 'Entry 0', body: 'Initial body' },
            { template }
        );
        const image = card.querySelector('.card__body__image');
        assert.equal(image.getAttribute('aria-hidden'), 'true');
        assert.equal(card.firstElementChild.tagName, 'H2');

        // Recycle 1: decorative -> informative avatar, h2 -> h2 (zero heading allocations)
        doc.createdElements.length = 0;
        const recycled1 = updateCardElement(card, {
            title: 'Entry 10',
            body: 'Updated body',
            alt: 'Topic icon for Entry 10',
        });
        assert.equal(recycled1, card, 'Must preserve outer card DOM node reference');
        assert.equal(doc.createdElements.length, 0, 'Must not allocate DOM nodes when heading level stays h2');
        assert.equal(image.getAttribute('role'), 'img');
        assert.equal(image.getAttribute('aria-label'), 'Topic icon for Entry 10');
        assert.equal(image.hasAttribute('aria-hidden'), false);

        // Recycle 2: informative -> decorative avatar, h2 -> h4
        const recycled2 = getOrUpdateCardElement(card, {
            title: 'Entry 20',
            body: 'Third body',
            headingLevel: 'h4',
        });
        assert.equal(recycled2, card);
        assert.equal(card.firstElementChild.tagName, 'H4');
        assert.equal(card.firstElementChild.textContent, 'Entry 20');
        assert.equal(image.getAttribute('aria-hidden'), 'true');
        assert.equal(image.hasAttribute('role'), false);
        assert.equal(image.hasAttribute('aria-label'), false);
    });
});

describe('Exercise HTML templates and live browser accessibility structure', () => {
    it('ensures every exercise HTML file declares an h1 inside main#container and uses h2 + aria-hidden in #card_template', () => {
        const htmlFiles = collectHtmlFiles(REPO_ROOT);
        assert.ok(htmlFiles.length >= 22, `Expected at least 22 exercise HTML files, found ${htmlFiles.length}`);

        for (const filePath of htmlFiles) {
            const rel = path.relative(REPO_ROOT, filePath);
            const html = readFileSync(filePath, 'utf8');

            assert.match(
                html,
                /<main[^>]*id=["']container["'][^>]*>\s*<h1>[^<]+<\/h1>/,
                `Expected ${rel} to contain an <h1> as the first heading inside <main id="container">`
            );

            if (html.includes('<template id="card_template">')) {
                const templateMatch = html.match(/<template id="card_template">([\s\S]*?)<\/template>/);
                assert.ok(templateMatch, `Expected closing </template> in ${rel}`);
                const templateBody = templateMatch[1];
                assert.match(
                    templateBody,
                    /<h2[^>]*><\/h2>/,
                    `Expected #card_template in ${rel} to default to <h2>`
                );
                assert.doesNotMatch(
                    templateBody,
                    /<h3/i,
                    `Expected #card_template in ${rel} not to use <h3>`
                );
                assert.match(
                    templateBody,
                    /card__body__image[^>]*aria-hidden=["']true["']/,
                    `Expected .card__body__image in ${rel} to include aria-hidden="true" by default`
                );
            }
        }
    });

    it('renders unbroken h1 -> h2 heading outlines and accessible card avatars across exercises in Headless Chrome', async (t) => {
        const { server, baseUrl } = await startStaticServer(REPO_ROOT);
        t.after(() => server.close());

        const chrome = await launchHeadlessChrome();
        t.after(async () => {
            await chrome.cleanup();
        });

        await chrome.send('Page.enable');
        await chrome.send('Runtime.enable');

        // 1. Verify 1-dom/end/index.html
        await chrome.send('Page.navigate', { url: `${baseUrl}/1-dom/end/index.html` });
        await waitForCondition(chrome.evaluate, `document.querySelectorAll('#container .card').length === 1`);
        const domCheck = await chrome.evaluate(`
            (() => {
                const headings = [...document.querySelectorAll('main#container h1, main#container h2, main#container h3, main#container h4')].map((el) => ({
                    tag: el.tagName,
                    text: el.textContent.trim(),
                }));
                const img = document.querySelector('.card__body__image');
                return {
                    headings,
                    ariaHidden: img.getAttribute('aria-hidden'),
                    role: img.getAttribute('role'),
                };
            })()
        `);
        assert.deepEqual(domCheck.headings, [
            { tag: 'H1', text: 'Frontend System Design Fundamentals' },
            { tag: 'H2', text: 'Frontend System Design: Fundamentals' },
        ]);
        assert.equal(domCheck.ariaHidden, 'true');
        assert.equal(domCheck.role, null);

        // 2. Verify 2-intersection-observer/end/index.html
        await chrome.send('Page.navigate', { url: `${baseUrl}/2-intersection-observer/end/index.html` });
        await waitForCondition(chrome.evaluate, `document.querySelectorAll('#list .card').length === 10`);
        const ioCheck = await chrome.evaluate(`
            (() => {
                const h1 = document.querySelector('main#container > h1');
                const cardHeadings = [...document.querySelectorAll('#list .card > h2.card__title')];
                const decorativeImages = [...document.querySelectorAll('#list .card .card__body__image[aria-hidden="true"]')];
                return {
                    h1Text: h1?.textContent?.trim(),
                    cardH2Count: cardHeadings.length,
                    firstCardTitle: cardHeadings[0]?.textContent,
                    decorativeCount: decorativeImages.length,
                };
            })()
        `);
        assert.equal(ioCheck.h1Text, 'Frontend System Design Fundamentals');
        assert.equal(ioCheck.cardH2Count, 10);
        assert.ok(ioCheck.firstCardTitle.includes('Fundamentals of Frontend System Design'));
        assert.equal(ioCheck.decorativeCount, 10);

        // 3. Verify 5-virtualisation/5-6-scroll-preservation/end/index.html including pool recycling + dynamic alt
        await chrome.send('Page.navigate', {
            url: `${baseUrl}/5-virtualisation/5-6-scroll-preservation/end/index.html`,
        });
        await waitForCondition(chrome.evaluate, `document.querySelectorAll('#virtual-list .card').length === 10`);

        // Scroll to trigger second page (pool reaches 20) and third page (recycles 10 elements)
        await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
        await waitForCondition(chrome.evaluate, `document.querySelectorAll('#virtual-list .card').length === 20`);
        await chrome.evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
        await waitForCondition(
            chrome.evaluate,
            `[...document.querySelectorAll('#virtual-list .card .card__title')].some((el) => el.textContent.includes('[Entry 25]'))`
        );

        const virtualCheck = await chrome.evaluate(`
            (async () => {
                const { createCardElement, updateCardElement } = await import('/utils/card.js');
                const mainCount = document.querySelectorAll('main').length;
                const h1 = document.querySelector('main#container > h1');
                const allHeadings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => h.tagName);

                // Exercise dynamic alt + custom headingLevel in real browser DOM
                const customCard = createCardElement('Accessible Avatar Card', 'Body text', {
                    alt: 'Speaker portrait',
                    headingLevel: 3,
                });
                const customImg = customCard.querySelector('.card__body__image');
                const beforeRecycle = {
                    headingTag: customCard.firstElementChild.tagName,
                    role: customImg.getAttribute('role'),
                    ariaLabel: customImg.getAttribute('aria-label'),
                    ariaHidden: customImg.getAttribute('aria-hidden'),
                };

                updateCardElement(customCard, { title: 'Recycled Decorative Card', body: 'Updated' });
                const afterRecycle = {
                    headingTag: customCard.firstElementChild.tagName,
                    role: customImg.getAttribute('role'),
                    ariaLabel: customImg.getAttribute('aria-label'),
                    ariaHidden: customImg.getAttribute('aria-hidden'),
                };

                return {
                    mainCount,
                    h1Text: h1?.textContent?.trim(),
                    firstHeadingTag: allHeadings[0],
                    cardHeadingTagsUnique: [...new Set(allHeadings.slice(1))],
                    totalCardsMounted: document.querySelectorAll('#virtual-list .card').length,
                    beforeRecycle,
                    afterRecycle,
                };
            })()
        `);

        assert.equal(virtualCheck.mainCount, 1, 'Expected exactly one <main> landmark');
        assert.equal(virtualCheck.h1Text, 'Virtualisation');
        assert.equal(virtualCheck.firstHeadingTag, 'H1');
        assert.deepEqual(virtualCheck.cardHeadingTagsUnique, ['H2']);
        assert.equal(virtualCheck.totalCardsMounted, 20);
        assert.deepEqual(virtualCheck.beforeRecycle, {
            headingTag: 'H3',
            role: 'img',
            ariaLabel: 'Speaker portrait',
            ariaHidden: null,
        });
        assert.deepEqual(virtualCheck.afterRecycle, {
            headingTag: 'H2',
            role: null,
            ariaLabel: null,
            ariaHidden: 'true',
        });
    });
});
