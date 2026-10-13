// Small local icon set for Jira issue types. Jira's own issuetype.iconUrl
// points at api.atlassian.com universal_avatar URLs that require auth, so
// those can't be hotlinked here — these are inline SVGs instead. All use
// currentColor so they inherit legible contrast from whatever theme/text
// color surrounds them, light or dark.

const ICONS = {
  Story: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 6h6M5 9h4" strokeLinecap="round" />
    </svg>
  ),
  Task: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M4.5 8.5l2 2 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Bug: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="9" r="4" />
      <path d="M8 5V3M5.5 6l-1.8-1.8M10.5 6l1.8-1.8M4 9H2M14 9h-2M5.5 12l-1.8 1.8M10.5 12l1.8 1.8" strokeLinecap="round" />
    </svg>
  ),
  Spike: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 2l2 4.5h4.5L11 9.5 12.5 14 8 11.2 3.5 14 5 9.5 1.5 6.5H6z" strokeLinejoin="round" />
    </svg>
  ),
  "Sub-task": (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 2v6a2 2 0 0 0 2 2h3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="9" y="8" width="5" height="5" rx="1" />
    </svg>
  ),
  Epic: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M9 1L3 9h4l-1 6 7-9H9z" strokeLinejoin="round" />
    </svg>
  ),
};

ICONS.Subtask = ICONS["Sub-task"];

const FALLBACK = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2" y="2" width="12" height="12" rx="2" strokeDasharray="2 2" />
  </svg>
);

export function IssueTypeIcon({ issueType }) {
  const icon = (issueType && ICONS[issueType]) || FALLBACK;
  const label = issueType || "Unknown type";

  return (
    <span className="focus-item-type-icon" title={label} aria-label={label} role="img">
      {icon}
    </span>
  );
}
