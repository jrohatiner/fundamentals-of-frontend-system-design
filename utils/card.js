const DEFAULT_HEADING_TAG = 'h2';
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Normalizes a numeric (1-6) or tag-string ('h1'-'h6') heading level to a
 * lowercase HTML heading tag name, defaulting to 'h2'.
 *
 * @param {number | string | null | undefined} headingLevel
 * @returns {'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'}
 */
export function normalizeHeadingTag(headingLevel) {
    if (headingLevel == null) {
        return DEFAULT_HEADING_TAG;
    }
    if (typeof headingLevel === 'number') {
        if (Number.isInteger(headingLevel) && headingLevel >= 1 && headingLevel <= 6) {
            return /** @type {'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'} */ (`h${headingLevel}`);
        }
        return DEFAULT_HEADING_TAG;
    }
    if (typeof headingLevel === 'string') {
        const normalized = headingLevel.trim().toLowerCase();
        if (/^[1-6]$/.test(normalized)) {
            return /** @type {'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'} */ (`h${normalized}`);
        }
        if (HEADING_TAGS.has(normalized)) {
            return /** @type {'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'} */ (normalized);
        }
    }
    return DEFAULT_HEADING_TAG;
}

/**
 * Parses flexible positional or object arguments into normalized card fields.
 *
 * @param {unknown} titleOrDatum
 * @param {unknown} bodyOrOptions
 * @param {unknown} optionsOrAlt
 * @param {unknown} maybeHeadingLevel
 */
function parseCardArgs(titleOrDatum, bodyOrOptions, optionsOrAlt, maybeHeadingLevel) {
    const isDatumObject =
        titleOrDatum != null &&
        typeof titleOrDatum === 'object' &&
        typeof (/** @type {{ nodeType?: unknown }} */ (titleOrDatum).nodeType) !== 'number';

    if (isDatumObject) {
        const datum = /** @type {Record<string, any>} */ (titleOrDatum);
        const opts =
            bodyOrOptions != null && typeof bodyOrOptions === 'object'
                ? /** @type {Record<string, any>} */ (bodyOrOptions)
                : {};
        return {
            title: datum.title,
            body: datum.body,
            alt: datum.alt ?? datum.imageAlt ?? opts.alt ?? opts.imageAlt,
            headingLevel:
                datum.headingLevel ??
                datum.level ??
                opts.headingLevel ??
                opts.level,
            template: opts.template,
        };
    }

    let alt;
    let headingLevel;
    let template;

    if (typeof optionsOrAlt === 'string') {
        alt = optionsOrAlt;
        if (maybeHeadingLevel != null && typeof maybeHeadingLevel === 'object') {
            const extra = /** @type {Record<string, any>} */ (maybeHeadingLevel);
            headingLevel = extra.headingLevel ?? extra.level;
            template = extra.template;
        } else {
            headingLevel = maybeHeadingLevel;
        }
    } else if (typeof optionsOrAlt === 'number') {
        headingLevel = optionsOrAlt;
    } else if (optionsOrAlt != null && typeof optionsOrAlt === 'object') {
        const opts = /** @type {Record<string, any>} */ (optionsOrAlt);
        alt = opts.alt ?? opts.imageAlt;
        headingLevel = opts.headingLevel ?? opts.level ?? maybeHeadingLevel;
        template = opts.template;
    } else {
        headingLevel = maybeHeadingLevel;
    }

    return {
        title: titleOrDatum,
        body: bodyOrOptions,
        alt,
        headingLevel,
        template,
    };
}

/**
 * Finds the direct card title heading element on `.card` without matching
 * user-authored headings nested inside `.card__body__content`.
 *
 * @param {HTMLElement} cardElement
 * @returns {HTMLElement | null}
 */
function findCardTitleElement(cardElement) {
    if (cardElement.children) {
        for (const child of cardElement.children) {
            const tag = child.tagName?.toLowerCase();
            if (
                child.classList?.contains('card__title') ||
                (tag && HEADING_TAGS.has(tag))
            ) {
                return /** @type {HTMLElement} */ (child);
            }
        }
    }
    return cardElement.querySelector(
        '.card__title, h1, h2, h3, h4, h5, h6'
    );
}

/**
 * Builds a fallback `<article class="card">` node if no `<template id="card_template">`
 * is present in the current document.
 *
 * @param {Document} doc
 * @returns {HTMLElement}
 */
function createFallbackCardStructure(doc) {
    const article = doc.createElement('article');
    article.className = 'card';

    const heading = doc.createElement(DEFAULT_HEADING_TAG);
    heading.className = 'card__title';

    const bodyWrapper = doc.createElement('div');
    bodyWrapper.className = 'card__body';

    const image = doc.createElement('div');
    image.className = 'card__body__image';
    image.setAttribute('aria-hidden', 'true');

    const content = doc.createElement('section');
    content.className = 'card__body__content';

    bodyWrapper.appendChild(image);
    bodyWrapper.appendChild(content);
    article.appendChild(heading);
    article.appendChild(bodyWrapper);

    return article;
}

