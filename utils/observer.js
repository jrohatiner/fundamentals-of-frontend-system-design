const defaultObserverConfig = { threshold: 0.25 };

/**
 * @param elem {unknown}
 * @return {elem is Element}
 */
function isValidTarget(elem) {
    if (!elem || typeof elem !== 'object') {
        return false;
    }
    if (typeof Element !== 'undefined') {
        if (elem instanceof Element) {
            return true;
        }
        const OwnerElement = elem.ownerDocument?.defaultView?.Element;
        return typeof OwnerElement === 'function' && elem instanceof OwnerElement;
    }
    return elem.nodeType === undefined || elem.nodeType === 1;
}

/**
 * @param target   {HTMLElement[]}
 * @param callback {IntersectionObserverCallback}
 * @param config   {IntersectionObserverInit}
 * @return {IntersectionObserver}
 */
export function intersectionObserver(
    target,
    callback,
    config
) {
    const observerInit = Object.assign({}, defaultObserverConfig, config ?? {});
    const observer = new IntersectionObserver(callback, observerInit);
    if (Array.isArray(target) || (target && typeof target === 'object' && typeof target[Symbol.iterator] === 'function')) {
        for (const t of target) {
            if (!isValidTarget(t)) {
                continue;
            }
            try {
                observer.observe(t);
            } catch (err) {
                if (!(err instanceof TypeError)) {
                    throw err;
                }
            }
        }
    }
    return observer;
}

/**
 * @param target   {Iterable<HTMLElement>}
 * @param callback {ResizeObserverCallback}
 * @param config   {ResizeObserverOptions}
 * @return {ResizeObserver | { observe: () => void, unobserve: () => void, disconnect: () => void }}
 */
export function resizeObserver(
    target,
    callback,
    config
) {
    if (typeof ResizeObserver === 'undefined') {
        return {
            observe() {},
            unobserve() {},
            disconnect() {}
        };
    }
    const observer = new ResizeObserver(callback);
    if (Array.isArray(target) || (target && typeof target === 'object' && typeof target[Symbol.iterator] === 'function')) {
        for (const t of target) {
            if (!isValidTarget(t)) {
                continue;
            }
            try {
                observer.observe(t, config);
            } catch (err) {
                if (!(err instanceof TypeError)) {
                    throw err;
                }
            }
        }
    }
    return observer;
}
