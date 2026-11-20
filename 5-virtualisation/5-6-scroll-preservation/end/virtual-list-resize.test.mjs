import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resizeObserver } from "../../../utils/observer.js";
import { VirtualList as VirtualList56 } from "./virtual-list.js";
import { VirtualList as VirtualList55 } from "../../5-5-top-observer/end/virtual-list.js";
import { VirtualList as VirtualList542 } from "../../5-4-2-elements-pool-and-recycling-rendering/end/virtual-list.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function createResizeHarness({ initialMarginPx = 32, initialCardHeight = 200 } = {}) {
    let marginPx = initialMarginPx;
    let intersectionCallback = null;
    let resizeCallback = null;
    let resizeObserverInstances = 0;
    const observedResizeTargets = [];
    const rafQueue = [];

    const metrics = {
        layoutDirty: false,
        layoutCalculations: 0,
        readsAfterWriteInPhase: 0,
        wroteInCurrentUpdate: false,
    };

    const elementsById = new Map();

    class MockStyle {
        #transform = "";
        #minHeight = "";
        #height = "";

        get transform() {
            return this.#transform;
        }
        set transform(val) {
            this.#transform = String(val);
            metrics.layoutDirty = true;
            metrics.wroteInCurrentUpdate = true;
        }
        get minHeight() {
            return this.#minHeight;
        }
        set minHeight(val) {
            this.#minHeight = String(val);
            metrics.layoutDirty = true;
            metrics.wroteInCurrentUpdate = true;
        }
        get height() {
            return this.#height;
        }
        set height(val) {
            this.#height = String(val);
            metrics.layoutDirty = true;
            metrics.wroteInCurrentUpdate = true;
        }
    }

    class MockElement {
        constructor(tagName = "div", id = "") {
            this.tagName = tagName.toUpperCase();
            this.id = id;
            this.nodeType = 1;
            this.attributes = new Map();
            this.children = [];
            this.style = new MockStyle();
            this._height = initialCardHeight;
            this._width = 800;
            this.textContent = "";
        }

        set innerHTML(html) {
            this.children = [];
            elementsById.clear();
            if (html.includes('id="container"')) {
                const container = new MockElement("div", "container");
                const topObserver = new MockElement("div", "top-observer");
                const list = new MockElement("main", "virtual-list");
                const bottomObserver = new MockElement("div", "bottom-observer");
                topObserver._height = 100;
                bottomObserver._height = 100;
                container.appendChild(topObserver);
                container.appendChild(list);
                container.appendChild(bottomObserver);
                this.appendChild(container);
                elementsById.set("container", container);
                elementsById.set("top-observer", topObserver);
                elementsById.set("virtual-list", list);
                elementsById.set("bottom-observer", bottomObserver);
            }
            metrics.layoutDirty = true;
        }

        setAttribute(name, value) {
            this.attributes.set(name, String(value));
            if (name === "data-y") {
                metrics.wroteInCurrentUpdate = true;
            }
        }

        getAttribute(name) {
            return this.attributes.has(name) ? this.attributes.get(name) : null;
        }

        appendChild(child) {
            if (child instanceof MockDocumentFragment) {
                this.children.push(...child.children);
                child.children = [];
            } else {
                this.children.push(child);
            }
            metrics.layoutDirty = true;
            return child;
        }

        getBoundingClientRect() {
            if (metrics.wroteInCurrentUpdate) {
                metrics.readsAfterWriteInPhase++;
            }
            if (metrics.layoutDirty) {
                metrics.layoutCalculations++;
                metrics.layoutDirty = false;
            }
            const yAttr = this.getAttribute("data-y");
            const top = yAttr == null ? 0 : +yAttr;
            return {
                top,
                y: top,
                bottom: top + this._height,
                height: this._height,
                width: this._width,
                left: 0,
                right: this._width,
                x: 0,
            };
        }
    }

    class MockDocumentFragment {
        constructor() {
            this.children = [];
        }
        appendChild(child) {
            this.children.push(child);
            return child;
        }
    }

    globalThis.DocumentFragment = MockDocumentFragment;
    globalThis.document = {
        body: new MockElement("body", "body"),
        getElementById(id) {
            return elementsById.get(id) ?? null;
        },
    };
    globalThis.getComputedStyle = () => {
        if (metrics.wroteInCurrentUpdate) {
            metrics.readsAfterWriteInPhase++;
        }
        return {
            marginTop: `${marginPx}px`,
            marginBottom: `${marginPx}px`,
        };
    };
    globalThis.IntersectionObserver = class {
        constructor(cb) {
            intersectionCallback = cb;
        }
        observe() {}
        disconnect() {}
    };
    globalThis.ResizeObserver = class {
        constructor(cb) {
            resizeObserverInstances++;
            resizeCallback = cb;
        }
        observe(target) {
            observedResizeTargets.push(target);
        }
        unobserve() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (cb) => {
        rafQueue.push(cb);
        return rafQueue.length;
    };

    const resetPhaseMetrics = () => {
        metrics.layoutDirty = true;
        metrics.layoutCalculations = 0;
        metrics.readsAfterWriteInPhase = 0;
        metrics.wroteInCurrentUpdate = false;
    };

    const flushAnimationFrames = () => {
        resetPhaseMetrics();
        const callbacks = rafQueue.splice(0, rafQueue.length);
        for (const cb of callbacks) {
            cb(16.67);
        }
        return callbacks.length;
    };

    const triggerScroll = async (direction) => {
        const target = elementsById.get(direction === "down" ? "bottom-observer" : "top-observer");
        intersectionCallback([{ isIntersecting: true, target }]);
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const notifyResize = (entries) => {
        resizeCallback(
            entries.map(({ target, width = target._width, height = target._height }) => ({
                target,
                borderBoxSize: [{ inlineSize: width, blockSize: height }],
                contentRect: { width, height },
            }))
        );
    };

    return {
        MockElement,
        elementsById,
        metrics,
        getResizeStats: () => ({
            instances: resizeObserverInstances,
            observedCount: observedResizeTargets.length,
            pendingRafs: rafQueue.length,
        }),
        setMarginPx: (val) => {
            marginPx = val;
            metrics.layoutDirty = true;
        },
        flushAnimationFrames,
        triggerScroll,
        notifyResize,
    };
}

describe("utils/observer.js resizeObserver helper", () => {
    it("returns a safe no-op observer when ResizeObserver is unavailable and observes valid targets when available", () => {
        const prevRO = globalThis.ResizeObserver;
        try {
            delete globalThis.ResizeObserver;
            const fallback = resizeObserver([{ nodeType: 1 }], () => {});
            assert.equal(typeof fallback.observe, "function");
            assert.equal(typeof fallback.unobserve, "function");
            assert.equal(typeof fallback.disconnect, "function");
            fallback.observe({});

            const observed = [];
            globalThis.ResizeObserver = class {
                constructor(cb) {
                    this.cb = cb;
                }
                observe(el, opts) {
                    observed.push({ el, opts });
                }
            };
            const validA = { nodeType: 1 };
            const validB = { nodeType: 1 };
            resizeObserver([null, "invalid", validA, validB], () => {}, { box: "border-box" });
            assert.equal(observed.length, 2);
            assert.equal(observed[0].el, validA);
            assert.deepEqual(observed[0].opts, { box: "border-box" });
        } finally {
            globalThis.ResizeObserver = prevRO;
        }
    });
});

describe("VirtualList dynamic ResizeObserver offset recalculation", () => {
    it("recalculates card/observer offsets, scales rem margins, and grows #container min-height in one rAF without layout thrashing", async () => {
        const env = createResizeHarness({ initialMarginPx: 32, initialCardHeight: 200 });
        const pages = Array.from({ length: 5 }, (_, p) =>
            Array.from({ length: 5 }, (__, i) => ({ id: p * 5 + i, title: `[Entry ${p * 5 + i}]` }))
        );

        const list = new VirtualList56(globalThis.document.body, {
            getPage: async (p) => pages[p] ?? [],
            getTemplate: (datum) => {
                const el = new env.MockElement("article");
                el.textContent = datum.title;
                return el;
            },
            updateTemplate: (el, datum) => {
                el.textContent = datum.title;
            },
            pageSize: 5,
        });
        list.render();

        await env.triggerScroll("down"); // Page 0 (0..4)
        await env.triggerScroll("down"); // Page 1 (0..9, pool full at 10)
        await env.triggerScroll("down"); // Page 2 (recycled -> pool holds 5..14, start = 1)

        const statsAfterRecycle = env.getResizeStats();
        assert.equal(statsAfterRecycle.instances, 1, "Should create exactly one shared ResizeObserver");
        assert.equal(statsAfterRecycle.observedCount, 10, "Should observe each pooled card once");

        const container = env.elementsById.get("container");
        const bottomObserver = env.elementsById.get("bottom-observer");
        const initialMinHeight = parseFloat(container.style.minHeight);
        assert.ok(initialMinHeight > 0, "Should set initial #container min-height");

        // Simulate 200% font scaling: margin 2rem -> 64px, card heights -> 360px across multiple resize callbacks in same frame
        env.setMarginPx(64);
        for (const card of list.pool) {
            card._height = 360;
        }
        env.notifyResize(list.pool.slice(0, 5).map((target) => ({ target })));
        env.notifyResize(list.pool.slice(5).map((target) => ({ target })));
        assert.equal(env.getResizeStats().pendingRafs, 1, "Multiple resize callbacks in one frame must coalesce into 1 rAF");

        const anchorY = +list.pool[0].getAttribute("data-y");
        const executedFrames = env.flushAnimationFrames();
        assert.equal(executedFrames, 1);
        assert.equal(env.metrics.layoutCalculations, 1, "rAF recalculation should perform exactly 1 layout read pass");
        assert.equal(env.metrics.readsAfterWriteInPhase, 0, "rAF recalculation must perform 0 geometry reads after writes");

        // Verify start > 0 preserves pool[0] anchor and spaces every subsequent card by 360 + 64 = 424
        const expectedStride = 360 + 64;
        for (let i = 0; i < list.pool.length; i++) {
            assert.equal(+list.pool[i].getAttribute("data-y"), anchorY + i * expectedStride);
        }
        assert.equal(
            bottomObserver.style.transform,
            `translateY(${anchorY + list.pool.length * expectedStride}px)`
        );
        assert.ok(
            parseFloat(container.style.minHeight) > initialMinHeight,
            "Expanding cards must grow #container min-height"
        );
    });

    it("propagates shared ResizeObserver offset recalculation across 5-4-2/end and 5-5/end", async () => {
        for (const ListClass of [VirtualList542, VirtualList55]) {
            const env = createResizeHarness({ initialMarginPx: 32, initialCardHeight: 180 });
            const pages = [
                Array.from({ length: 4 }, (_, i) => ({ title: `Item ${i}` })),
                Array.from({ length: 4 }, (_, i) => ({ title: `Item ${i + 4}` })),
            ];
            const list = new ListClass(globalThis.document.body, {
                getPage: async (p) => pages[p] ?? [],
                getTemplate: (d) => {
                    const el = new env.MockElement("article");
                    el.textContent = d.title;
                    return el;
                },
                updateTemplate: (el, d) => {
                    el.textContent = d.title;
                },
                pageSize: 4,
            });
            list.render();
            await env.triggerScroll("down");
            await env.triggerScroll("down");

            // Expand card 2 from 180px to 500px
            list.pool[2]._height = 500;
            env.notifyResize([{ target: list.pool[2] }]);
            env.flushAnimationFrames();

            assert.equal(env.metrics.readsAfterWriteInPhase, 0);
            for (let i = 0; i < list.pool.length - 1; i++) {
                const bottomA = +list.pool[i].getAttribute("data-y") + list.pool[i]._height;
                const topB = +list.pool[i + 1].getAttribute("data-y");
                assert.equal(topB - bottomA, 32, "Adjacent cards must maintain exact non-overlapping margin separation");
            }
        }
    });
});

function findChromeBinary() {
    const candidates = [
        process.env.CHROME_BIN,
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].filter(Boolean);
    return candidates.find((c) => existsSync(c)) ?? null;
}

describe("Browser integration: ResizeObserver text scaling, text spacing, and focus visibility", () => {
    it("prevents card overlap at 200% zoom + 1.4.12 spacing, keeps focused [Entry 20] unobstructed after 25-line edit in [Entry 19], and keeps 5-4-2/begin in normal flow", async (t) => {
        const chromeBin = findChromeBinary();
        if (!chromeBin) {
            t.skip("No Chrome/Chromium binary found");
            return;
        }

        const mimeTypes = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        };
        const server = http.createServer((req, res) => {
            const urlPath = new URL(req.url, "http://127.0.0.1").pathname;
            const filePath = path.resolve(REPO_ROOT, `.${urlPath}`);
            if (!filePath.startsWith(REPO_ROOT) || !existsSync(filePath)) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }
            const ext = path.extname(filePath);
            res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "application/octet-stream" });
            res.end(readFileSync(filePath));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        t.after(() => server.close());
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        const userDataDir = mkdtempSync(path.join(os.tmpdir(), "virtual-list-resize-cdp-"));
        const proc = spawn(
            chromeBin,
            [
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--no-first-run",
                `--user-data-dir=${userDataDir}`,
                "--window-size=1280,800",
                "--remote-debugging-port=0",
                "about:blank",
            ],
            { stdio: ["ignore", "ignore", "pipe"] }
        );
        t.after(async () => {
            if (proc.exitCode === null) {
                proc.kill("SIGKILL");
                await new Promise((resolve) => proc.once("exit", resolve));
            }
            rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        });

        const debugPort = await new Promise((resolve, reject) => {
            let stderr = "";
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for DevTools: ${stderr}`)), 10_000);
            proc.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
                const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
                if (match) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                }
            });
        });

        const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        const pageTarget = targets.find((x) => x.type === "page");
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve, { once: true });
            ws.addEventListener("error", reject, { once: true });
        });
        t.after(() => {
            try {
                ws.close();
            } catch {}
        });

        let msgId = 1;
        const pending = new Map();
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            }
        });
        const send = (method, params = {}) =>
            new Promise((resolve, reject) => {
                const id = msgId++;
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method, params }));
            });
        const evaluate = async (expression) => {
            const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
            if (res.exceptionDetails) {
                throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
            }
            return res.result.value;
        };
        const waitFor = async (expr, timeout = 8000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                if (await evaluate(`Boolean(${expr})`)) return;
                await new Promise((r) => setTimeout(r, 30));
            }
            throw new Error(`Timed out waiting for: ${expr}`);
        };
        const waitTwoFrames = () =>
            evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);

        await send("Page.enable");
        await send("Runtime.enable");
        await send("Page.addScriptToEvaluateOnNewDocument", {
            source: `(() => {
                const orig = window.setTimeout.bind(window);
                window.setTimeout = (fn, delay, ...args) => orig(fn, typeof delay === 'number' && delay >= 900 ? 15 : delay, ...args);
            })();`,
        });

        // 1) Check 5-4-2/begin starter keeps unpositioned cards in normal flow with opaque Canvas surface
        await send("Page.navigate", {
            url: `${baseUrl}/5-virtualisation/5-4-2-elements-pool-and-recycling-rendering/begin/index.html`,
        });
        await waitFor(`document.querySelectorAll('.card').length === 10`);
        await waitTwoFrames();
        const beginCheck = await evaluate(`(() => {
            const cards = [...document.querySelectorAll('.card')];
            const style0 = getComputedStyle(cards[0]);
            let overlaps = 0;
            for (let i = 0; i < cards.length - 1; i++) {
                if (cards[i].getBoundingClientRect().bottom - cards[i + 1].getBoundingClientRect().top > 0.5) overlaps++;
            }
            return {
                position: style0.position,
                bg: style0.backgroundColor,
                hasDataY: cards.some(c => c.hasAttribute('data-y')),
                overlaps
            };
        })()`);
        assert.equal(beginCheck.position, "static");
        assert.equal(beginCheck.hasDataY, false);
        assert.notEqual(beginCheck.bg, "rgba(0, 0, 0, 0)");
        assert.equal(beginCheck.overlaps, 0);

        // 2) Check 5-6/end 200% font scaling + 1.4.12 text spacing at 320x800 and 25-line edit + focus hit test
        await send("Page.navigate", {
            url: `${baseUrl}/5-virtualisation/5-6-scroll-preservation/end/index.html`,
        });
        await waitFor(`document.querySelectorAll('.card[data-y]').length === 10`);
        await waitTwoFrames();
        await evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
        await waitFor(`document.querySelectorAll('.card[data-y]').length === 20`);
        await waitTwoFrames();
        await evaluate(`document.getElementById('bottom-observer').scrollIntoView()`);
        await waitFor(`[...document.querySelectorAll('.card h3')].some(h => h.textContent.includes('[Entry 20]'))`);
        await waitTwoFrames();

        // Type 25 lines in [Entry 19] and focus [Entry 20]
        const focusResult = await evaluate(`(async () => {
            const card19 = [...document.querySelectorAll('.card')].find(c => c.querySelector('h3').textContent.includes('[Entry 19]'));
            const card20 = [...document.querySelectorAll('.card')].find(c => c.querySelector('h3').textContent.includes('[Entry 20]'));
            const editor19 = card19.querySelector('.card__body__content');
            const editor20 = card20.querySelector('.card__body__content');
            editor19.textContent = Array.from({ length: 25 }, (_, i) => 'Line ' + (i + 1)).join('\\n');
            editor19.style.whiteSpace = 'pre-wrap';
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
            card20.scrollIntoView({ block: 'center' });
            editor20.focus();
            const r19 = card19.getBoundingClientRect();
            const r20 = card20.getBoundingClientRect();
            const er20 = editor20.getBoundingClientRect();
            const hit = document.elementFromPoint(er20.left + er20.width / 2, er20.top + er20.height / 2);
            return {
                overlapPx: r19.bottom - r20.top,
                hitEditor: hit === editor20 || editor20.contains(hit),
                zIndex: getComputedStyle(card20).zIndex
            };
        })()`);
        assert.ok(focusResult.overlapPx <= 0, `Expected [Entry 20] below [Entry 19], got overlap ${focusResult.overlapPx}`);
        assert.equal(focusResult.hitEditor, true);
        assert.equal(focusResult.zIndex, "1");

        // Apply 200% font-size + 1.4.12 text spacing at 320x800 mobile viewport
        await send("Emulation.setDeviceMetricsOverride", {
            width: 320,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false,
        });
        const spacingOverlap = await evaluate(`(async () => {
            document.documentElement.style.fontSize = '200%';
            const s = document.createElement('style');
            s.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p, h3 { margin-bottom: 2em !important; }';
            document.head.appendChild(s);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
            const cards = [...document.querySelectorAll('.card')].sort((a, b) => +a.dataset.y - +b.dataset.y);
            let overlaps = 0;
            for (let i = 0; i < cards.length - 1; i++) {
                if (cards[i].getBoundingClientRect().bottom - cards[i + 1].getBoundingClientRect().top > 0.5) overlaps++;
            }
            return overlaps;
        })()`);
        assert.equal(spacingOverlap, 0);
    });
});

