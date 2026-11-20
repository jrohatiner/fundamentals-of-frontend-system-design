import { intersectionObserver } from "../../../utils/observer.js";
import { MARGIN, getList, y } from "../../../utils/virtual-list-helpers.js";

const OBSERVER_THRESHOLD = 0.25;

const getObservers = () => [
  document.getElementById("top-observer"),
  document.getElementById("bottom-observer"),
];

function getContainer() {
  return document.getElementById("container");
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

function getViewportHeight() {
  if (
    typeof window !== "undefined" &&
    typeof window.innerHeight === "number" &&
    window.innerHeight > 0
  ) {
    return window.innerHeight;
  }
  const docEl =
    typeof document !== "undefined" ? document.documentElement : null;
  if (
    docEl &&
    typeof docEl.clientHeight === "number" &&
    docEl.clientHeight > 0
  ) {
    return docEl.clientHeight;
  }
  return null;
}

function hasLayoutBox(rect) {
  return rect != null && (rect.width > 0 || rect.height > 0);
}

function isIntersectingViewport(
  rect,
  viewportHeight,
  threshold = OBSERVER_THRESHOLD,
) {
  if (!hasLayoutBox(rect)) {
    return false;
  }
  if (rect.height <= 0) {
    return rect.bottom >= 0 && rect.top <= viewportHeight;
  }
  const visibleTop = Math.max(0, rect.top);
  const visibleBottom = Math.min(viewportHeight, rect.bottom);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  return visibleHeight / rect.height >= threshold;
}

export class VirtualList {
  #hasMore = true;
  #isFetching = false;
  #onScroll = null;

  get hasMore() {
    return this.#hasMore;
  }

  set hasMore(value) {
    this.#hasMore = Boolean(value);
  }

  get isLoading() {
    return this.#isFetching;
  }

  set isLoading(value) {
    this.#isFetching = Boolean(value);
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
    this.#isFetching = false;
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
      if (this.#isFetching) {
        return;
      }
      for (const entry of entries) {
        if (this.#isFetching) {
          return;
        }
        if (entry.isIntersecting) {
          const id = entry.target.id;
          if (id === "top-observer" && this.start > 0) {
            void this.#handleTopObserver();
            return;
          } else if (id === "bottom-observer" && this.#hasMore) {
            void this.#handleBottomObserver();
            return;
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
    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      if (this.#onScroll && typeof window.removeEventListener === "function") {
        window.removeEventListener("scroll", this.#onScroll);
      }
      this.#onScroll = () => {
        if (this.start > 0 && !this.#isFetching && this.pool.length > 0) {
          const topY = +(y(this.pool[0]) ?? 0);
          if ((window.scrollY ?? 0) < topY) {
            void this.#handleTopObserver();
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
    if (this.#isFetching || !this.#hasMore) {
      return;
    }
    this.#isFetching = true;
    let didUpdate = false;
    let failed = false;
    try {
      const container = getContainer();
      const list = getList();
      const page = this.end;
      const data = await this.props.getPage(page);
      if (!Array.isArray(data) || data.length === 0) {
        this.#hasMore = false;
        const [, bottomObserver] = getObservers();
        if (bottomObserver) {
          this.observer?.unobserve?.(bottomObserver);
        }
      } else {
        let shouldRender = true;
        if (data.length < this.props.pageSize) {
          this.#hasMore = false;
          const [, bottomObserver] = getObservers();
          if (bottomObserver) {
            this.observer?.unobserve?.(bottomObserver);
          }
          if (this.pool.length >= this.poolLimit) {
            shouldRender = false;
          }
        }
        if (shouldRender) {
          this.end = page + 1;
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
            this.#blurActiveInRecycled(recycled);
            this.pool = [...unchanged, ...recycled];
            this.#updateData(recycled, data);
            this.start++;
          }
          this.#updateElement("down");
          syncContainerHeight(container);
          didUpdate = true;
        }
      }
    } catch {
      failed = true;
    } finally {
      this.#isFetching = false;
    }
    if (!failed) {
      this.#checkSentinelVisibility(didUpdate ? null : "bottom-observer");
    }
  }

  /**
   * Handles Top Observer Intersection event
   * @returns Promise<void>
   */
  async #handleTopObserver() {
    if (this.#isFetching || this.start <= 0) {
      return;
    }
    this.#isFetching = true;
    let didUpdate = false;
    let failed = false;
    try {
      const container = getContainer();
      const page = this.start - 1;
      const data = await this.props.getPage(page);
      if (Array.isArray(data) && data.length > 0) {
        this.start = page;
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
        this.#updateData(recycled, data);
        const { anchorDelta, topY } = this.#updateElement("up", recycleCount);
        this.end--;
        if (!this.#hasMore) {
          this.#hasMore = true;
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
        didUpdate = true;
      }
    } catch {
      failed = true;
    } finally {
      this.#isFetching = false;
    }
    if (!failed) {
      this.#checkSentinelVisibility(didUpdate ? null : "top-observer");
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
    if (this.#isFetching || this.pool.length === 0) {
      return;
    }
    const viewportHeight = getViewportHeight();
    if (viewportHeight == null) {
      return;
    }
    const [topObserver, bottomObserver] = getObservers();
    const topRect = topObserver ? topObserver.getBoundingClientRect() : null;
    const bottomRect = bottomObserver
      ? bottomObserver.getBoundingClientRect()
      : null;

    if (
      !hasLayoutBox(topRect) ||
      !hasLayoutBox(bottomRect) ||
      bottomRect.top <= topRect.top
    ) {
      return;
    }

    const topVisible = isIntersectingViewport(topRect, viewportHeight);
    const bottomVisible = isIntersectingViewport(bottomRect, viewportHeight);

    if (this.pool.length >= this.poolLimit && topVisible && bottomVisible) {
      return;
    }

    const canCheckTop = skipObserverId !== "top-observer" && this.start > 0;
    const canCheckBottom =
      skipObserverId !== "bottom-observer" && this.#hasMore;

    const atTopBoundary =
      canCheckTop && topRect.bottom >= topRect.height * OBSERVER_THRESHOLD;
    const atBottomBoundary =
      canCheckBottom &&
      bottomRect.top <= viewportHeight - bottomRect.height * OBSERVER_THRESHOLD;

    if (atTopBoundary && !atBottomBoundary) {
      void this.#handleTopObserver();
    } else if (atBottomBoundary && !atTopBoundary) {
      void this.#handleBottomObserver();
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
