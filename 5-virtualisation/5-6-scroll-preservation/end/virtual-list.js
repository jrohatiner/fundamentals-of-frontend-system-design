import { intersectionObserver } from "../../../utils/observer.js";

const MARGIN = 16;

const getObservers = () => [
  document.getElementById("top-observer"),
  document.getElementById("bottom-observer"),
];

function getList() {
  return document.getElementById("virtual-list");
}

function getContainer() {
  return document.getElementById("container");
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
    element.setAttribute("data-y", value);
  }
  return element.getAttribute("data-y");
}

export class VirtualList {
  #hasMore = true;
  #isLoading = false;

  get hasMore() {
    return this.#hasMore;
  }

  set hasMore(value) {
    this.#hasMore = Boolean(value);
  }

  get isLoading() {
    return this.#isLoading;
  }

  set isLoading(value) {
    this.#isLoading = Boolean(value);
  }

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
    this.props = { ...props };
    this.start = 0;
    this.end = 0;
    this.root = root;
    this.pool = [];
    this.poolLimit = this.props.pageSize * 2;
    this.#hasMore = true;
    this.#isLoading = false;
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
    this.#effect();
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
                    } else if (id === 'bottom-observer' && this.hasMore) {
                    } else if (id === 'bottom-observer' && this.#hasMore) {
                        void this.#handleBottomObserver().catch(() => {});
                    }
                }
            }
        }
        if (entry.isIntersecting) {
          const id = entry.target.id;
          if (id === "top-observer" && this.start > 0) {
            void this.#handleTopObserver().catch(() => {});
          } else if (id === "bottom-observer" && this.#hasMore) {
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
      {},
    );
  }

  /**
   * Handles Bottom Observer Intersection event
   * @returns Promise<void>
   */
  async #handleBottomObserver() {
    if (!this.#hasMore || this.#isLoading) {
      return;
    }
    this.#isLoading = true;
    try {
      const container = getContainer();
      const list = getList();
      const data = await this.props.getPage(this.end);
      if (!Array.isArray(data) || data.length === 0) {
        this.#hasMore = false;
        const [, bottomObserver] = getObservers();
        if (bottomObserver) {
          this.observer?.unobserve?.(bottomObserver);
        }
        return;
      }
      if (data.length < this.props.pageSize) {
        this.#hasMore = false;
        const [, bottomObserver] = getObservers();
        if (bottomObserver) {
          this.observer?.unobserve?.(bottomObserver);
    /**
     * Handles Bottom Observer Intersection event
     * @returns Promise<void>
     */
    async #handleBottomObserver() {
        if (this.#isLoading || this.isLoading || !this.hasMore) {
        if (!this.#hasMore || this.#isLoading) {
            return;
        }
        this.#isLoading = true;
        this.isLoading = true;
        try {
            const container = getContainer();
            const list = getList();
            const data = await this.props.getPage(this.end);
            if (!Array.isArray(data) || data.length === 0) {
                this.#hasMore = false;
                const [, bottomObserver] = getObservers();
                if (bottomObserver) {
                    this.observer?.unobserve?.(bottomObserver);
                }
                return;
            }
            if (data.length < this.props.pageSize) {
                this.#hasMore = false;
                const [, bottomObserver] = getObservers();
                if (bottomObserver) {
                    this.observer?.unobserve?.(bottomObserver);
                }
                if (this.pool.length >= this.poolLimit) {
                    return;
                }
            }
            this.end++;
            if (this.pool.length < this.poolLimit) {
                const fragment = new DocumentFragment();
                const elements = data.map(datum => this.props.getTemplate(datum))
                elements.forEach(el => fragment.appendChild(el));
                this.pool.push(...elements)
                list.appendChild(fragment);
            } else {
                const [unchanged, recycled] = [
                    this.pool.slice(this.props.pageSize, this.pool.length),
                    this.pool.slice(0, this.props.pageSize)
                ];
                this.#blurActiveInRecycled(recycled);
                this.pool = [].concat(
                    unchanged,
                    recycled
                );
                this.#updateData(recycled, data)
                this.start++;
            }
            this.#updateElement("down");
            container.style.height = `${container.scrollHeight}px`;
        } finally {
            this.#isLoading = false;
        }
        if (this.pool.length >= this.poolLimit) {
          return;
        }
      }
      this.end++;
      if (this.pool.length < this.poolLimit) {
        const fragment = new DocumentFragment();
        const elements = data.map((datum) => this.props.getTemplate(datum));
        elements.forEach((el) => fragment.appendChild(el));
        this.pool.push(...elements);
        list.appendChild(fragment);
      } else {
        const [unchanged, recycled] = [
          this.pool.slice(this.props.pageSize, this.pool.length),
          this.pool.slice(0, this.props.pageSize),
        ];
        this.pool = [].concat(unchanged, recycled);
        this.#updateData(recycled, data);
        this.start++;
      }
      this.#updateElement("down");
      container.style.height = `${container.scrollHeight}px`;
    } finally {
      this.#isLoading = false;
    }
  }

  /**
   * Handles Top Observer Intersection event
   * @returns Promise<void>
   */
  async #handleTopObserver() {
    if (this.start <= 0 || this.#isLoading) {
      return;
    }
    this.#isLoading = true;
    try {
      const data = await this.props.getPage(this.start - 1);
      this.start--;
      const [recycled, unchanged] = [
        this.pool.slice(this.props.pageSize, this.pool.length),
        this.pool.slice(0, this.props.pageSize),
      ];
      this.pool = [].concat(recycled, unchanged);
      this.#updateElement("up");
      this.#updateData(recycled, data);
      this.end--;
      const wasExhausted = !this.#hasMore;
      this.#hasMore = true;
      if (wasExhausted) {
        const [, bottomObserver] = getObservers();
        if (bottomObserver) {
          this.observer?.observe?.(bottomObserver);
    /**
     * Handles Top Observer Intersection event
     * @returns Promise<void>
     */
    async #handleTopObserver() {
        if (this.#isLoading || this.isLoading || this.start <= 0) {
        if (this.start <= 0 || this.#isLoading) {
            return;
        }
        this.#isLoading = true;
        this.isLoading = true;
        try {
            const data = await this.props.getPage(this.start - 1);
            if (!Array.isArray(data) || data.length === 0) {
                return;
            }
            this.start--;
            const [recycled, unchanged] = [
                this.pool.slice(this.props.pageSize, this.pool.length),
                this.pool.slice(0, this.props.pageSize)
            ];
            this.#blurActiveInRecycled(recycled);
            this.pool = [].concat(
                recycled,
                unchanged
            );
            this.#updateElement("up");
            this.#updateData(recycled, data);
            this.end--;
            const wasExhausted = !this.#hasMore;
            this.#hasMore = true;
            if (wasExhausted) {
                const [, bottomObserver] = getObservers();
                if (bottomObserver) {
                    this.observer?.observe?.(bottomObserver);
                }
            }
        } finally {
            this.isLoading = false;
            this.#isLoading = false;
        }
      }
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
    const [topObserver, bottomObserver] = getObservers();
    const yValues = this.pool.map((el) => {
      const currentY = y(el);
      return currentY == null ? null : +currentY;
    });
    const shouldTransform = this.pool.map((el) => Boolean(el.style.transform));
    /**
     * Blurs `document.activeElement` if focus resides on or inside any element
     * being recycled so coordinate updates do not trigger browser focus jumps.
     *
     * @param recycled {HTMLElement[]}
     * @return {void}
     */
    #blurActiveInRecycled(recycled) {
        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        if (!activeElement || typeof activeElement.blur !== 'function') {
            return;
        }
        const containsTarget = (root, target) => {
            if (root === target) {
                return true;
            }
            if (typeof root?.contains === 'function') {
                return root.contains(target);
            }
            if (Array.isArray(root?.children)) {
                return root.children.some((child) => containsTarget(child, target));
            }
            return false;
        };
        if (recycled.some((el) => containsTarget(el, activeElement))) {
            document.activeElement.blur();
        }
    }


    const lastIndex = this.pool.length - 1;
    const recycledStart = this.pool.length - this.props.pageSize;
    const isPoolFull =
      this.pool.length >= this.poolLimit &&
      recycledStart > 0 &&
      yValues[recycledStart - 1] != null;

    const start =
      direction === "down"
        ? isPoolFull
          ? recycledStart
          : 0
        : Math.min(this.props.pageSize - 1, lastIndex);
    const end = direction === "down" ? this.pool.length : 0;

    // Phase 1: Batch DOM geometry reads before any style or attribute mutations
    const heights = new Array(this.pool.length);
    if (direction === "down") {
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
    if (direction === "down") {
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
          yValues[i] = Math.max(
            0,
            yValues[i + 1] - (heights[i + 1] + 2 * MARGIN),
          );
          shouldTransform[i] = true;
        }
      }
    }

    // Phase 3: Batch DOM attribute and transform writes
    if (direction === "down") {
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
    const bottomObserverY =
      yValues[lastIndex] + heights[lastIndex] + MARGIN * 2;
    bottomObserver.style.transform = `translateY(${bottomObserverY}px)`;
  }

  /**
   * @return {void}
   */
  #updateData(elements, data) {
    for (let i = 0; i < elements.length; i++) {
      if (data?.[i] !== undefined) {
        this.props.updateTemplate(elements[i], data[i]);
      }
    }
  }
}
