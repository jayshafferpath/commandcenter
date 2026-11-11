// The pure half of Brain View: turning whatever the agent wrote into
// something safe to put on the page. Split out of BrainPage.jsx so it's
// testable without a DOM.

import { Marked } from "marked";

export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// An allowlist rather than a javascript:-blocklist: marked leaves existing
// entities in an href alone, so "javascript&#58;..." would slip past a
// scheme check and still be decoded into a live javascript: URL by the browser.
const SAFE_HREF = /^(https?:\/\/|mailto:|#|\/|\.\.?\/)/i;

export function isSafeHref(href) {
  return SAFE_HREF.test((href || "").trim());
}

// The Markdown canvas is mounted with dangerouslySetInnerHTML straight into
// the dashboard's own page, so anything marked passes through as raw HTML
// (a <script>, an onerror=, a <style> restyling the board) would run with
// the dashboard's full origin. Raw HTML is escaped to inert text instead;
// an agent that wants real HTML writes canvas.html, which gets a sandbox.
//
// Mermaid fences become an empty placeholder div — mermaid.render() needs a
// real DOM node to target, which only exists once this HTML is mounted. The
// placeholder is emitted by the code renderer, not by passing raw HTML
// through, so it's the only markup in the output the agent didn't go
// through marked's escaping to produce.
export function renderMarkdownCanvas(markdown) {
  const mermaidBlocks = [];
  const marked = new Marked({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      code({ text, lang }) {
        if (lang !== "mermaid") return false;
        const id = `brain-mermaid-${mermaidBlocks.length}`;
        mermaidBlocks.push({ id, code: text });
        return `<div class="brain-mermaid" id="${id}"></div>\n`;
      },
      link({ href, tokens }) {
        if (isSafeHref(href)) return false;
        return this.parser.parseInline(tokens);
      },
    },
  });
  return { html: marked.parse(markdown || ""), mermaidBlocks };
}

// The iframe sandbox (no allow-same-origin) keeps the page out of the
// dashboard's DOM and storage, but not off the network: the API's CORS
// reflects any Origin, "null" included, so a script in the canvas could
// still fetch localhost:3789 and dispatch agents or close sessions (forms
// are already blocked by leaving out allow-forms). A meta
// CSP placed first can't be loosened by anything the page adds after it.
// It goes after the doctype, since anything ahead of one drops the page
// into quirks mode.
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;
const DOCTYPE = /<!doctype[^>]*>/i;

export function withCanvasCsp(html) {
  const page = html || "";
  const doctype = page.match(DOCTYPE);
  if (!doctype) return `${CSP_META}${page}`;
  const end = doctype.index + doctype[0].length;
  return `${page.slice(0, end)}${CSP_META}${page.slice(end)}`;
}
