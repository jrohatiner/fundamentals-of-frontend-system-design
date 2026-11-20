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
    #clearStatusTimer = null;

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
        this.#isLoading = false;
    }

    /**
     * Returns an HTML Representation of the component, should have the following structure:
     * #container >
     *    #virtual-list-status.sr-only+
     *    #top-observer[aria-hidden="true"]+
     *    #virtual-list+
     *    #bottom-observer[aria-hidden="true"]
     * @returns {string}
     */
    toHTML() {
        return `<div id="container">
        <div id="virtual-list-status" class="sr-only" role="status" aria-live="polite"></div>
        <div id="top-observer" aria-hidden="true">Top Observer</div>
        <main id="virtual-list"></main>
        <div id="bottom-observer" aria-hidden="true">Bottom Observer</div>
        </div>`.trim();
    }

    /**
     * Renders the content to the provided root container and runs
     * any additional side effects
     * @returns void
     */
    render() {
        if (this.#clearStatusTimer !== null) {
            clearTimeout(this.#clearStatusTimer);
            this.#clearStatusTimer = null;
        }
        this.hasMore = true;
        this.isLoading = false;
        this.#isLoading = false;
        this.root.innerHTML = this.toHTML();
        this.#effect();
    }

    /**
     * @param message {string}
     * @returns {void}
     */
    #updateStatus(message) {
        const status = getStatus();
        if (!status) {
            return;
        }
        if (this.#clearStatusTimer !== null) {
            clearTimeout(this.#clearStatusTimer);
            this.#clearStatusTimer = null;
        }
        status.textContent = message;
    }

    /**
     * @param delayMs {number}
     * @returns {void}
     */
    #scheduleStatusClear(delayMs = 1500) {
        const status = getStatus();
        if (!status) {
            return;
        }
        if (this.#clearStatusTimer !== null) {
            clearTimeout(this.#clearStatusTimer);
        }
        this.#clearStatusTimer = setTimeout(() => {
            this.#clearStatusTimer = null;
            if (!this.#isLoading) {
                const currentStatus = getStatus();
                if (currentStatus) {
                    currentStatus.textContent = '';
                }
            }
        }, delayMs);
        this.#clearStatusTimer?.unref?.();
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
        };
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
        if (this.#isLoading || this.isLoading || !this.hasMore) {
            return;
        }
        this.#isLoading = true;
        this.isLoading = true;
        this.#updateStatus('Loading more items...');
        try {
            const container = getContainer();
            const list = getList();
            const data = await this.props.getPage(this.end);
            if (!Array.isArray(data) || data.length === 0) {
                this.hasMore = false;
                const [, bottomObserver] = getObservers();
                if (bottomObserver) {
                    this.observer?.unobserve?.(bottomObserver);
                }
                this.#updateStatus('');
                return;
            }
            this.end++;
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
            container.style.height = `${container.scrollHeight}px`;
            this.#updateStatus(`Loaded ${data.length} items.`);
            this.#scheduleStatusClear();
        } catch (error) {
            this.#updateStatus('');
            throw error;
        } finally {
            this.isLoading = false;
            this.#isLoading = false;
        }
    }

    /**
     * Handles Top Observer Intersection event
     * @returns Promise<void>
     */
    async #handleTopObserver() {
        if (this.#isLoading || this.isLoading || this.start <= 0) {
            return;
        }
        this.#isLoading = true;
        this.isLoading = true;
        this.#updateStatus('Loading previous items...');
        try {
            const data = await this.props.getPage(this.start - 1);
            if (!Array.isArray(data) || data.length === 0) {
                this.#updateStatus('');
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
            this.#updateElement("up");
            this.#updateData(recycled, data);
            this.end--;
            this.#updateStatus(`Loaded ${data.length} previous items.`);
            this.#scheduleStatusClear();
        } catch (error) {
            this.#updateStatus('');
            throw error;
        } finally {
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
     * @return {void}
     */
    #updateData(elements, data) {
        for (let i = 0; i < elements.length; i++) {
            this.props.updateTemplate(elements[i], data[i]);
        }
    }

}