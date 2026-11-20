import {intersectionObserver} from "../../../utils/observer.js";

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

function getStatus() {
    return document.getElementById('virtual-list-status');
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
    #pendingLoads = 0;
    #setSize = -1;
    #maxKnownItems = 0;

    /**
     * @param root {HTMLElement}
     * @param props {{
     *    getPage: <T>(page: number) => Promise<T[]>,
     *    pageSize: number,
     *    totalItems?: number,
     *    setSize?: number,
     *    getTemplate: (...args:any) => HTMLElement,
     *    updateTemplate: <T>(target: HTMLElement, datum:T, meta?: { posInSet: number, setSize: number }) => void,
     * }}
     */
    constructor(root, props) {
        this.props = {...props};
        this.start = 0;
        this.end = 0;
        this.root = root;
        this.pool = [];
        this.poolLimit = this.props.pageSize * 2;
        this.hasMore = true;
        this.isLoading = false;
        this.observer = null;
        this.#isLoading = false;
        const configuredSize = this.props.setSize ?? this.props.totalItems;
        if (Number.isInteger(configuredSize) && configuredSize > 0) {
            this.#setSize = configuredSize;
        }
    }

    /**
     * Returns an HTML Representation of the component, should have the following structure:
     * #container >
     *    #virtual-list-status+
     *    .top-observer+
     *    #virtual-list+
     *    #bottom-observer
     * @returns {string}
     */
    toHTML() {
        return `<main id="container">
        <div id="virtual-list-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
        <div id="top-observer">Top Observer</div>
        <div id="virtual-list" role="feed" aria-label="Feed" aria-busy="false"></div>
        <div id="bottom-observer">Bottom Observer</div>
        </main>`.trim();
    }

    /**
     * Renders the content to the provided root container and runs
     * any additional side effects
     * @returns void
     */
    render() {
        this.root.innerHTML = this.toHTML();
        const list = getList();
        if (list) {
            if (!list.getAttribute('role')) {
                list.setAttribute('role', 'feed');
            }
            if (!list.getAttribute('aria-label')) {
                list.setAttribute('aria-label', 'Feed');
            }
            if (!list.getAttribute('aria-busy')) {
                list.setAttribute('aria-busy', 'false');
            }
        }
        this.#effect()
    }

    /**
     * Callback implementation for Top and Bottom Intersection observers
     * @return {IntersectionObserverCallback}
     */
    #handleIntersection() {
        return (entries) => {
            if (this.#isLoading || this.isLoading) {
                return;
            }
            for (const entry of entries) {
                if (this.#isLoading || this.isLoading) {
                    return;
                }
                if (entry.isIntersecting) {
                    const id = entry.target.id;
                    if (id === 'top-observer' && this.start > 0) {
                        void this.#handleTopObserver().catch(() => {});
                    } else if (id === 'bottom-observer' && this.hasMore) {
                        void this.#handleBottomObserver().catch(() => {});
                    }
                }
            }
        }
    }

    /**
     * Registers Events / Observers, this function is run after initial render
     * @returns void
     */
    #effect() {
        this.observer?.disconnect?.();
        this.observer = intersectionObserver(
            getObservers(),
            this.#handleIntersection(),
            {}
        );
    }

    /**
     * Handles Bottom Observer Intersection event
     * @returns Promise<void>
     */
    async #handleBottomObserver() {
        if (this.#isLoading || this.isLoading || !this.hasMore) {
            return;
        }
        this.#isLoading = true;
        this.isLoading = true;
        const container = getContainer();
        const list = getList();
        const pageIndex = this.end;
        let busyReleased = false;
        this.#beginLoad(list);
        try {
            const data = await this.props.getPage(pageIndex);
            if (!Array.isArray(data) || data.length === 0) {
                this.hasMore = false;
                const [, bottomObserver] = getObservers();
                if (bottomObserver) {
                    this.observer?.unobserve?.(bottomObserver);
                }
                if (this.#setSize === -1 && this.#maxKnownItems > 0) {
                    this.#setSize = this.#maxKnownItems;
                    this.#syncPoolSetSize();
                }
                return;
            }
            this.end++;
            const basePosInSet = pageIndex * this.props.pageSize + 1;
            const batchEnd = basePosInSet + data.length - 1;
            if (batchEnd > this.#maxKnownItems) {
                this.#maxKnownItems = batchEnd;
            }
            if (this.#setSize === -1 && data.length < this.props.pageSize) {
                this.#setSize = batchEnd;
                this.#syncPoolSetSize();
            }
            const setSize = this.#setSize;
            if (this.pool.length < this.poolLimit) {
                const fragment = new DocumentFragment();
                const elements = data.map((datum, index) => {
                    const posInSet = basePosInSet + index;
                    const el = this.props.getTemplate(datum, { posInSet, setSize });
                    this.#applyItemAria(el, posInSet, setSize);
                    return el;
                });
                elements.forEach(el => fragment.appendChild(el));
                this.pool.push(...elements);
                list.appendChild(fragment);
            } else {
                const [unchanged, recycled] = [
                    this.pool.slice(this.props.pageSize, this.pool.length),
                    this.pool.slice(0, this.props.pageSize)
                ];
                this.pool = [].concat(
                    unchanged,
                    recycled
                );
                this.#updateData(recycled, data, basePosInSet);
                this.start++;
            }
            this.#updateElement("down");
            container.style.height = `${container.scrollHeight}px`;
            this.#endLoad(list);
            busyReleased = true;
            this.#announceStatus(basePosInSet, batchEnd);
        } finally {
            if (!busyReleased) {
                this.#endLoad(list);
            }
            this.isLoading = false;
            this.#isLoading = false;
        }
    }

    /**
     * Handles Top Observer Intersection event
     * @returns Promise<void>
     */
    async #handleTopObserver() {
        if (this.#isLoading || this.isLoading) {
            return;
        }
        this.#isLoading = true;
        this.isLoading = true;
        const list = getList();
        const pageIndex = this.start - 1;
        let busyReleased = false;
        this.#beginLoad(list);
        try {
            const data = await this.props.getPage(pageIndex);
            if (!data?.length) {
                return;
            }
            this.start--;
            const basePosInSet = pageIndex * this.props.pageSize + 1;
            const batchEnd = basePosInSet + data.length - 1;
            const [recycled, unchanged] = [
                this.pool.slice(this.props.pageSize, this.pool.length),
                this.pool.slice(0, this.props.pageSize)
            ];
            this.pool = [].concat(
                recycled,
                unchanged
            );
            this.#updateElement("up");
            this.#updateData(recycled, data, basePosInSet);
            this.end--;
            if (!this.hasMore) {
                this.hasMore = true;
                const [, bottomObserver] = getObservers();
                if (bottomObserver) {
                    this.observer?.observe?.(bottomObserver);
                }
            }
            this.#endLoad(list);
            busyReleased = true;
            this.#announceStatus(basePosInSet, batchEnd);
        } finally {
            if (!busyReleased) {
                this.#endLoad(list);
            }
            this.isLoading = false;
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

        const start = direction === 'down'
            ? (isPoolFull ? recycledStart : 0)
            : Math.min(this.props.pageSize - 1, lastIndex);
        const end = direction === 'down' ? this.pool.length : 0;

        // Phase 1: Batch DOM geometry reads before any style or attribute mutations
        const heights = new Array(this.pool.length);
        if (direction === 'down') {
            for (let i = Math.max(0, start - 1); i < end; i++) {
                heights[i] = this.pool[i].getBoundingClientRect().height;
            }
        } else {
            const measureEnd = Math.min(lastIndex, start + 1);
            for (let i = Math.max(0, end + 1); i <= measureEnd; i++) {
                heights[i] = this.pool[i].getBoundingClientRect().height;
            }
        }
        if (heights[lastIndex] === undefined) {
            heights[lastIndex] = this.pool[lastIndex].getBoundingClientRect().height;
        }

        // Phase 2: Compute target vertical positions in memory
        if (direction === 'down') {
            for (let i = start; i < end; i++) {
                if (i === 0 || yValues[i - 1] == null) {
                    yValues[i] = 0;
                } else {
                    yValues[i] = yValues[i - 1] + (heights[i - 1] + 2 * MARGIN);
                    shouldTransform[i] = true;
                }
            }
        } else {
            for (let i = start; i >= end; i--) {
                if (i + 1 >= this.pool.length || yValues[i + 1] == null) {
                    yValues[i] = 0;
                } else {
                    yValues[i] = Math.max(0, yValues[i + 1] - (heights[i + 1] + 2 * MARGIN));
                    shouldTransform[i] = true;
                }
            }
        }

        // Phase 3: Batch DOM attribute and transform writes
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
            for (let i = start; i >= end; i--) {
                const current = this.pool[i];
                const yPos = yValues[i];
                y(current, yPos);
                if (shouldTransform[i]) {
                    current.style.transform = `translateY(${yPos}px)`;
                }
            }
        }

        topObserver.style.transform = `translateY(${yValues[0]}px)`;
        const bottomObserverY = yValues[lastIndex] + heights[lastIndex] + MARGIN * 2;
        bottomObserver.style.transform = `translateY(${bottomObserverY}px)`;
    }

    /**
     * @param elements {HTMLElement[]}
     * @param data {any[]}
     * @param basePosInSet {number}
     * @return {void}
     */
    #updateData(elements, data, basePosInSet) {
        const count = Math.min(elements.length, data.length);
        const setSize = this.#setSize;
        for (let i = 0; i < count; i++) {
            const posInSet = basePosInSet + i;
            this.props.updateTemplate(elements[i], data[i], { posInSet, setSize });
            this.#applyItemAria(elements[i], posInSet, setSize);
        }
    }

    /**
     * @param element {HTMLElement}
     * @param posInSet {number}
     * @param setSize {number}
     * @return {void}
     */
    #applyItemAria(element, posInSet, setSize) {
        if (!element) {
            return;
        }
        const posValue = String(posInSet);
        const sizeValue = String(setSize);
        if (element.getAttribute('aria-posinset') !== posValue) {
            element.setAttribute('aria-posinset', posValue);
        }
        if (element.getAttribute('aria-setsize') !== sizeValue) {
            element.setAttribute('aria-setsize', sizeValue);
        }
    }

    /**
     * @return {void}
     */
    #syncPoolSetSize() {
        const sizeValue = String(this.#setSize);
        for (let i = 0; i < this.pool.length; i++) {
            const el = this.pool[i];
            if (el && el.getAttribute('aria-setsize') !== sizeValue) {
                el.setAttribute('aria-setsize', sizeValue);
            }
        }
    }

    /**
     * @param list {?HTMLElement}
     * @return {void}
     */
    #beginLoad(list) {
        this.#pendingLoads++;
        if (list) {
            list.setAttribute('aria-busy', 'true');
        }
    }

    /**
     * @param list {?HTMLElement}
     * @return {void}
     */
    #endLoad(list) {
        this.#pendingLoads = Math.max(0, this.#pendingLoads - 1);
        if (this.#pendingLoads === 0 && list) {
            list.setAttribute('aria-busy', 'false');
        }
    }

    /**
     * @param firstPos {number}
     * @param lastPos {number}
     * @return {void}
     */
    #announceStatus(firstPos, lastPos) {
        const status = getStatus();
        if (!status) {
            return;
        }
        const rangeText = firstPos === lastPos
            ? `item ${firstPos}`
            : `items ${firstPos} to ${lastPos}`;
        status.textContent = this.#setSize > 0
            ? `Loaded ${rangeText} of ${this.#setSize}.`
            : `Loaded ${rangeText}.`;
    }

}