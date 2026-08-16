# Prompt for Cursor

Install the attached `cursor-cost-guard` package for my Cursor user account.

1. Read `README.md` and inspect the installer, hook, configuration defaults, tests, and uninstall path before running anything.
2. Confirm Node.js 20+ and `rg` are available.
3. Run `node --test tests/*.test.mjs`. Stop if any test fails.
4. Inspect my existing Cursor hooks and report any command already referencing `token-budget.mjs`.
5. Run the installer in dry-run mode using the `teams-third-party` billing profile:

   ```bash
   node install.mjs --dry-run --profile teams-third-party
   ```

6. Show me the resolved Cursor configuration root and files that will be written. Ask before continuing if the root is not my expected Cursor user configuration directory.
7. Install in observation mode first:

   ```bash
   node install.mjs --profile teams-third-party --observe
   ```

8. Validate the installed configuration and confirm that all pre-existing hooks remain present:

   ```bash
   node ~/.cursor/token-saver/token-saverctl.mjs validate-config
   node ~/.cursor/token-saver/token-saverctl.mjs status
   ```

9. Exercise one synthetic `beforeSubmitPrompt` event against the installed hook. Do not use a real model call.
10. Report the backup directory and exact rollback command.
11. Confirm the installed package reports version 0.5.0 and mode `observe`.
12. Leave the guard in observation mode. Do not enable enforcement until I review at least one working session's estimates against Cursor's usage dashboard. Enabling enforcement later must use:

   ```bash
   node ~/.cursor/token-saver/token-saverctl.mjs enforce
   ```

Do not change my selected model, MCP servers, permissions, sandbox, approval mode, editor settings, User Rules, Project Rules, or `AGENTS.md`. Do not add prompt-based hooks or automatic follow-up messages.
