import mark from "../assets/rvx-mark.svg";
import {el} from "./ui";

/** Reuse the same original RVX mark in the application header and browser favicon. */
export function brandMark(): HTMLSpanElement {
  const brand = el("span", "brand");
  brand.setAttribute("aria-label", "RVX");
  brand.setAttribute("role", "img");
  const image = el("img", "brand-icon");
  image.src = mark; image.alt = ""; image.width = 28; image.height = 28;
  const wordmark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wordmark.classList.add("brand-wordmark"); wordmark.setAttribute("viewBox", "0 0 42 21");
  wordmark.setAttribute("aria-hidden", "true");
  const letters = document.createElementNS(wordmark.namespaceURI, "path");
  letters.setAttribute("fill", "none"); letters.setAttribute("stroke", "currentColor");
  letters.setAttribute("stroke-width", "2.6"); letters.setAttribute("stroke-linecap", "round"); letters.setAttribute("stroke-linejoin", "round");
  letters.setAttribute("d", "M3 16V5m0 5c0-3 2-5 5-5h2M14 5l5 11 5-11M29 5l10 11M39 5 29 16");
  wordmark.append(letters);
  brand.append(image, wordmark);
  return brand;
}
