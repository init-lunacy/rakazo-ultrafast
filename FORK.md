# Fork ledger

Rakazo Ultrafast is a downstream fork of [Rakazo](https://github.com/elie222/rakazo). It
tracks upstream closely and carries a small set of changes on top. This file lists every
change the fork carries, where it touches upstream code, and when it can be dropped.

Last upstream sync: `c9bac2782` (2026-10-24).

## How the fork stays close

- **Merge, never rebase.** Upstream is merged into a `sync/upstream` branch, which lands
  on `main` through a pull request once CI is green. `main` is never rebased.
- **Sync often.** Upstream moves fast; a sync every few days keeps each merge small.
  Turn on `git config rerere.enabled true` so a repeated conflict resolves itself.
- **Fork code in its own files.** New behaviour goes in new files or modules. An edit to
  an upstream file stays a small hook into fork code, without reformatting or moving
  upstream code.
- **Upstream first.** A generic fix or speed-up goes to upstream as a small pull request
  with tests (and before and after numbers for performance), opened after an issue for
  anything large. Once upstream merges it, the next sync replaces our copy and the row
  below is removed.
- **Migrations are never renamed or edited** after they ship. A fork migration keeps its
  timestamp even when upstream's land around it.

## Sync checklist

1. `git fetch upstream` and list what touches the files below:
   `git log --oneline <last sync>..upstream/main -- <watched paths>`.
2. Read upstream's security fixes first (row-level security, auth, secrets, sandbox,
   host commands) and check whether a fork change needs the same fix.
3. Merge into `sync/upstream`, resolve conflicts, and regenerate rather than hand-merge
   generated files (`apps/web/src/locales/*/messages.po`, the Prisma client).
4. Run `pnpm check`, `pnpm test` and `pnpm test:integration`, and open the pull request.
5. Update the last sync commit above and any row whose status changed.

## Carried changes

Status: **fork-only** (stays here), **to upstream** (worth proposing), **proposed**
(pull request open upstream), **upstreamed** (drop on next sync).

| Change | Kind | Status | Upstream files it edits (conflict surface) | Drop when |
| --- | --- | --- | --- | --- |
| Action cards (`action_offers`) | feature | fork-only | `db/prisma/schema.prisma`, `db/src/events.ts`, `db/src/row-security.ts`, `adapters/src/executor.ts`, `api/src/thread-target.ts`, `api/src/router.ts`, `contracts/src/{domain,rpc}.ts`, web shell and settings, mobile settings, locales | — |
| Page decider | feature | fork-only (model decider and element rects: to upstream) | `adapters/src/{executor,browser-tools,computer-browser,fake-browser,jev-auto-review}.ts`, `adapter-kit/src/{types,interfaces}.ts`, `rakazo-page-browser`, web bot settings | upstream ships a pluggable page decider |
| Browser tabs | feature | fork-only (runs index, no launch on cleanup: to upstream) | `adapters/src/{executor,browser-tools,computer-browser,pi-runtime}.ts`, `supervisor/src/{index,supervisor-logic}.ts`, `rakazo-page-browser`, web shell, mobile computer screen | upstream ships addressable tabs |
| Browsing benchmark | test | to upstream (fixture server sharing first) | `testkit/src/cli/evals.ts`, `testkit/src/evals/{runner,suites,sandbox}.ts`, `docs/agent-verification.md` | upstream adds a browsing suite |
| Eval step timings (splits upstream's task time into model, computer and product time) | test | to upstream | `testkit/src/evals/{runner,report}.ts` | upstreamed |
| Page text paging and snapshot sizing | bug fix | to upstream | `rakazo-page-browser`, `adapters/src/{browser-tools,computer-browser}.ts` | upstreamed |
| Per-step overhead: token estimate reuse, usage without a transaction | performance | to upstream | `adapters/src/pi-runtime.ts`, `db/src/usage.ts` | upstreamed |
| Per-step overhead: prompt trimming | performance | fork-only (prompt choices upstream may not share) | `adapters/src/{context-selection,executor}.ts` | upstream trims the same guidance |
| Fleet tools only when needed | performance | to upstream | `adapters/src/{pi-runtime,executor,builtin-tools}.ts`, `adapter-kit/src/types.ts` | upstreamed |
| Supervisor screen reuse | performance | to upstream | `supervisor/src/{index,supervisor-logic}.ts` | upstreamed |
| Secret redaction order | bug fix | to upstream | `core` secret redaction | upstreamed |
| Reaction lock order | bug fix | to upstream | `api` reaction path | upstreamed |
| Row-level security coverage test | test | to upstream | `db/src/row-security.ts` | upstreamed |
| Fork integration fixes | glue | fork-only | `testkit/src/authorization.test.ts`, `adapters/src/executor.ts` | — |
| CI and release guards | CI | fork-only | `.github/workflows/*`, `apps/desktop` release test | — |
| Branding and docs | docs | fork-only | `README.md`, `docs/self-host.md` | — |

Migrations the fork adds: `20261013120000_page_decider`, `20261014120000_run_bot_created_index`,
`20261021120000_action_offers`, `20261027190000_action_offers_row_security`. Fork-only model:
`ActionOffer`. Fork-only columns: `bots.pageDeciderProvider`, `bots.pageDeciderModel`,
`user.actionOfferSettings`.

Fork design notes live in `docs/superpowers/` (page decider, browser tabs, action cards,
browsing benchmark).
