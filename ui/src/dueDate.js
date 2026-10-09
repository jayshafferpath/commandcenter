// Shared by TicketColumn and TodoColumn — both render the same due-date
// badge, so the day-math and tone/label rules live in one place.

// Local-date comparison, not UTC: a due date is a calendar day ("Oct 15"),
// not an instant, so comparing against UTC midnight would call a task
// overdue (or not) a few hours early/late depending on the viewer's zone.
export function daysUntil(dueDate) {
  if (!dueDate) return null;
  const [y, m, d] = dueDate.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

export function dueTone(days) {
  if (days === null) return null;
  if (days < 0) return "overdue";
  if (days <= 1) return "soon";
  return "future";
}

export function formatDue(dueDate, days) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const [y, m, d] = dueDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
