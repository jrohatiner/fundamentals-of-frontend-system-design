let cardCounter = 0;

export function createCardElement(title, body) {
  const template = document.getElementById("card_template");
  const element = template.content.cloneNode(true).firstElementChild;
  const [cardTitle] = element.getElementsByTagName("h3");
  const [cardBody] = element.getElementsByTagName("section");
  const titleId = `card-title-${++cardCounter}`;
  cardTitle.id = titleId;
  cardBody.setAttribute("aria-labelledby", titleId);
  if (
    !cardBody.getAttribute("aria-describedby") &&
    document.getElementById("slash-instructions")
  ) {
    cardBody.setAttribute("aria-describedby", "slash-instructions");
  }
  [cardTitle.textContent, cardBody.textContent] = [title, body];
  return element;
}

export const HEADING_COMMAND_REGEX =
  /^\/h([1-3])(?![0-9])[ \t\u00a0]?([\s\S]*)$/;

export function getHeading(node) {
  const text = node?.textContent ?? "";
  const match = text.match(HEADING_COMMAND_REGEX);
  if (!match) {
    return node;
  }

  const [, level, trailingText] = match;
  const element = document.createElement(`h${level}`);
  element.setAttribute("contenteditable", "true");
  element.setAttribute("data-placeholder", `Heading ${level}`);
  if (trailingText) {
    element.textContent = trailingText;
  }

  const statusRegion = document.getElementById("editor-status");
  if (statusRegion) {
    const suffix = trailingText ? `: ${trailingText}` : "";
    statusRegion.replaceChildren(
      document.createTextNode(
        `Converted block to heading level ${level}${suffix}`,
      ),
    );
  }

  return element;
}
