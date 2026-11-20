export const MARGIN = 16;

/**
 * @return {HTMLElement | null}
 */
export function getList() {
  return document.getElementById("virtual-list");
}

/**
 * Returns `data-y` attribute of the HTMLElement, if value is provided
 * additionally updates the attribute
 *
 * @param element {HTMLElement | null | undefined}
 * @param value   {string | number}
 * @return {string | null | undefined}
 */
export function y(element, value = undefined) {
  if (value != null) {
    element?.setAttribute("data-y", value);
  }
  return element?.getAttribute("data-y");
}