/**
 * Updates an existing card DOM element in place with accessible heading level
 * and avatar alternative text attributes. Compatible with VirtualList element
 * recycling without replacing the root `<article class="card">` reference.
 *
 * @param {HTMLElement} element
 * @param {string | { title?: string, body?: string, alt?: string, headingLevel?: number | string }} datumOrTitle
 * @param {string | { alt?: string, headingLevel?: number | string } | undefined} [bodyOrOptions]
 * @param {string | number | { alt?: string, headingLevel?: number | string } | undefined} [optionsOrAlt]
 * @param {number | string | undefined} [maybeHeadingLevel]
 * @returns {HTMLElement}
 */
export function updateCardElement(
    element,
    datumOrTitle,
    bodyOrOptions,
    optionsOrAlt,
    maybeHeadingLevel
) {
    const { title, body, alt, headingLevel } = parseCardArgs(
        datumOrTitle,
        bodyOrOptions,
        optionsOrAlt,
        maybeHeadingLevel
    );

    const targetHeadingTag = normalizeHeadingTag(headingLevel);
    let cardTitle = findCardTitleElement(element);

    if (cardTitle) {
        if (cardTitle.tagName.toLowerCase() !== targetHeadingTag) {
            const doc = element.ownerDocument ?? document;
            const replacement = doc.createElement(targetHeadingTag);
            if (cardTitle.attributes) {
                for (const attr of cardTitle.attributes) {
                    replacement.setAttribute(attr.name, attr.value);
                }
            }
            if (replacement.classList && !replacement.classList.contains('card__title')) {
                replacement.classList.add('card__title');
            }
            cardTitle.replaceWith(replacement);
            cardTitle = replacement;
        } else if (cardTitle.classList && !cardTitle.classList.contains('card__title')) {
            cardTitle.classList.add('card__title');
        }
        cardTitle.textContent = title == null ? '' : String(title);
    }

    const cardImage = element.querySelector('.card__body__image');
    if (cardImage) {
        const hasAlt = typeof alt === 'string' && alt.trim().length > 0;
        if (hasAlt) {
            cardImage.removeAttribute('aria-hidden');
            cardImage.setAttribute('role', 'img');
            cardImage.setAttribute('aria-label', alt);
        } else {
            cardImage.removeAttribute('role');
            cardImage.removeAttribute('aria-label');
            cardImage.setAttribute('aria-hidden', 'true');
        }
    }

    const cardBody =
        element.querySelector('.card__body__content') ??
        element.getElementsByTagName?.('section')?.[0];
    if (cardBody) {
        cardBody.textContent = body == null ? '' : String(body);
    }

    return element;
}

/**
 * Creates a card `<article class="card">` DOM element from `#card_template`
 * (or a provided `<template>`) with configurable heading level (defaulting to `<h2>`)
 * and accessible avatar attributes (`role="img"` + `aria-label` when `alt` is
 * provided, or `aria-hidden="true"` when decorative).
 *
 * @param {string | { title?: string, body?: string, alt?: string, headingLevel?: number | string }} titleOrDatum
 * @param {string | { alt?: string, headingLevel?: number | string, template?: HTMLTemplateElement } | undefined} [bodyOrOptions]
 * @param {string | number | { alt?: string, headingLevel?: number | string, template?: HTMLTemplateElement } | undefined} [optionsOrAlt]
 * @param {number | string | { headingLevel?: number | string, template?: HTMLTemplateElement } | undefined} [maybeHeadingLevel]
 * @returns {HTMLElement}
 */
export function createCardElement(
    titleOrDatum,
    bodyOrOptions,
    optionsOrAlt,
    maybeHeadingLevel
) {
    const parsed = parseCardArgs(
        titleOrDatum,
        bodyOrOptions,
        optionsOrAlt,
        maybeHeadingLevel
    );

    const template =
        parsed.template ??
        (typeof document !== 'undefined'
            ? /** @type {HTMLTemplateElement | null} */ (document.getElementById('card_template'))
            : null);

    const element = template?.content?.firstElementChild
        ? /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true))
        : createFallbackCardStructure(template?.ownerDocument ?? document);

    return updateCardElement(element, {
        title: parsed.title,
        body: parsed.body,
        alt: parsed.alt,
        headingLevel: parsed.headingLevel,
    });
}

/**
 * Convenience helper for VirtualList exercises that pass `(undefined, datum)`
 * on creation and `(element, datum)` on recycling.
 *
 * @param {HTMLElement | null | undefined} element
 * @param {{ title?: string, body?: string, alt?: string, headingLevel?: number | string }} datum
 * @param {{ alt?: string, headingLevel?: number | string, template?: HTMLTemplateElement }} [options]
 * @returns {HTMLElement}
 */
export function getOrUpdateCardElement(element, datum, options) {
    if (element == null) {
        return createCardElement(datum, options);
    }
    return updateCardElement(element, datum, options);
}
