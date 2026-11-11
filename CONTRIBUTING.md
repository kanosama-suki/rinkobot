# Contributing

## Requirements

- Node.js 24 or newer;
- npm;
- Windows or Linux for the automated test suite.

## Setup

```bash
npm ci
npm test
npm run check:case
npm run config:check
npm pack --dry-run
```

For a local development page:

```bash
npm run dev
```

The terminal prints a one-time login URL. Do not paste that URL, its token, or
the resulting cookie into an issue, pull request, screenshot, or log attachment.

## Before submitting a change

1. Keep the change focused; do not mix an unrelated refactor into a bug fix.
2. Add or update the closest automated test.
3. Run the full commands listed above.
4. Update `structure.md`, `README.md`, `docs/plan.md`, or `docs/need.md` when the
   directory layout, public behavior, milestone, or product requirement changes.
5. Check `git diff --check` and review the complete diff for accidental secrets.

## Privacy and test data

Never commit:

- real persona files or private relationship details;
- QQ numbers, group numbers, friend lists, or NapCat tokens;
- API keys, access tokens, cookies, SSH keys, passwords, or production logs;
- runtime databases, backups, screenshots of private chats, or model prompts.

Use placeholder identities, fake message IDs, loopback endpoints, and values
that are unmistakably test data. The checked-in `config/examples` directory is
for development only.

## Architecture expectations

- The standalone core owns the main database, scheduler, and lifecycle.
- Modules communicate through public interfaces; `core` must not depend on a
  desktop, editor, DSH, browser worker, or VM.
- Do not introduce a global finite-state machine. Use versioned events, pure
  reducers, policy decisions, event logs, and snapshots.
- Model output is untrusted. It may propose state, memory, and tool actions, but
  deterministic validation decides what is persisted or executed.
- Do not add a dependency unless its license, maintenance status, purpose, and
  removal path are recorded in `docs/mods.md`.

## License

By submitting a contribution, you agree that it may be distributed under the
repository's MIT License.
