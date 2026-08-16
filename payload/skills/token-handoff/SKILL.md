---
name: token-handoff
description: Create a compact semantic handoff before starting a new Cursor conversation. Invoke explicitly when the cost guard blocks a changed task or when the user requests a handoff.
disable-model-invocation: true
---

# Token handoff

Use judgment only for information that deterministic hooks cannot select.

1. Preserve accepted decisions and facts that the next conversation needs.
2. Exclude rejected drafts, raw logs, tool traces, and resolved detours.
3. Distinguish completed validation from assumptions.
4. Keep the handoff under 8,000 characters with exactly these headings:

   - `# Current goal`
   - `# Accepted decisions`
   - `# Modified files`
   - `# Validation completed`
   - `# Unresolved issues`
   - `# Next action`

5. Save it by passing the Markdown to `node ~/.cursor/token-saver/save-handoff.mjs` on stdin.
6. Return the saved path and recommend `/new`. Do not reopen files merely to elaborate the handoff.
