import {intersectionObserver} from "../../../utils/observer.js";

const MARGIN = 16;
const OBSERVER_THRESHOLD = 0.25;

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

function getViewportHeight() {
    if (typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0) {
        return window.innerHeight;
    }
    const docEl = typeof document !== 'undefined' ? document.documentElement : null;
    if (docEl && typeof docEl.clientHeight === 'number' && docEl.clientHeight > 0) {
        return docEl.clientHeight;
    }
    return null;
}

function hasLayoutBox(rect) {
    return rect != null && (rect.width > 0 || rect.height > 0);
}

function isIntersectingViewport(rect, viewportHeight, threshold = OBSERVER_THRESHOLD) {
    if (!hasLayoutBox(rect)) {
        return false;
    }
    if (rect.height <= 0) {
        return rect.bottom >= 0 && rect.top <= viewportHeight;
    }
    const visibleTop = Math.max(0, rect.top);
    const visibleBottom = Math.min(viewportHeight, rect.bottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    return (visibleHeight / rect.height) >= threshold;
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
    #isFetching = false;

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
        this.hasMore = true;
        this.isLoading = false;
        this.observer = null;
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
     * Callback implementation for Top and Bottom Intersection observers
     * @return {IntersectionObserverCallback}
     */
    #handleIntersection() {
        return (entries) => {
            if (this.#isFetching || this.isLoading) {
                return;
            }
            for (const entry of entries) {
                if (this.#isFetching || this.isLoading) {
                    return;
                }
                if (entry.isIntersecting) {
                    const id = entry.target.id;
                    if (id === 'top-observer' && this.start > 0) {
                        void this.#handleTopObserver();
                        return;
                    } else if (id === 'bottom-observer' && this.hasMore) {
                        void this.#handleBottomObserver();
                        return;
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
        this.observer?.disconnect();
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
        if (this.#isFetching || this.isLoading || !this.hasMore) {
            return;
        }
        this.#isFetching = true;
        this.isLoading = true;
        let didUpdate = false;
        let failed = false;
        try {
            const container = getContainer();
            const list = getList();
            const page = this.end;
            const data = await this.props.getPage(page);
            if (!Array.isArray(data) || data.length === 0) {
                this.hasMore = false;
                const [, bottomObserver] = getObservers();
                if (bottomObserver) {
                    this.observer?.unobserve?.(bottomObserver);
                }
            } else {
                this.end = page + 1;
                if (this.pool.length < this.poolLimit) {
                    const fragment = new DocumentFragment();
                    const elements = data.map(datum => this.props.getTemplate(datum));
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
                    this.#updateData(recycled, data);
                    this.start++;
                }
                this.#updateElement("down");
                if (container) {
                    container.style.height = `${container.scrollHeight}px`;
                }
                didUpdate = true;
            }
        } catch {
            failed = true;
        } finally {
            this.#isFetching = false;
            this.isLoading = false;
        }
        if (!failed) {
            this.#checkSentinelVisibility(didUpdate ? null : 'bottom-observer');
        }
    }

    /**
     * Handles Top Observer Intersection event
     * @returns Promise<void>
     */
    async #handleTopObserver() {
        if (this.#isFetching || this.isLoading || this.start <= 0) {
            return;
        }
        this.#isFetching = true;
        this.isLoading = true;
        let didUpdate = false;
        let failed = false;
        try {
            const page = this.start - 1;
            const data = await this.props.getPage(page);
            if (data?.length) {
                this.start = page;
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
                if (!this.hasMore) {
                    this.hasMore = true;
                    const [, bottomObserver] = getObservers();
                    if (bottomObserver) {
                        this.observer?.observe?.(bottomObserver);
                    }
                }
                didUpdate = true;
            }
        } catch {
            failed = true;
        } finally {
            this.#isFetching = false;
            this.isLoading = false;
        }
        if (!failed) {
            this.#checkSentinelVisibility(didUpdate ? null : 'top-observer');
        }
    }

    /**
     * Checks sentinel visibility after lock release in case the user remained
     * at or scrolled past the list boundary during an in-flight fetch.
     *
     * @param skipObserverId {?string}
     * @returns {void}
     */
    #checkSentinelVisibility(skipObserverId = null) {
        if (this.#isFetching || this.isLoading || this.pool.length === 0) {
            return;
        }
        const viewportHeight = getViewportHeight();
        if (viewportHeight == null) {
            return;
        }
        const [topObserver, bottomObserver] = getObservers();
        const topRect = topObserver ? topObserver.getBoundingClientRect() : null;
        const bottomRect = bottomObserver ? bottomObserver.getBoundingClientRect() : null;

        const topVisible = isIntersectingViewport(topRect, viewportHeight);
        const bottomVisible = isIntersectingViewport(bottomRect, viewportHeight);

        if (this.pool.length >= this.poolLimit && topVisible && bottomVisible) {
            return;
        }

        const canCheckTop = skipObserverId !== 'top-observer' && this.start > 0 && hasLayoutBox(topRect);
        const canCheckBottom = skipObserverId !== 'bottom-observer' && this.hasMore && hasLayoutBox(bottomRect);

        const atTopBoundary = canCheckTop && topRect.bottom >= topRect.height * OBSERVER_THRESHOLD;
        const atBottomBoundary = canCheckBottom && bottomRect.top <= viewportHeight - bottomRect.height * OBSERVER_THRESHOLD;

        if (atTopBoundary && !atBottomBoundary) {
            void this.#handleTopObserver();
        } else if (atBottomBoundary && !atTopBoundary) {
            void this.#handleBottomObserver();
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
     * @return {void}
     */
    #updateData(elements, data) {
        for (let i = 0; i < elements.length; i++) {
            this.props.updateTemplate(elements[i], data[i]);
        }
    }

}