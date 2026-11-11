---
description: How to use your Command Center Brain View canvas, the live page the user can watch while you work. Use when you were dispatched by Command Center and want to show your thinking (a design, a comparison, a page you're building, reasoning you're working through) as you go.
---

# Command Center: Brain View

When Command Center dispatches you, your prompt names a canvas file:
`~/.commandcenter/brain/<jobId>/canvas.md`. The dashboard renders it on its
own page and refreshes it every few seconds, and you already have permission
to write anywhere in that directory.

## Whether to use it

It's optional, and most sessions never touch it. If you never write to it,
the dashboard shows nothing and nobody notices. Use it when something the
user can look at would help them follow along:

- An approach you're weighing, and what it trades off
- A comparison laid out as a table
- Reasoning you're working through out loud on a hard call
- A page or UI you're designing, shown as the real thing

It's not a progress log. Don't use it to narrate steps ("now running
tests"); that's what your terminal is for.

## What to put on it

The canvas is freeform: prose, lists, tables, code blocks, or a complete
HTML page, whichever best shows where your thinking is right now. Pick the
form for the content, not the other way around.

A Mermaid diagram (a fenced ```` ```mermaid ```` block) is the right tool
only when the content really is a graph: a flowchart, a sequence of calls,
how components connect. Don't reach for one by default.

## Two files, one view

There are two canvas files, side by side in the same directory:

- **`canvas.md`**: Markdown, rendered into the page. Mermaid fences become
  diagrams. Raw HTML in this file is shown as literal text, not rendered,
  and links only work for `http(s)://`, `mailto:`, `#anchor`, and `/path`
  targets.
- **`canvas.html`**: a complete, self-contained HTML page (inline your CSS
  and any JS). It's shown in a sandboxed frame: scripts run, but the page
  can't make network requests (`fetch`, XHR, WebSockets), submit forms,
  open popups, or reach the dashboard around it. Stylesheets, fonts, and
  scripts loaded by URL from a CDN do work.

If `canvas.html` has content, it's what the user sees. Otherwise they see
`canvas.md`. To switch back from a page to Markdown, empty `canvas.html`
(write it as a zero-byte file), don't just stop updating it.

## How to write it

- **Rewrite the whole file each time.** It's your current state of
  thinking, not a log to append to. The user sees whatever's in the file now.
- Keep it current as your thinking changes, and clear out ideas you've
  dropped so they don't read as the plan.

```markdown
## Approach: split the sync job by tenant

| Option              | Isolation | Cost        |
|---------------------|-----------|-------------|
| One shared worker   | None      | Lowest      |
| Per-tenant workers  | Full      | ~3x workers |

Leaning per-tenant: one partner's rate limit stops stalling everyone else.

Open question: whether retries share one budget across tenants.
```

For a page you're designing, write the full document to `canvas.html`
(`<!doctype html>` through `</html>`) and rewrite it each time you revise
the design.
