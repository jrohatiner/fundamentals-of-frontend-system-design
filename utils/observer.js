const defaultObserverConfig = { threshold: 0.25 };

/**
 * Determines whether a candidate value is a valid DOM Element (or element mock
 * in non-browser test environments).
 *
 * @param elem {unknown}
 * @return {elem is Element}
 */
function isValidTarget(elem) {
  if (!elem || typeof elem !== "object") {
    return false;
  }
  if (typeof Element !== "undefined") {
    if (elem instanceof Element) {
      return true;
    }
    const OwnerElement = elem.ownerDocument?.defaultView?.Element;
    return typeof OwnerElement === "function" && elem instanceof OwnerElement;
  }
  if (typeof elem.nodeType === "number") {
    return elem.nodeType === 1;
  }
  return typeof elem.tagName === "string" && elem.tagName.length > 0;
}

/**
 * Normalizes a single target element, array, or iterable collection into an
 * array of candidate targets.
 *
 * @param target {Element | Iterable<Element | null | undefined> | null | undefined}
 * @return {unknown[]}
 */
function normalizeTargets(target) {
  if (target == null) {
    return [];
  }
  if (isValidTarget(target)) {
    return [target];
  }
  if (Array.isArray(target)) {
    return target;
  }
  if (
    typeof target === "object" &&
    typeof target[Symbol.iterator] === "function"
  ) {
    return Array.from(target);
  }
  return [];
}

/**
 * @param target   {HTMLElement | Array<HTMLElement | null | undefined> | Iterable<HTMLElement | null | undefined> | null | undefined}
 * @param callback {IntersectionObserverCallback}
 * @param config   {IntersectionObserverInit} [config]
 * @return {IntersectionObserver}
 */
export function intersectionObserver(target, callback, config) {
  const observerInit = Object.assign({}, defaultObserverConfig, config ?? {});
  const observer = new IntersectionObserver(callback, observerInit);
  const targets = normalizeTargets(target);
  for (const candidate of targets) {
    if (isValidTarget(candidate)) {
      observer.observe(candidate);
    }
  }
  return observer;
}
