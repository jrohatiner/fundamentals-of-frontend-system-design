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

const INTERACTIVE_TAGS = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "BUTTON",
  "SUMMARY",
]);

/**
 * Checks whether `root` is or contains `target`, supporting both standard DOM
 * nodes and lightweight test doubles without `.contains()`.
 *
 * @param root {HTMLElement | null | undefined}
 * @param target {Element | null | undefined}
 * @returns {boolean}
 */
function containsNode(root, target) {
  if (!root || !target) {
    return false;
  }
  if (root === target) {
    return true;
  }
  if (typeof root.contains === "function") {
    return root.contains(target);
  }
  const children = root.children;
  if (children && typeof children.length === "number") {
    for (let i = 0; i < children.length; i++) {
      if (containsNode(children[i], target)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Determines whether an element can receive keyboard/interactive focus.
 *
 * @param el {HTMLElement | null | undefined}
 * @returns {boolean}
 */
function isFocusableElement(el) {
  if (!el || typeof el !== "object" || typeof el.focus !== "function") {
    return false;
  }
  if (el.isContentEditable === true) {
    return true;
  }
  const contentEditable =
    typeof el.getAttribute === "function"
      ? el.getAttribute("contenteditable")
      : el.contentEditable;
  if (
    contentEditable === "" ||
    contentEditable === "true" ||
    contentEditable === "plaintext-only"
  ) {
    return true;
  }
  const tabIndexAttr =
    typeof el.getAttribute === "function" ? el.getAttribute("tabindex") : null;
  if (tabIndexAttr !== null && tabIndexAttr !== "") {
    const parsed = Number(tabIndexAttr);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return true;
    }
  } else if (typeof el.tabIndex === "number" && el.tabIndex >= 0) {
    return true;
  }
  const tagName =
    typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (INTERACTIVE_TAGS.has(tagName)) {
    const isDisabled =
      Boolean(el.disabled) ||
      (typeof el.getAttribute === "function" &&
        el.getAttribute("disabled") !== null);
    return !isDisabled;
  }
  if (tagName === "A") {
    return (
      Boolean(el.href) ||
      (typeof el.getAttribute === "function" &&
        el.getAttribute("href") !== null)
    );
  }
  return false;
}

/**
 * Computes the child-index path from `current` to `target`.
 *
 * @param current {HTMLElement}
 * @param target {Element}
 * @returns {number[] | null}
 */
function findChildPath(current, target) {
  if (current === target) {
    return [];
  }
  const children = current?.children;
  if (!children || typeof children.length !== "number") {
    return null;
  }
  for (let i = 0; i < children.length; i++) {
    const subPath = findChildPath(children[i], target);
    if (subPath !== null) {
      return [i, ...subPath];
    }
  }
  return null;
}

/**
 * Captures structural metadata describing the focused node within a pooled item.
 *
 * @param itemRoot {HTMLElement}
 * @param activeElement {HTMLElement}
 */
function captureFocusDescriptor(itemRoot, activeElement) {
  return {
    isSelf: itemRoot === activeElement,
    path: findChildPath(itemRoot, activeElement),
    tagName:
      typeof activeElement.tagName === "string"
        ? activeElement.tagName.toUpperCase()
        : "",
    wasStandardFocusable: isFocusableElement(activeElement),
  };
}

/**
 * Finds the first focusable descendant within `root`, optionally matching `preferredTagName`.
 *
 * @param root {HTMLElement}
 * @param preferredTagName {string}
 * @returns {HTMLElement | null}
 */
function findFocusableDescendant(root, preferredTagName = "") {
  const children = root?.children;
  if (!children || typeof children.length !== "number") {
    return null;
  }
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isFocusableElement(child)) {
      if (
        !preferredTagName ||
        child.tagName?.toUpperCase() === preferredTagName
      ) {
        return child;
      }
    }
    const nested = findFocusableDescendant(child, preferredTagName);
    if (nested) {
      return nested;
    }
  }
  return null;
}

/**
 * Resolves the corresponding focus target inside `itemRoot` from a captured descriptor.
 *
 * @param itemRoot {HTMLElement | null | undefined}
 * @param descriptor {ReturnType<typeof captureFocusDescriptor> | null}
 * @returns {HTMLElement | null}
 */
function resolveFocusTarget(itemRoot, descriptor) {
  if (!itemRoot || !descriptor) {
    return null;
  }
  if (descriptor.isSelf) {
    return isFocusableElement(itemRoot) ? itemRoot : null;
  }
  if (Array.isArray(descriptor.path)) {
    let candidate = itemRoot;
    for (const index of descriptor.path) {
      candidate = candidate?.children?.[index] ?? null;
      if (!candidate) {
        break;
      }
    }
    if (candidate && typeof candidate.focus === "function") {
      if (descriptor.wasStandardFocusable) {
        if (isFocusableElement(candidate)) {
          return candidate;
        }
      } else if (
        !descriptor.tagName ||
        candidate.tagName?.toUpperCase() === descriptor.tagName
      ) {
        return candidate;
      }
    }
  }
  if (descriptor.tagName) {
    const matchingByTag = findFocusableDescendant(itemRoot, descriptor.tagName);
    if (matchingByTag) {
      return matchingByTag;
    }
  }
  const firstFocusable = findFocusableDescendant(itemRoot);
  if (firstFocusable) {
    return firstFocusable;
  }
  return isFocusableElement(itemRoot) ? itemRoot : null;
}

/**
 * Returns the active viewport height when running in a browser window, or 0 otherwise.
 *
 * @returns {number}
 */
function getViewportHeight() {
  if (typeof window === "undefined") {
    return 0;
  }
  const docHeight =
    typeof document !== "undefined"
      ? (document.documentElement?.clientHeight ?? 0)
      : 0;
  return window.innerHeight || docHeight || 0;
}

/**
 * Computes pixel distance from the viewport bounds `[0, viewportHeight]`.
 * Returns `0` when the element intersects the viewport, a positive distance when
 * completely out of viewport bounds, or `null` when viewport/layout is unmeasured.
 *
 * @param el {HTMLElement}
 * @param viewportHeight {number}
 * @returns {number | null}
 */
function getViewportDistance(el, viewportHeight) {
  if (viewportHeight <= 0 || typeof el?.getBoundingClientRect !== "function") {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (!rect || (rect.height === 0 && rect.top === 0 && rect.bottom === 0)) {
    return null;
  }
  if (rect.bottom <= 0) {
    return 1 - rect.bottom;
  }
  if (rect.top >= viewportHeight) {
    return 1 + (rect.top - viewportHeight);
  }
  return 0;
}

/**
 * Focuses `target` without scrolling the viewport if it does not already hold focus.
 *
 * @param target {HTMLElement | null | undefined}
 * @returns {boolean}
 */
function focusElement(target) {
  if (!target || typeof target.focus !== "function") {
    return false;
  }
  if (typeof document !== "undefined" && document.activeElement === target) {
    return true;
  }
  target.focus({ preventScroll: true });
  return true;
}

export class VirtualList {
  #hasMore = true;
  #isLoading = false;
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
        const elements = data.map((datum) => this.props.getTemplate(datum));
        elements.forEach((el) => fragment.appendChild(el));
        this.pool.push(...elements);
        list.appendChild(fragment);
      } else {
        const [unchanged, recycled] = [
          this.pool.slice(this.props.pageSize, this.pool.length),
          this.pool.slice(0, this.props.pageSize),
        ];
        this.#preserveFocusBeforeRecycle(recycled, unchanged, "down");
        this.pool = [].concat(unchanged, recycled);
        this.#updateData(recycled, data);
        this.start++;
      }
      this.#updateElement("down");
      syncContainerHeight(container);
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
      const container = getContainer();
      const data = await this.props.getPage(this.start - 1);
      if (!Array.isArray(data) || data.length === 0) {
        return;
      }
      this.start--;
      const recycleCount = Math.min(
        data.length,
        this.props.pageSize,
        this.pool.length,
      );
      const [recycled, unchanged] = [
        this.pool.slice(this.pool.length - recycleCount, this.pool.length),
        this.pool.slice(0, this.pool.length - recycleCount),
      ];
      this.#preserveFocusBeforeRecycle(recycled, unchanged, "up");
      this.pool = [].concat(recycled, unchanged);
      this.#updateData(recycled, data);
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
    } finally {
      this.#isLoading = false;
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
   * Returns the current `document.activeElement` only if it resides inside the
   * virtual list items container; returns `null` otherwise.
   *
   * @returns {HTMLElement | null}
   */
  #getActiveListElement() {
    if (typeof document === "undefined") {
      return null;
    }
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      active === document.documentElement
    ) {
      return null;
    }
    const list = getList();
    if (list && (active === list || !containsNode(list, active))) {
      return null;
    }
    return active;
  }

  /**
   * Selects the best candidate item from `candidates` to receive focus,
   * preferring items visible within the viewport and breaking ties by
   * proximity to `preferredIndex`.
   *
   * @param candidates {HTMLElement[]}
   * @param preferredIndex {number}
   * @param descriptor {ReturnType<typeof captureFocusDescriptor>}
   * @returns {HTMLElement | null}
   */
  #findBestFocusCandidate(candidates, preferredIndex, descriptor) {
    const viewportHeight = getViewportHeight();
    let bestItem = null;
    let bestViewportDist = Infinity;
    let bestIndexDist = Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (!resolveFocusTarget(candidate, descriptor)) {
        continue;
      }
      const rawDist = getViewportDistance(candidate, viewportHeight);
      const viewportDist = rawDist ?? 0;
      const indexDist = Math.abs(i - preferredIndex);
      if (
        viewportDist < bestViewportDist ||
        (viewportDist === bestViewportDist && indexDist < bestIndexDist)
      ) {
        bestItem = candidate;
        bestViewportDist = viewportDist;
        bestIndexDist = indexDist;
      }
    }
    return bestItem;
  }

  /**
   * Finds the nearest candidate item that strictly intersects the viewport.
   *
   * @param candidates {HTMLElement[]}
   * @param originIndex {number}
   * @param viewportHeight {number}
   * @param descriptor {ReturnType<typeof captureFocusDescriptor>}
   * @returns {HTMLElement | null}
   */
  #findNearestVisibleCandidate(
    candidates,
    originIndex,
    viewportHeight,
    descriptor,
  ) {
    let bestItem = null;
    let bestIndexDist = Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (getViewportDistance(candidate, viewportHeight) !== 0) {
        continue;
      }
      if (!resolveFocusTarget(candidate, descriptor)) {
        continue;
      }
      const indexDist = Math.abs(i - originIndex);
      if (indexDist < bestIndexDist) {
        bestItem = candidate;
        bestIndexDist = indexDist;
      }
    }
    return bestItem;
  }

  /**
   * Preserves or relocates focus prior to recycling pooled DOM elements.
   * - If a recycled node holds focus, blurs the recycled target before DOM mutations
   *   and relocates focus to the nearest visible retained item in `unchanged` when
   *   a focusable counterpart exists (leaving focus on `document.body` otherwise).
   * - If a retained node in `unchanged` holds focus and has scrolled completely out of the viewport,
   *   moves focus to the nearest visible sibling in `unchanged` to avoid off-screen focus trapping.
   *
   * @param recycled {HTMLElement[]}
   * @param unchanged {HTMLElement[]}
   * @param direction {"up" | "down"}
   * @return {void}
   */
  #preserveFocusBeforeRecycle(recycled, unchanged, direction) {
    const activeElement = this.#getActiveListElement();
    if (!activeElement || unchanged.length === 0) {
      return;
    }

    const recycledIndex = recycled.findIndex((el) =>
      containsNode(el, activeElement),
    );
    if (recycledIndex !== -1) {
      const descriptor = captureFocusDescriptor(
        recycled[recycledIndex],
        activeElement,
      );
      const preferredIndex = direction === "down" ? 0 : unchanged.length - 1;
      const targetCard = this.#findBestFocusCandidate(
        unchanged,
        preferredIndex,
        descriptor,
      );
      const resolvedTarget = resolveFocusTarget(targetCard, descriptor);
      if (typeof activeElement.blur === "function") {
        activeElement.blur();
      }
      if (resolvedTarget) {
        focusElement(resolvedTarget);
      }
      return;
    }

    const unchangedIndex = unchanged.findIndex((el) =>
      containsNode(el, activeElement),
    );
    if (unchangedIndex !== -1) {
      const viewportHeight = getViewportHeight();
      const currentDistance = getViewportDistance(
        unchanged[unchangedIndex],
        viewportHeight,
      );
      if (currentDistance !== null && currentDistance > 0) {
        const descriptor = captureFocusDescriptor(
          unchanged[unchangedIndex],
          activeElement,
        );
        const visibleSibling = this.#findNearestVisibleCandidate(
          unchanged,
          unchangedIndex,
          viewportHeight,
          descriptor,
        );
        if (visibleSibling && visibleSibling !== unchanged[unchangedIndex]) {
          focusElement(resolveFocusTarget(visibleSibling, descriptor));
        }
      }
    }
  }

  /**
   * Updates recycled or target elements with new data while guarding active focus
   * against template overwrites or off-screen displacement.
   *
   * @return {void}
   */
  #updateData(elements, data) {
    const activeElement = this.#getActiveListElement();
    let focusedContext = null;

    if (activeElement) {
      const targetIndex = elements.findIndex((el) =>
        containsNode(el, activeElement),
      );
      if (targetIndex !== -1) {
        focusedContext = {
          element: elements[targetIndex],
          descriptor: captureFocusDescriptor(
            elements[targetIndex],
            activeElement,
          ),
        };
      }
    }

    for (let i = 0; i < elements.length; i++) {
      if (data?.[i] !== undefined) {
        this.props.updateTemplate(elements[i], data[i]);
      }
    }

    if (focusedContext) {
      const { element, descriptor } = focusedContext;
      const viewportHeight = getViewportHeight();
      const distance = getViewportDistance(element, viewportHeight);
      let destination = element;

      if (distance !== null && distance > 0 && this.pool.length > 0) {
        const poolIndex = this.pool.indexOf(element);
        const visibleSibling = this.#findNearestVisibleCandidate(
          this.pool,
          poolIndex === -1 ? 0 : poolIndex,
          viewportHeight,
          descriptor,
        );
        if (visibleSibling) {
          destination = visibleSibling;
        }
      }

      const resolved = resolveFocusTarget(destination, descriptor);
      if (resolved) {
        focusElement(resolved);
      } else if (typeof activeElement.blur === "function") {
        activeElement.blur();
      }
    }
  }
}
