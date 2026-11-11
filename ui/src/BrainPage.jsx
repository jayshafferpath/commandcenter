// A session's Brain View as its own page (#/brain/<jobId>), opened in a
// new tab from a session card so the board stays put. A presentation
// surface for the agent: it polls the canvas and renders whatever the
// agent last wrote there — Markdown inline, a full HTML page in a sandbox.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { escapeHtml, renderMarkdownCanvas, withCanvasCsp } from "./brainCanvas.js";
import { fetchPanel } from "./fetchPanel.js";

const POLL_INTERVAL_MS = 4000;

// mermaid is a heavy dependency the vast majority of canvases won't need —
// loaded once, lazily, the first time a panel actually has a mermaid block
// to render, not bundled with the rest of the UI.
let mermaidModulePromise = null;
function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: "dark" });
      return mermaid;
    });
  }
  return mermaidModulePromise;
}

// No allow-same-origin: that, together with allow-scripts, would let the
// page script its way out of the sandbox and into the dashboard's DOM,
// cookies, and storage. With an opaque origin, scripts only ever reach the
// page itself. No allow-top-navigation or allow-popups, so it can't take
// over the tab either.
const HTML_CANVAS_SANDBOX = "allow-scripts";

export function BrainPage({ jobId }) {
  const [title, setTitle] = useState(null);
  const [live, setLive] = useState(null);
  const [error, setError] = useState(null);

  const fetchLive = useCallback(async () => {
    try {
      const data = await fetchPanel(`/api/jobs/${jobId}/brain`);
      setLive(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [jobId]);

  useEffect(() => {
    fetchLive();
    const interval = setInterval(fetchLive, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchLive]);

  useEffect(() => {
    fetchPanel(`/api/jobs/${jobId}`)
      .then(({ job }) => setTitle(job.title || job.ticketKey || "General dispatch"))
      .catch(() => setTitle(null));
  }, [jobId]);

  useEffect(() => {
    document.title = title ? `🧠 ${title}` : "Brain view";
  }, [title]);

  const content = live?.content ?? "";
  const isHtmlCanvas = live?.format === "html";
  const srcDoc = useMemo(() => (isHtmlCanvas ? withCanvasCsp(content) : null), [isHtmlCanvas, content]);
  const { html, mermaidBlocks } = useMemo(
    () => (isHtmlCanvas ? { html: "", mermaidBlocks: [] } : renderMarkdownCanvas(content)),
    [isHtmlCanvas, content],
  );
  // React resets innerHTML whenever this object's identity changes, not just its
  // string — a fresh object on every poll would wipe the SVGs mermaid drew into
  // the placeholders, with nothing re-running to draw them again.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (mermaidBlocks.length === 0) return;
    let cancelled = false;

    loadMermaid().then(async (mermaid) => {
      for (const block of mermaidBlocks) {
        if (cancelled) return;
        const el = bodyRef.current?.querySelector(`#${block.id}`);
        if (!el) continue;
        try {
          const { svg } = await mermaid.render(`${block.id}-svg`, block.code);
          if (!cancelled) el.innerHTML = svg;
        } catch (err) {
          // Never blank the canvas over a bad diagram — show what the agent
          // actually wrote plus why it didn't render, same as any other
          // fenced block that failed to parse.
          if (!cancelled) {
            el.innerHTML = `<pre class="brain-mermaid-raw">${escapeHtml(block.code)}</pre><div class="brain-mermaid-error">Mermaid couldn't render this: ${escapeHtml(err.message || String(err))}</div>`;
          }
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [html, mermaidBlocks]);

  return (
    <div className="brain-page">
      <div className="brain-panel">
        <div className="brain-panel-head">
          <span className="brain-panel-title">🧠 {title || "Brain view"}</span>
          <a className="brain-page-back" href="#/">
            ← Command Center
          </a>
        </div>

        {error && <div className="brain-panel-error">{error}</div>}

        {isHtmlCanvas ? (
          <iframe
            className="brain-panel-frame"
            title={title || "Brain view"}
            sandbox={HTML_CANVAS_SANDBOX}
            srcDoc={srcDoc}
          />
        ) : (
          <div className="brain-panel-body" ref={bodyRef} dangerouslySetInnerHTML={markup} />
        )}
      </div>
    </div>
  );
}
