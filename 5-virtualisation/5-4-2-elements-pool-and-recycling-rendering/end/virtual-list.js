import {intersectionObserver, resizeObserver} from "../../../utils/observer.js";

const MARGIN = 16;

const getObservers = () => [
    document.getElementById('top-observer'),
    document.getElementById('bottom-observer')
]

function getList() {
    return document.getElementById('virtual-list');
}

function getContainer() {
    return document.getElementById('container');
}

/**
 * Computes vertical separation between adjacent cards from computed CSS margins,
 * scaling automatically with root font-size (rem) and custom spacing overrides.
 *
 * @param element {HTMLElement | undefined}
 * @returns {number}
 */
function getVerticalMargin(element) {
    if (typeof getComputedStyle === 'function' && element) {
        const style = getComputedStyle(element);
        const marginTop = parseFloat(style?.marginTop);
        const marginBottom = parseFloat(style?.marginBottom);
        const maxMargin = Math.max(
            Number.isFinite(marginTop) ? marginTop : 0,
            Number.isFinite(marginBottom) ? marginBottom : 0
        );
        if (maxMargin > 0) {
            return maxMargin;
        }
        const root = typeof document !== 'undefined' ? document.documentElement : null;
        if (root) {
            const rootFontSize = parseFloat(getComputedStyle(root)?.fontSize);
            if (Number.isFinite(rootFontSize) && rootFontSize > 0) {
                return 2 * rootFontSize;
            }
        }
    }
    return 2 * MARGIN;
}

/**
 * Returns `data-y` attribute of the HTMLElement, if value is provided
 * additionally updates the attribute
 *
 * @param element {HTMLElement}
 * @param value {string | number}
 * @returns {?string}
 */
function y(element, value = undefined) {
    if (value != null) {
        element?.setAttribute('data-y', value);
    }
    return element?.getAttribute('data-y');
}

export class VirtualList {
    #resizeObserver = null;
    #cardSizes = new WeakMap();
    #rafId = null;

    /**
     * @param root {HTMLElement}
     * @param props {{
     *    getPage: <T>(page: number) => Promise<T[]>,
     *    pageSize: number,
     *    getTemplate: (...args:any) => HTMLElement,
     *    updateTemplate: <T>(target: HTMLElement, datum:T) => void,
     * }}
     */
    constructor(root, props) {
        this.props = {...props};
        this.start = 0;
        this.end = 0;
        this.root = root;
        this.pool = [];
        this.poolLimit = this.props.pageSize * 2;
    }

    /**
     * Returns an HTML Representation of the component, should have the following structure:
     * #container >
     *    .top-observer+
     *    #virtual-list+
     *    #bottom-observer
     * @returns {string}
     */
    toHTML() {
        return `<div id="container">
        <div id="top-observer">Top Observer</div>
        <main id="virtual-list"></main>
        <div id="bottom-observer">Bottom Observer</div>
        </div>`.trim();
    }

    /**
     * Renders the content to the provided root container and runs
     * any additional side effects
     * @returns void
     */
    render() {
        this.root.innerHTML = this.toHTML();
        this.#effect()
    }

