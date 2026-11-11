import { describe, expect, it } from "vitest";
import { isSafeHref, renderMarkdownCanvas, withCanvasCsp } from "../ui/src/brainCanvas.js";

describe("renderMarkdownCanvas", () => {
  it("renders ordinary Markdown", () => {
    const { html } = renderMarkdownCanvas("## Status\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<h2>Status</h2>");
    expect(html).toContain("<td>1</td>");
  });

  it("escapes a raw HTML block instead of passing it into the dashboard DOM", () => {
    const { html } = renderMarkdownCanvas("<script>alert(1)</script>\n\n<style>body{display:none}</style>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes inline HTML, so event-handler attributes never become live", () => {
    const { html } = renderMarkdownCanvas('Look: <img src=x onerror="alert(1)"> here');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("drops the href from links with an unsafe scheme but keeps their text", () => {
    const { html } = renderMarkdownCanvas("[click](javascript:alert(1)) and [also](javascript&#58;alert(1))");
    expect(html).not.toContain("<a");
    expect(html).toContain("click");
    expect(html).toContain("also");
  });

  it("keeps ordinary links", () => {
    const { html } = renderMarkdownCanvas("[PR](https://github.com/x/y/pull/1)");
    expect(html).toContain('<a href="https://github.com/x/y/pull/1">PR</a>');
  });

  it("swaps each mermaid fence for a placeholder and hands back its code", () => {
    const { html, mermaidBlocks } = renderMarkdownCanvas(
      "```mermaid\nflowchart LR\n  a --> b\n```\n\ntext\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```",
    );
    expect(mermaidBlocks).toEqual([
      { id: "brain-mermaid-0", code: "flowchart LR\n  a --> b" },
      { id: "brain-mermaid-1", code: "sequenceDiagram\n  A->>B: hi" },
    ]);
    expect(html).toContain('<div class="brain-mermaid" id="brain-mermaid-0"></div>');
    expect(html).toContain('<div class="brain-mermaid" id="brain-mermaid-1"></div>');
  });

  it("leaves non-mermaid code fences as escaped code blocks", () => {
    const { html, mermaidBlocks } = renderMarkdownCanvas("```js\nconst a = '<b>';\n```");
    expect(mermaidBlocks).toEqual([]);
    expect(html).toContain('<code class="language-js">');
    expect(html).toContain("&lt;b&gt;");
  });

  it("numbers mermaid placeholders from zero on every render", () => {
    renderMarkdownCanvas("```mermaid\ngraph TD\n```");
    const { mermaidBlocks } = renderMarkdownCanvas("```mermaid\ngraph TD\n```");
    expect(mermaidBlocks[0].id).toBe("brain-mermaid-0");
  });

  it("treats a missing canvas as empty", () => {
    expect(renderMarkdownCanvas(undefined)).toEqual({ html: "", mermaidBlocks: [] });
  });
});

describe("isSafeHref", () => {
  it("allows web, mail, and in-page links", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("mailto:a@b.c")).toBe(true);
    expect(isSafeHref("#section")).toBe(true);
    expect(isSafeHref("/path")).toBe(true);
  });

  it("rejects script and data URLs, however they're disguised", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("  JavaScript:alert(1)")).toBe(false);
    expect(isSafeHref("javascript&#58;alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeHref("vbscript:x")).toBe(false);
  });
});

describe("withCanvasCsp", () => {
  const META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;

  it("puts the CSP right after the doctype, so the page stays in standards mode", () => {
    expect(withCanvasCsp("<!DOCTYPE html><html><head></head></html>")).toBe(
      `<!DOCTYPE html>${META}<html><head></head></html>`,
    );
  });

  it("puts the CSP first when there's no doctype", () => {
    expect(withCanvasCsp("<h1>hi</h1>")).toBe(`${META}<h1>hi</h1>`);
  });

  it("goes ahead of any script the page carries", () => {
    const page = withCanvasCsp("<!doctype html><script>fetch('/api/dispatch')</script>");
    expect(page.indexOf(META)).toBeLessThan(page.indexOf("<script>"));
  });
});
