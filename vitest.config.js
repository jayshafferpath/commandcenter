import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// No coverage threshold: most files here are React components whose value is in
// rendering, not in branch logic, and a number that forces tests for JSX markup
// would buy less than it costs.
export default defineConfig({
  // Needed to parse the .jsx modules the selectors live alongside.
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{js,jsx}"],
  },
});
