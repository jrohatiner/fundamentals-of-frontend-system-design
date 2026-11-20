export { createCardElement, updateCardElement } from "../../utils/card.js";

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
  return element;
}
