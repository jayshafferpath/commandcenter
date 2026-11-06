// A session's Brain View as its own page (#/brain/<jobId>), opened in a
// new tab from a session card so the board stays put. A presentation
// surface for the agent: it polls canvas.md and renders whatever the
// agent last wrote there.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
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

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;

// Mermaid fences get swapped for an empty placeholder div before the rest
// goes through marked — mermaid.render() needs a real DOM node to target,
// which only exists after this HTML is actually mounted, so this just
// reserves the spot. The placeholder is our own literal div, not agent
// input, so letting marked pass raw HTML blocks through untouched is safe
// here even though the agent's own canvas is never otherwise treated as
// trusted HTML.
function renderCanvas(markdown) {
  const mermaidBlocks = [];
  const withPlaceholders = (markdown || "").replace(MERMAID_FENCE, (_match, code) => {
    const id = `brain-mermaid-${mermaidBlocks.length}`;
    mermaidBlocks.push({ id, code });
    return `\n\n<div class="brain-mermaid" id="${id}"></div>\n\n`;
  });
  return { html: marked.parse(withPlaceholders), mermaidBlocks };
}

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
  const { html, mermaidBlocks } = useMemo(() => renderCanvas(content), [content]);
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

        <div className="brain-panel-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
