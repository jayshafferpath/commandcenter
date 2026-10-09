// Plain Jira details for a ticket — status, parent, blockers. No inferred
// workflow state, no checklist/plan/activity-log reading: those were
// artifacts of the old ticket-work lifecycle automation, not things Jira
// itself tracks. No PR info either — that lives in its own dedicated
// column (PrColumn) covering every PR across every repo, not just ones
// tied to a Jira ticket.

import { useState, useEffect } from "react";

export function TicketDetail({ ticketKey }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tickets/${ticketKey}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ticketKey]);

  if (loading) return <div className="detail-panel">Loading...</div>;
  if (!detail) return <div className="detail-panel">Failed to load details.</div>;

  return (
    <div className="detail-panel">
      <div className="detail-grid">
        <div className="detail-section">
          <h3>Info</h3>
          <div className="meta-row">
            <span className="meta-label">Status</span>
            <span className="meta-value">{detail.status}</span>
          </div>
          {detail.stack && (
            <div className="meta-row">
              <span className="meta-label">Parent</span>
              <span className="meta-value">
                {detail.stack.key}: {detail.stack.summary}
              </span>
            </div>
          )}
          {detail.labels?.length > 0 && (
            <div className="meta-row">
              <span className="meta-label">Labels</span>
              <span className="meta-value">{detail.labels.join(", ")}</span>
            </div>
          )}
        </div>

        <div className="detail-section">
          <h3>Dependencies</h3>
          {detail.blockedBy.length > 0 ? (
            <div className="meta-row">
              <span className="meta-label">Blocked by</span>
              <span className="meta-value">{detail.blockedBy.join(", ")}</span>
            </div>
          ) : (
            <div className="meta-row">
              <span className="meta-value" style={{ color: "var(--text-muted)" }}>
                No blockers
              </span>
            </div>
          )}
          {detail.blocks.length > 0 && (
            <div className="meta-row">
              <span className="meta-label">Blocks</span>
              <span className="meta-value">{detail.blocks.join(", ")}</span>
            </div>
          )}
        </div>

        {detail.description && (
          <div className="detail-section full-width">
            <h3>Description</h3>
            <div className="detail-description">{detail.description}</div>
          </div>
        )}
      </div>
    </div>
  );
}
