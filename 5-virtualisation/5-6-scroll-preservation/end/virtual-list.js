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
        if (Number.isFinite(marginTop) || Number.isFinite(marginBottom)) {
            return Math.max(
                Number.isFinite(marginTop) ? marginTop : 0,
                Number.isFinite(marginBottom) ? marginBottom : 0
            );
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
        element.setAttribute('data-y', value);
    }
    return element.getAttribute('data-y');
}

export class VirtualList {
    #isLoading = false;
    #resizeObserver = null;
    #cardSizes = new WeakMap();
    #rafId = null;
    #minContainerHeight = 0;

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
        this.#isLoading = false;
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
        this.#isLoading = false;
        this.#minContainerHeight = 0;
        this.root.innerHTML = this.toHTML();
        this.#effect()
    }

    /**
     * Callback implementation for Top and Bottom Intersection observers
     * @return {IntersectionObserverCallback}
     */
    #handleIntersection() {
        return (entries) => {
            if (this.#isLoading) {
                return;
            }
            for (const entry of entries) {
                if (this.#isLoading) {
                    return;
                }
                if (entry.isIntersecting) {
                    const id = entry.target.id;
                    if (id === 'top-observer' && this.start > 0) {
                        void this.#handleTopObserver().catch(() => {});
                    } else if (id === 'bottom-observer') {
                        void this.#handleBottomObserver().catch(() => {});
                    }
                }
            }
        }
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
     * Recalculates card and observer translateY offsets and grows #container min-height
     * while batching all geometry reads before DOM writes.
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

        const container = getContainer();
        const [topObserver, bottomObserver] = getObservers();

        // Phase 1: Batch all DOM geometry and computed style reads before any writes
        const verticalMargin = getVerticalMargin(this.pool[0]);
        const heights = new Array(positionedCount);
        for (let i = 0; i < positionedCount; i++) {
            const rect = this.pool[i].getBoundingClientRect();
            heights[i] = rect.height;
            this.#cardSizes.set(this.pool[i], { inlineSize: rect.width, blockSize: rect.height });
        }
        const topObserverHeight = topObserver ? topObserver.getBoundingClientRect().height : 0;
        const bottomObserverHeight = bottomObserver ? bottomObserver.getBoundingClientRect().height : 0;

        // Phase 2: Compute target vertical positions in memory
        const targetY = new Array(positionedCount);
        targetY[0] = this.start === 0 ? 0 : currentYValues[0];
        for (let i = 1; i < positionedCount; i++) {
            targetY[i] = targetY[i - 1] + heights[i - 1] + verticalMargin;
        }
        const lastIdx = positionedCount - 1;
        const bottomObserverY = targetY[lastIdx] + heights[lastIdx] + verticalMargin;
        const requiredHeight = topObserverHeight + bottomObserverY + bottomObserverHeight;

        // Phase 3: Batch DOM attribute, transform, and min-height writes
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
        if (container && requiredHeight > this.#minContainerHeight) {
            this.#minContainerHeight = requiredHeight;
            container.style.minHeight = `${this.#minContainerHeight}px`;
        }
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
     * Handles Bottom Observer Intersection event
     * @returns Promise<void>
     */
    async #handleBottomObserver() {
        if (this.#isLoading) {
            return;
        }
        this.#isLoading = true;
        try {
            const list = getList();
            const data = await this.props.getPage(this.end);
            if (!data?.length) {
                return;
            }
            this.end++;
            if (this.pool.length < this.poolLimit) {
                const fragment = new DocumentFragment();
                const elements = data.map(datum => this.props.getTemplate(datum))
                elements.forEach(el => fragment.appendChild(el));
                this.pool.push(...elements)
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
        } finally {
            this.#isLoading = false;
        }
    }

    /**
     * Handles Top Observer Intersection event
     * @returns Promise<void>
     */
    async #handleTopObserver() {
        if (this.#isLoading) {
            return;
        }
        this.#isLoading = true;
        try {
            const data = await this.props.getPage(this.start - 1);
            if (!data?.length) {
                return;
            }
            this.start--;
            const [recycled, unchanged] = [
                this.pool.slice(this.props.pageSize, this.pool.length),
                this.pool.slice(0, this.props.pageSize)
            ];
            this.pool = [].concat(
                recycled,
                unchanged
            );
            this.#updateData(recycled, data);
            this.#updateElement("up");
            this.end--;
        } finally {
            this.#isLoading = false;
        }
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
        const container = getContainer();
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

        let start = direction === 'down'
            ? (isPoolFull ? recycledStart : 0)
            : Math.min(this.props.pageSize - 1, lastIndex);
        let end = direction === 'down' ? this.pool.length : 0;

        // Phase 1: Batch DOM geometry reads before any style or attribute mutations
        const verticalMargin = getVerticalMargin(this.pool[0]);
        const heights = new Array(this.pool.length);
        if (direction === 'down') {
            for (let i = Math.max(0, start - 1); i < end; i++) {
                const rect = this.pool[i].getBoundingClientRect();
                heights[i] = rect.height;
                this.#cardSizes.set(this.pool[i], { inlineSize: rect.width, blockSize: rect.height });
            }
        } else {
            const measureEnd = Math.min(lastIndex, start + 1);
            for (let i = 0; i <= measureEnd; i++) {
                const rect = this.pool[i].getBoundingClientRect();
                heights[i] = rect.height;
                this.#cardSizes.set(this.pool[i], { inlineSize: rect.width, blockSize: rect.height });
            }
        }
        if (heights[lastIndex] === undefined) {
            const rect = this.pool[lastIndex].getBoundingClientRect();
            heights[lastIndex] = rect.height;
            this.#cardSizes.set(this.pool[lastIndex], { inlineSize: rect.width, blockSize: rect.height });
        }
        const topObserverHeight = direction === 'down' && topObserver
            ? topObserver.getBoundingClientRect().height
            : 0;
        const bottomObserverHeight = direction === 'down' && bottomObserver
            ? bottomObserver.getBoundingClientRect().height
            : 0;

        // Phase 2: Compute target vertical positions in memory
        let shiftedAll = false;
        if (direction === 'down') {
            for (let i = start; i < end; i++) {
                if (i === 0 || yValues[i - 1] == null) {
                    yValues[i] = 0;
                } else {
                    yValues[i] = yValues[i - 1] + (heights[i - 1] + verticalMargin);
                    shouldTransform[i] = true;
                }
            }
        } else {
            for (let i = start; i >= end; i--) {
                if (i + 1 >= this.pool.length || yValues[i + 1] == null) {
                    yValues[i] = 0;
                } else {
                    yValues[i] = yValues[i + 1] - (heights[i] + verticalMargin);
                    shouldTransform[i] = true;
                }
            }
            if (yValues[0] < 0) {
                const underflowShift = -yValues[0];
                for (let i = 0; i <= lastIndex; i++) {
                    if (yValues[i] != null) {
                        yValues[i] += underflowShift;
                        shouldTransform[i] = true;
                    }
                }
                shiftedAll = true;
            }
        }

        const bottomObserverY = yValues[lastIndex] + heights[lastIndex] + verticalMargin;
        const requiredHeight = topObserverHeight + bottomObserverY + bottomObserverHeight;

        // Phase 3: Batch DOM attribute, transform, and container min-height writes
        if (direction === 'down') {
            for (let i = start; i < end; i++) {
                const current = this.pool[i];
                const yPos = yValues[i];
                y(current, yPos);
                if (shouldTransform[i]) {
                    current.style.transform = `translateY(${yPos}px)`;
                }
            }
        } else {
            const writeStart = shiftedAll ? lastIndex : start;
            for (let i = writeStart; i >= end; i--) {
                const current = this.pool[i];
                const yPos = yValues[i];
                y(current, yPos);
                if (shouldTransform[i]) {
                    current.style.transform = `translateY(${yPos}px)`;
                }
            }
        }

        topObserver.style.transform = `translateY(${yValues[0]}px)`;
        bottomObserver.style.transform = `translateY(${bottomObserverY}px)`;
        if (direction === 'down' && container && requiredHeight > this.#minContainerHeight) {
            this.#minContainerHeight = requiredHeight;
            container.style.minHeight = `${this.#minContainerHeight}px`;
        }
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