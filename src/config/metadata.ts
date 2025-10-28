import { siteConfig } from "./siteConfig";

const KEYWORDS_META = "keywords";
const DESCRIPTION_META = "description";

function ensureMeta(name: string): HTMLMetaElement {
  let element = document.querySelector(`meta[name="${name}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute("name", name);
    document.head.appendChild(element);
  }
  return element as HTMLMetaElement;
}

function ensureLink(rel: string): HTMLLinkElement {
  let element = document.querySelector(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement("link");
    element.setAttribute("rel", rel);
    document.head.appendChild(element);
  }
  return element as HTMLLinkElement;
}

export function applySiteMetadata(): void {
  const { siteName, description, keywords, favicon } = siteConfig;
  document.title = siteName;

  if (description) {
    const descriptionMeta = ensureMeta(DESCRIPTION_META);
    descriptionMeta.setAttribute("content", description);
  }

  if (keywords?.length) {
    const keywordsMeta = ensureMeta(KEYWORDS_META);
    keywordsMeta.setAttribute("content", keywords.join(", "));
  }

  if (favicon) {
    const iconLink = ensureLink("icon");
    iconLink.setAttribute("href", favicon);
  }
}
