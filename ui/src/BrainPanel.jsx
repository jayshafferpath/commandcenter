// A wide, read-only canvas panel for a session's Brain View — the one
// opt-in exception to SessionColumn's "no expand" philosophy. Polls the
// live canvas while open and lets a human scrub back through its snapshot
// history, which is otherwise invisible (the agent only ever sees/writes
// the current canvas.md).

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

export function BrainPanel({ jobId, title, onClose }) {
  const [live, setLive] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [selectedTs, setSelectedTs] = useState(null); // null = live
  const [snapshotContent, setSnapshotContent] = useState(null);
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

  const fetchSnapshots = useCallback(async () => {
    try {
      const data = await fetchPanel(`/api/jobs/${jobId}/brain/snapshots`);
      setSnapshots(data.snapshots || []);
    } catch {
      // Supplementary — a scrubber that briefly fails to update shouldn't
      // block the live canvas from rendering.
    }
  }, [jobId]);

  useEffect(() => {
    fetchLive();
    fetchSnapshots();
  }, [fetchLive, fetchSnapshots]);

  // Only the live view needs polling — a selected snapshot is a fixed point
  // in history, not something that changes underneath you while you're
  // looking at it.
  useEffect(() => {
    if (selectedTs !== null) return;
    const interval = setInterval(() => {
      fetchLive();
      fetchSnapshots();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [selectedTs, fetchLive, fetchSnapshots]);

  useEffect(() => {
    if (selectedTs === null) {
      setSnapshotContent(null);
      return;
    }
    let cancelled = false;
    fetchPanel(`/api/jobs/${jobId}/brain/snapshots/${selectedTs}`)
      .then((data) => {
        if (!cancelled) setSnapshotContent(data.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, selectedTs]);

  const content = selectedTs === null ? live?.content ?? "" : snapshotContent ?? "";
  const index = selectedTs === null ? -1 : snapshots.indexOf(selectedTs);

  const goPrev = () => {
    if (snapshots.length === 0) return;
    const nextIndex = selectedTs === null ? snapshots.length - 1 : Math.max(0, index - 1);
    setSelectedTs(snapshots[nextIndex]);
  };

  const goNext = () => {
    if (selectedTs === null) return;
    if (index >= snapshots.length - 1) {
      setSelectedTs(null);
      return;
    }
    setSelectedTs(snapshots[index + 1]);
  };

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

  const scrubberLabel =
    selectedTs === null
      ? `live${live ? ` — ${live.snapshotCount} snapshot${live.snapshotCount === 1 ? "" : "s"}` : ""}`
      : `snapshot ${index + 1} / ${snapshots.length}`;

  return (
    <div className="brain-panel-overlay" onClick={onClose}>
      <div className="brain-panel" onClick={(e) => e.stopPropagation()}>
        <div className="brain-panel-head">
          <span className="brain-panel-title">{title || "Brain view"}</span>
          <button type="button" className="brain-panel-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="brain-panel-error">{error}</div>}

        <div className="brain-panel-scrubber">
          <button
            type="button"
            className="brain-panel-scrub-btn"
            onClick={goPrev}
            disabled={snapshots.length === 0 || (selectedTs !== null && index <= 0)}
          >
            ‹ prev
          </button>
          <span className="brain-panel-scrubber-label">{scrubberLabel}</span>
          <button
            type="button"
            className="brain-panel-scrub-btn"
            onClick={goNext}
            disabled={selectedTs === null}
          >
            next ›
          </button>
          {selectedTs !== null && (
            <button type="button" className="brain-panel-live-btn" onClick={() => setSelectedTs(null)}>
              Back to live
            </button>
          )}
        </div>

        <div className="brain-panel-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
