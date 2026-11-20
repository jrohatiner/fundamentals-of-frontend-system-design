import { intersectionObserver } from "../../../utils/observer.js";
import { MARGIN, getList, y } from "../../../utils/virtual-list-helpers.js";

const getObservers = () => [
  document.getElementById("top-observer"),
  document.getElementById("bottom-observer"),
];

function getContainer() {
  return document.getElementById("container");
}

function getStatus() {
  return document.getElementById("virtual-list-status");
}

function syncContainerHeight(container) {
  if (!container) {
    return;
  }
  container.style.height = "";
  container.style.height = `${container.scrollHeight}px`;
}

function adjustWindowScroll(scrollDelta) {
  if (!scrollDelta || typeof window === "undefined") {
    return;
  }
  if (typeof window.scrollBy === "function") {
    window.scrollBy(0, scrollDelta);
  } else if (typeof window.scrollTo === "function") {
    window.scrollTo(window.scrollX ?? 0, (window.scrollY ?? 0) + scrollDelta);
  }
}

export class VirtualList {
  #hasMore = true;
  #isLoading = false;
  #pendingLoads = 0;
  #setSize = -1;
  #maxKnownItems = 0;
  #onScroll = null;

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
   *    totalItems?: number,
   *    setSize?: number,
   *    getTemplate: (...args:any) => HTMLElement,
   *    updateTemplate: <T>(target: HTMLElement, datum:T, meta?: { posInSet: number, setSize: number }) => void,
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
      if (!list.getAttribute("role")) {
        list.setAttribute("role", "feed");
      }
      if (!list.getAttribute("aria-label")) {
        list.setAttribute("aria-label", "Feed");
      }
      if (!list.getAttribute("aria-busy")) {
        list.setAttribute("aria-busy", "false");
      }
    }
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
    this.observer?.disconnect?.();
    this.observer = intersectionObserver(
      getObservers(),
      this.#handleIntersection(),
      {},
    );
    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      if (this.#onScroll && typeof window.removeEventListener === "function") {
        window.removeEventListener("scroll", this.#onScroll);
      }
      this.#onScroll = () => {
        if (this.start > 0 && !this.#isLoading && this.pool.length > 0) {
          const topY = +(y(this.pool[0]) ?? 0);
          if ((window.scrollY ?? 0) < topY) {
            void this.#handleTopObserver().catch(() => {});
          }
        }
      };
      window.addEventListener("scroll", this.#onScroll, { passive: true });
    }
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
    const container = getContainer();
    const list = getList();
    const pageIndex = this.end;
    let busyReleased = false;
    this.#beginLoad(list);
    try {
      const data = await this.props.getPage(pageIndex);
      if (!Array.isArray(data) || data.length === 0) {
        this.#hasMore = false;
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
      if (data.length < this.props.pageSize) {
        this.#hasMore = false;
        const [, bottomObserver] = getObservers();
        if (bottomObserver) {
          this.observer?.unobserve?.(bottomObserver);
        }
        if (this.pool.length >= this.poolLimit) {
          if (this.#setSize === -1) {
            this.#setSize = pageIndex * this.props.pageSize + data.length;
            this.#syncPoolSetSize();
          }
          return;
        }
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
        elements.forEach((el) => fragment.appendChild(el));
        this.pool.push(...elements);
        list.appendChild(fragment);
      } else {
        const [unchanged, recycled] = [
          this.pool.slice(this.props.pageSize, this.pool.length),
          this.pool.slice(0, this.props.pageSize),
        ];
        this.#blurActiveInRecycled(recycled);
        this.pool = [...unchanged, ...recycled];
        this.#updateData(recycled, data, basePosInSet);
        this.start++;
      }
      this.#updateElement("down");
      syncContainerHeight(container);
      this.#endLoad(list);
      busyReleased = true;
      this.#announceStatus(basePosInSet, batchEnd);
    } finally {
      if (!busyReleased) {
        this.#endLoad(list);
      }
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
    const container = getContainer();
    const list = getList();
    const pageIndex = this.start - 1;
    let busyReleased = false;
    this.#beginLoad(list);
    try {
      const data = await this.props.getPage(pageIndex);
      if (!Array.isArray(data) || data.length === 0) {
        return;
      }
      this.start--;
      const basePosInSet = pageIndex * this.props.pageSize + 1;
      const batchEnd = basePosInSet + data.length - 1;
      const recycleCount = Math.min(
        data.length,
        this.props.pageSize,
        this.pool.length,
      );
      const [recycled, unchanged] = [
        this.pool.slice(this.pool.length - recycleCount, this.pool.length),
        this.pool.slice(0, this.pool.length - recycleCount),
      ];
      this.#blurActiveInRecycled(recycled);
      this.pool = [...recycled, ...unchanged];
      this.#updateData(recycled, data, basePosInSet);
      const { anchorDelta, topY } = this.#updateElement("up", recycleCount);
      this.end--;
      const wasExhausted = !this.#hasMore;
      this.#hasMore = true;
      if (wasExhausted) {
        const [, bottomObserver] = getObservers();
        if (bottomObserver) {
          this.observer?.observe?.(bottomObserver);
        }
      }

      if (typeof window !== "undefined") {
        const currentScrollY = window.scrollY ?? 0;
        const targetScrollY = Math.max(topY, currentScrollY + anchorDelta);
        const scrollDelta = targetScrollY - currentScrollY;
        if (scrollDelta > 0) {
          syncContainerHeight(container);
          adjustWindowScroll(scrollDelta);
        } else {
          if (scrollDelta < 0) {
            adjustWindowScroll(scrollDelta);
          }
          syncContainerHeight(container);
        }
      } else {
        syncContainerHeight(container);
      }
      this.#endLoad(list);
      busyReleased = true;
      this.#announceStatus(basePosInSet, batchEnd);
    } finally {
      if (!busyReleased) {
        this.#endLoad(list);
      }
      this.#isLoading = false;
    }
  }

  /**
   * Blurs `document.activeElement` if focus resides on or inside any element
   * being recycled so coordinate updates do not trigger browser focus jumps.
   *
   * @param recycled {HTMLElement[]}
   * @return {void}
   */
  #blurActiveInRecycled(recycled) {
    const activeElement =
      typeof document !== "undefined" ? document.activeElement : null;
    if (!activeElement || typeof activeElement.blur !== "function") {
      return;
    }
    const containsTarget = (root, target) => {
      if (root === target) {
        return true;
      }
      if (typeof root?.contains === "function") {
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

  /**
   * 1. Recycles elements from top or bottom
   * 2. Updates absolute position of elements and observers
   *
   * @param direction {"up" | "down"}
   * @param count {number}
   * @return {{ prependedHeight: number, anchorDelta: number, topY: number }}
   */
  #updateElement(direction, count = this.props.pageSize) {
    if (this.pool.length === 0) {
      return { prependedHeight: 0, anchorDelta: 0, topY: 0 };
    }
    const [topObserver, bottomObserver] = getObservers();
    const yValues = this.pool.map((el) => {
      const currentY = y(el);
      return currentY == null ? null : +currentY;
    });
    const shouldTransform = this.pool.map((el) => Boolean(el.style.transform));

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
        : Math.min(count - 1, lastIndex);
    const end = direction === "down" ? this.pool.length : 0;

    // Phase 1: Batch DOM geometry reads before any style or attribute mutations
    const heights = new Array(this.pool.length);
    if (direction === "down") {
      for (let i = Math.max(0, start - 1); i < end; i++) {
        heights[i] = this.pool[i].getBoundingClientRect().height;
      }
    } else {
      for (let i = end; i <= start; i++) {
        heights[i] = this.pool[i].getBoundingClientRect().height;
      }
    }
    if (heights[lastIndex] === undefined) {
      heights[lastIndex] = this.pool[lastIndex].getBoundingClientRect().height;
    }

    // Phase 2: Compute target vertical positions in memory
    let prependedHeight = 0;
    let anchorDelta = 0;
    let writeEnd = start;

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
      for (let i = end; i <= start; i++) {
        prependedHeight += heights[i] + 2 * MARGIN;
      }
      const anchorIndex = start + 1;
      const hasAnchor =
        anchorIndex < this.pool.length && yValues[anchorIndex] != null;
      const previousAnchorY = hasAnchor ? yValues[anchorIndex] : 0;
      const firstY =
        !hasAnchor || this.start === 0
          ? 0
          : Math.max(0, previousAnchorY - prependedHeight);

      yValues[end] = firstY;
      if (hasAnchor || firstY !== 0) {
        shouldTransform[end] = true;
      }
      for (let i = end + 1; i <= start; i++) {
        yValues[i] = yValues[i - 1] + (heights[i - 1] + 2 * MARGIN);
        shouldTransform[i] = true;
      }

      if (hasAnchor) {
        const newAnchorY = firstY + prependedHeight;
        anchorDelta = newAnchorY - previousAnchorY;
        if (anchorDelta !== 0) {
          writeEnd = lastIndex;
          for (let i = anchorIndex; i <= lastIndex; i++) {
            if (yValues[i] != null) {
              yValues[i] = Math.max(0, yValues[i] + anchorDelta);
              shouldTransform[i] = true;
            }
          }
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
      for (let i = writeEnd; i >= end; i--) {
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

    return {
      prependedHeight,
      anchorDelta,
      topY: yValues[0],
    };
  }

  /**
   * @param elements {HTMLElement[]}
   * @param data {any[]}
   * @param basePosInSet {number}
   * @return {void}
   */
  #updateData(elements, data, basePosInSet) {
    const setSize = this.#setSize;
    for (let i = 0; i < elements.length; i++) {
      if (data?.[i] !== undefined) {
        const posInSet = basePosInSet + i;
        this.props.updateTemplate(elements[i], data[i], { posInSet, setSize });
        this.#applyItemAria(elements[i], posInSet, setSize);
      }
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
    if (element.getAttribute("aria-posinset") !== posValue) {
      element.setAttribute("aria-posinset", posValue);
    }
    if (element.getAttribute("aria-setsize") !== sizeValue) {
      element.setAttribute("aria-setsize", sizeValue);
    }
  }

  /**
   * @return {void}
   */
  #syncPoolSetSize() {
    const sizeValue = String(this.#setSize);
    for (let i = 0; i < this.pool.length; i++) {
      const el = this.pool[i];
      if (el && el.getAttribute("aria-setsize") !== sizeValue) {
        el.setAttribute("aria-setsize", sizeValue);
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
      list.setAttribute("aria-busy", "true");
    }
  }

  /**
   * @param list {?HTMLElement}
   * @return {void}
   */
  #endLoad(list) {
    this.#pendingLoads = Math.max(0, this.#pendingLoads - 1);
    if (this.#pendingLoads === 0 && list) {
      list.setAttribute("aria-busy", "false");
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
    const rangeText =
      firstPos === lastPos
        ? `item ${firstPos}`
        : `items ${firstPos} to ${lastPos}`;
    status.textContent =
      this.#setSize > 0
        ? `Loaded ${rangeText} of ${this.#setSize}.`
        : `Loaded ${rangeText}.`;
  }
}
