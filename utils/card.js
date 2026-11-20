/**
 * Checks whether a value is an HTML template element.
 *
 * @param {unknown} value
 * @return {boolean}
 */
function isTemplateElement(value) {
    return Boolean(value && typeof value === 'object' && 'content' in value);
}

/**
 * Checks whether a value is a card data object rather than a DOM node.
 *
 * @param {unknown} value
 * @return {value is { title?: string, body?: string }}
 */
function isCardData(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        !isTemplateElement(value) &&
        !('nodeType' in value)
    );
}

/**
 * Finds a child element by CSS class name first and falls back to tag name.
 *
 * @param {HTMLElement} element
 * @param {string} className
 * @param {string} tagName
 * @return {HTMLElement | null}
 */
function findCardPart(element, className, tagName) {
    if (typeof element.querySelector === 'function') {
        const byClass = element.querySelector(`.${className}`);
        if (byClass) {
            return byClass;
        }
    } else if (typeof element.getElementsByClassName === 'function') {
        const [byClass] = element.getElementsByClassName(className);
        if (byClass) {
            return byClass;
        }
    }

    if (typeof element.getElementsByTagName === 'function') {
        const [byTag] = element.getElementsByTagName(tagName);
        if (byTag) {
            return byTag;
        }
    }
    if (typeof element.querySelector === 'function') {
        return element.querySelector(tagName);
    }
    return null;
}

/**
 * Updates the title and body text of an existing card DOM element.
 *
 * @param {HTMLElement} element
 * @param {string | { title?: string, body?: string }} [titleOrDatum]
 * @param {string} [body]
 * @return {HTMLElement | null}
 */
export function updateCardElement(element, titleOrDatum, body) {
    if (!element) {
        return null;
    }

    const hasDataObject = isCardData(titleOrDatum);
    const nextTitle = (hasDataObject ? titleOrDatum.title : titleOrDatum) ?? '';
    const nextBody = (hasDataObject ? titleOrDatum.body : body) ?? '';

    const cardTitle = findCardPart(element, 'card__title', 'h3');
    const cardBody = findCardPart(element, 'card__body__content', 'section');

    if (cardTitle) {
        cardTitle.textContent = nextTitle;
    }
    if (cardBody) {
        cardBody.textContent = nextBody;
    }

    return element;
}

/**
 * Clones a card template element and populates its title and body content.
 *
 * @param {string | { title?: string, body?: string }} [titleOrDatum]
 * @param {string | { title?: string, body?: string } | HTMLTemplateElement} [body]
 * @param {HTMLTemplateElement} [template]
 * @return {HTMLElement}
 */
export function createCardElement(titleOrDatum, body, template) {
    let resolvedTitle = titleOrDatum;
    let resolvedBody = body;
    let resolvedTemplate = template;

    if (isCardData(titleOrDatum)) {
        resolvedTitle = titleOrDatum.title;
        resolvedBody = titleOrDatum.body;
        if (isTemplateElement(body)) {
            resolvedTemplate = body;
        }
    } else if (titleOrDatum == null && isCardData(body)) {
        resolvedTitle = body.title;
        resolvedBody = body.body;
    }

    const cardTemplate =
        resolvedTemplate ??
        (typeof document !== 'undefined' ? document.getElementById('card_template') : null);

    if (!cardTemplate || !cardTemplate.content) {
        throw new Error('Cannot find the #card_template element.');
    }

    const templateRoot = cardTemplate.content.firstElementChild;
    const element = templateRoot
        ? templateRoot.cloneNode(true)
        : cardTemplate.content.cloneNode(true).firstElementChild;

    return updateCardElement(element, resolvedTitle, resolvedBody);
}
