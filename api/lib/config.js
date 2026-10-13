import { existsSync } from "node:fs";

// Dispatch always needs a real clone root to fall back to (unlabeled
// tickets, free-form dispatches), so an unset or bogus DEV_ROOT must fail
// loud at startup rather than quietly handing jobs a cwd that doesn't exist.
export function loadDevRoot() {
  const devRoot = process.env.DEV_ROOT;
  if (!devRoot) {
    throw new Error(
      "DEV_ROOT is not set. Set it in .env to the root directory containing your repo clones (e.g. /Users/you/dev).",
    );
  }
  if (!existsSync(devRoot)) {
    throw new Error(`DEV_ROOT (${devRoot}) does not exist.`);
  }
  return devRoot;
}

export function getJiraAuth() {
  const email = process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL;
  const token = process.env.JIRA_API_TOKEN || process.env.ATLASSIAN_API_TOKEN;
  const domain = process.env.JIRA_DOMAIN || process.env.ATLASSIAN_DOMAIN;

  if (!email || !token || !domain) {
    return null;
  }

  return { email, token, domain };
}
