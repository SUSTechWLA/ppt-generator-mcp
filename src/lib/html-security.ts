import { JSDOM } from "jsdom";

const PROHIBITED_ELEMENTS = new Set([
  "applet", "base", "embed", "form", "frame", "iframe", "noscript", "object", "portal", "script", "template",
]);
const SVG_EXECUTABLE_ELEMENTS = new Set([
  "a", "animate", "animatemotion", "animatetransform", "discard", "foreignobject", "handler", "set",
]);
const NAVIGATION_ATTRIBUTES = new Set([
  "action", "archive", "background", "codebase", "data", "formaction", "href", "manifest", "ping", "poster", "src", "srcdoc", "srcset", "xlink:href",
]);
const EXECUTABLE_PROTOCOL = /^[\u0000-\u0020\u007f]*(?:javascript|vbscript)\s*:/i;
const EXTERNAL_PROTOCOL = /(?:https?|file|data|blob|ftp|wss?|resource)\s*:/i;
const LOCAL_FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;

function hasExternalSvgAttributeResource(attribute: Attr): boolean {
  const name = attribute.name.toLowerCase();
  if (name === "xmlns" || name.startsWith("xmlns:") || attribute.namespaceURI?.includes("xmlns")) return false;
  const value = attribute.value;
  if (value.includes("\\") || EXTERNAL_PROTOCOL.test(value) || /(?:^|[\s('"=])\/\//.test(value)) return true;
  const resourceFunctions = Array.from(value.matchAll(/url\s*\(([^)]*)\)/gi));
  for (const match of resourceFunctions) {
    const target = match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    if (!LOCAL_FRAGMENT.test(target)) return true;
  }
  return /url\s*\(/i.test(value) && resourceFunctions.length === 0;
}

function allElements(root: ParentNode): Element[] {
  const elements = Array.from(root.querySelectorAll("*"));
  for (const element of [...elements]) {
    if (element.localName.toLowerCase() === "template") {
      const content = (element as HTMLTemplateElement).content;
      if (content) elements.push(...allElements(content));
    }
  }
  return elements;
}

export function executableDomViolations(root: ParentNode): string[] {
  const violations = new Set<string>();
  for (const element of allElements(root)) {
    const tag = element.localName.toLowerCase();
    const namespace = element.namespaceURI?.toLowerCase() ?? "";
    if (PROHIBITED_ELEMENTS.has(tag)) violations.add(`element:${tag}`);
    if (tag === "math" || namespace.includes("mathml")) violations.add("namespace:mathml");
    if (namespace.includes("svg") && SVG_EXECUTABLE_ELEMENTS.has(tag)) violations.add(`svg:${tag}`);
    if (tag === "meta" && (element.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") violations.add("meta:refresh");

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const localName = attribute.localName.toLowerCase();
      if (name.startsWith("on") || localName.startsWith("on")) violations.add("attribute:event-handler");
      if (localName === "srcdoc" || localName === "shadowrootmode" || localName === "shadowroot") violations.add(`attribute:${localName}`);
      if (EXECUTABLE_PROTOCOL.test(attribute.value)) violations.add("attribute:executable-protocol");
      const navigationAttribute = name === "xlink:href" || NAVIGATION_ATTRIBUTES.has(name) || NAVIGATION_ATTRIBUTES.has(localName);
      const allowedImageSource = tag === "img" && localName === "src"
        && /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/i.test(attribute.value);
      if (navigationAttribute && !allowedImageSource) violations.add("attribute:navigation-or-resource");
      if (namespace.includes("svg") && hasExternalSvgAttributeResource(attribute)) violations.add("svg:external-attribute-resource");
    }
  }
  return [...violations];
}

export function hasExecutableDom(html: string): boolean {
  const document = new JSDOM(html).window.document;
  return executableDomViolations(document).length > 0;
}