    /**
     * Registers Events / Observers, this function is run after initial render
     * @returns void
     */
    #effect() {
        intersectionObserver(
            getObservers(),
            this.#handleIntersection(),
            {}
        );
        this.#resizeObserver = resizeObserver(
            this.pool,
            this.#handleResize()
        );
    }

    /**
     * Callback implementation for pooled card ResizeObserver
     * @return {ResizeObserverCallback}
     */
    #handleResize() {
        return (entries) => {
            let changed = false;
            for (const entry of entries) {
                const borderBox = Array.isArray(entry.borderBoxSize)
                    ? entry.borderBoxSize[0]
                    : entry.borderBoxSize;
                const inlineSize = borderBox?.inlineSize ?? entry.contentRect?.width;
                const blockSize = borderBox?.blockSize ?? entry.contentRect?.height;
                if (typeof blockSize === 'number' && typeof inlineSize === 'number') {
                    const prev = this.#cardSizes.get(entry.target);
                    if (
                        !prev
                        || Math.abs(prev.blockSize - blockSize) > 0.01
                        || Math.abs(prev.inlineSize - inlineSize) > 0.01
                    ) {
                        this.#cardSizes.set(entry.target, { inlineSize, blockSize });
                        changed = true;
                    }
                } else {
                    changed = true;
                }
            }
            if (changed && this.pool.length > 0) {
                this.#scheduleOffsetRecalculation();
            }
        };
    }

    /**
     * Coalesces resize-driven offset recalculation into a single animation frame
     * @return {void}
     */
    #scheduleOffsetRecalculation() {
        if (this.#rafId != null) {
            return;
        }
        const schedule = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (cb) => setTimeout(cb, 0);
        this.#rafId = schedule(() => {
            this.#rafId = null;
            this.#recalculateOffsets();
        });
    }

    /**
     * Recalculates card and observer translateY offsets while batching reads before writes
     * @return {void}
     */
    #recalculateOffsets() {
        if (this.pool.length === 0) {
            return;
        }
        const currentYValues = this.pool.map((el) => {
            const currentY = y(el);
            return currentY == null ? null : +currentY;
        });
        let positionedCount = 0;
        while (positionedCount < this.pool.length && currentYValues[positionedCount] != null) {
            positionedCount++;
        }
        if (positionedCount === 0) {
            return;
        }

        const [topObserver, bottomObserver] = getObservers();

        // Phase 1: Batch all DOM geometry and computed style reads before any writes
        const verticalMargin = getVerticalMargin(this.pool[0]);
        const heights = new Array(positionedCount);
        for (let i = 0; i < positionedCount; i++) {
            const rect = this.pool[i].getBoundingClientRect();
            heights[i] = rect.height;
            this.#cardSizes.set(this.pool[i], { inlineSize: rect.width, blockSize: rect.height });
        }

        // Phase 2: Compute target vertical positions in memory
        const targetY = new Array(positionedCount);
        targetY[0] = this.start === 0 ? 0 : currentYValues[0];
        for (let i = 1; i < positionedCount; i++) {
            targetY[i] = targetY[i - 1] + heights[i - 1] + verticalMargin;
        }
        const lastIdx = positionedCount - 1;
        const bottomObserverY = targetY[lastIdx] + heights[lastIdx] + verticalMargin;

        // Phase 3: Batch DOM attribute and transform writes
        for (let i = 0; i < positionedCount; i++) {
            if (Math.abs(currentYValues[i] - targetY[i]) > 0.01) {
                const current = this.pool[i];
                y(current, targetY[i]);
                current.style.transform = `translateY(${targetY[i]}px)`;
            }
        }
        if (topObserver) {
            topObserver.style.transform = `translateY(${targetY[0]}px)`;
        }
        if (bottomObserver) {
            bottomObserver.style.transform = `translateY(${bottomObserverY}px)`;
        }
    }

    /**
     * Callback implementation for Top and Bottom Intersection observers
     * @return {IntersectionObserverCallback}
     */
    #handleIntersection() {
        return (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const id = entry.target.id;
                    if (id === 'top-observer') {
                        void this.#handleTopObserver()
                    } else if (id === 'bottom-observer') {
                        void this.#handleBottomObserver()
                    }
                }
            }
        }
    }

    /**
     * Handles Top Observer Intersection event
     * @returns Promise<void>
     */
    #handleTopObserver() {
    }

    /**
     * Handles Bottom Observer Intersection event
     * @returns Promise<void>
     */
    async #handleBottomObserver() {
        const [list] = [getList()];
        const data = await this.props.getPage(this.end++);
        if (!data?.length) {
            this.end--;
            return;
        }
        if (this.pool.length < this.poolLimit) {
            const fragment = new DocumentFragment();
            const elements = data.map(datum => this.props.getTemplate(datum));
            elements.forEach(el => fragment.appendChild(el));
            this.pool.push(...elements);
            list.appendChild(fragment);
            elements.forEach(el => this.#resizeObserver?.observe(el));
        } else {
            const [unchanged, recycled] = [
                this.pool.slice(this.props.pageSize, this.pool.length),
                this.pool.slice(0, this.props.pageSize)
            ];
            this.pool = [].concat(
                unchanged,
                recycled
            );
            this.#updateData(recycled, data)
            this.start++;
        }
        this.#updateElement("down");
    }

    /**
     * 1. Recycles elements from top or bottom
     * 2. Updates absolute position of elements and observers
     *
     * @param direction {"up" | "down"}
     * @return {void}
     */
    #updateElement(direction) {
        if (this.pool.length === 0) {
            return;
        }
        const [topObserver, bottomObserver] = getObservers();
        const yValues = this.pool.map((el) => {
            const currentY = y(el);
            return currentY == null ? null : +currentY;
        });
        const shouldTransform = this.pool.map((el) => Boolean(el.style.transform));

        const lastIndex = this.pool.length - 1;
        const recycledStart = this.pool.length - this.props.pageSize;
        const isPoolFull = this.pool.length >= this.poolLimit
            && recycledStart > 0
            && yValues[recycledStart - 1] != null;

        const start = isPoolFull ? recycledStart : 0;
        const end = this.pool.length;

        // Phase 1: Batch DOM geometry reads before any style or attribute mutations
        const verticalMargin = getVerticalMargin(this.pool[0]);
        const heights = new Array(this.pool.length);
        for (let i = Math.max(0, start - 1); i < end; i++) {
            const rect = this.pool[i].getBoundingClientRect();
            heights[i] = rect.height;
            this.#cardSizes.set(this.pool[i], { inlineSize: rect.width, blockSize: rect.height });
        }
        if (heights[lastIndex] === undefined) {
            const rect = this.pool[lastIndex].getBoundingClientRect();
            heights[lastIndex] = rect.height;
            this.#cardSizes.set(this.pool[lastIndex], { inlineSize: rect.width, blockSize: rect.height });
        }

        // Phase 2: Compute target vertical positions in memory
        for (let i = start; i < end; i++) {
            if (i === 0 || yValues[i - 1] == null) {
                yValues[i] = 0;
            } else {
                yValues[i] = yValues[i - 1] + (heights[i - 1] + verticalMargin);
                shouldTransform[i] = true;
            }
        }

        // Phase 3: Batch DOM attribute and transform writes
        for (let i = start; i < end; i++) {
            const current = this.pool[i];
            const yPos = yValues[i];
            y(current, yPos);
            if (shouldTransform[i]) {
                current.style.transform = `translateY(${yPos}px)`;
            }
        }

        topObserver.style.transform = `translateY(${yValues[0]}px)`;
        const bottomObserverY = yValues[lastIndex] + heights[lastIndex] + verticalMargin;
        bottomObserver.style.transform = `translateY(${bottomObserverY}px)`;
    }

    /**
     * @return {void}
     */
    #updateData(elements, data) {
        for (let i = 0; i < elements.length; i++) {
            this.props.updateTemplate(elements[i], data[i]);
        }
    }
}