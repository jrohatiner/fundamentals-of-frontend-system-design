let cardCounter = 0;

export function createCardElement(title, body) {
    const template = document.getElementById('card_template');
    const element = template.content.cloneNode(true).firstElementChild;
    const [cardTitle] = element.getElementsByTagName("h3");
    const [cardBody] = element.getElementsByTagName("section");
    const titleId = `card-title-${++cardCounter}`;
    cardTitle.id = titleId;
    cardBody.setAttribute('aria-labelledby', titleId);
    if (!cardBody.getAttribute('aria-describedby') && document.getElementById('slash-instructions')) {
        cardBody.setAttribute('aria-describedby', 'slash-instructions');
    }
    [cardTitle.textContent, cardBody.textContent] = [title, body];
    return element;
}

export function getHeading(node) {
    let element = node;
    let headingLevel = null;
    if (node.textContent.startsWith("/h3")) {
        element = document.createElement("h3");
        headingLevel = 3;
    } else if (node.textContent.startsWith("/h2")) {
        element = document.createElement("h2");
        headingLevel = 2;
    } else if (node.textContent.startsWith("/h1")) {
        element = document.createElement("h1");
        headingLevel = 1;
    }
    element.textContent = node.textContent.slice(3);
    element.setAttribute('contenteditable', "true");
    element.textContent = element.textContent === '' ? "Heading" : element.textContent;

    if (headingLevel !== null) {
        const statusRegion = document.getElementById('editor-status');
        if (statusRegion) {
            statusRegion.replaceChildren(
                document.createTextNode(`Converted block to heading level ${headingLevel}: ${element.textContent}`)
            );
        }
    }

    return element;
}