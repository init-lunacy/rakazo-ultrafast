# Browsing benchmark (Phase 1) design

## Why

Rakazo Ultrafast's main claim is browsing speed and reliability, but nothing measures it.
The live check of browser tabs and action cards found a Stop regression, snapshot
truncation and tabs piling up, all by hand. This benchmark makes that check repeatable:
one command runs a fixed set of browsing tasks through the real product against a real
bot computer, and reports success, task time, steps and cost. Run it before and after a
change to see whether browsing got faster or better.

## Scope

Phase 1 only:

- **Fixtures:** one suite of four tasks on synthetic local sites.
- **Model and runs:** one model connection per run. It runs on demand, locally.
- **Measured:** success, task time, steps and cost.

Not in Phase 1, decided later from real use:

- more tasks;
- a separate site container with real hostnames;
- helper and tab metrics;
- model comparison in one run;
- a pack of tasks on real websites.

Nothing here is built ahead for those phases.

## Principles

- **Extend, don't fork.** The benchmark is a new suite in the existing live eval runner
  (`pnpm test:evals`). It reuses its trials, fresh accounts, spend cap, pricing, failure
  categories and report. Where two copies of a pattern already exist, this work extracts
  one shared helper instead of adding a third.
- **One source of truth.** All site content lives in one checked-in `sites.json`.
  - The site server renders pages from it.
  - Graders compute expected answers from it, never from typed-in values.
- **Grade outcomes, not claims.** Results come from files the bot wrote, the site's
  request log and the product's own records. The model's prose is not the grade.
- **Offline tests first.** Everything except the live run is covered by deterministic
  tests that need no model and no Docker. One emulator run-through uses Docker, in the
  existing manual lane.

## Running it

```bash
pnpm test:evals --live --suite browsing \
  --provider anthropic --model claude-sonnet-5-5 --api-key-env ANTHROPIC_API_KEY \
  --pricing packages/testkit/src/evals/fixtures/pricing-anthropic-sonnet-5-5-<date>.json \
  --trials 3 --spend-cap-usd 5
```

- **Requirements:** Docker and a built computer image (`pnpm sandbox:build`).
- **Missing image:** the run stops before any trial and names that command.
- **Everything else as today:** `--list`, `--case`, `--trials`, `--output` and the spend
  cap behave as they do now.

## Fixture sites

`packages/testkit/src/evals/browsing/`:

| File | Role |
|---|---|
| `sites.json` | All content: shop products, the checkout item, the article. It also carries `version` (`browsing-v1`), which becomes the report's fixture version. |
| `site_server.py` | One Python standard-library server. It takes the data path, port and log path as arguments. |
| `cases.ts` | `BROWSING_EVAL_CASES` and `BROWSING_FIXTURE_VERSION`, with graders that read `sites.json`. Imports stay light so `--list` keeps working without a database. |
| `install.ts` | `installBrowsingSites` and `readSiteRequests`, built on the shared fixture-server helper below. |

The server runs inside the bot's computer on `127.0.0.1:8800`, the same placement as the
existing contacts and visual fixtures. It is a real `.py` file rather than Python inside a
TypeScript string, because it is larger than those fixtures and should be readable and
lintable on its own.

**Shop (`/shop`)**
- Search (`q`), category filter and pages of 10, sorted by name.
- Product pages carry facts the listing does not show: sizes, stock, waterproofing and a
  specs table.

**Checkout (`/checkout`)**
- Step 1 is contact details; step 2 is quantity and shipping, then confirm.
- Confirming issues an order number and records it in the request log.
- The bot cannot read the number anywhere but the confirmation page.

**Article (`/article`)**
- A long page with a cookie banner that covers the content until dismissed.
- The key section is fetched by the page after a delay from `sites.json` (3 seconds),
  placed far down the page.

**Request log**
- One JSON line per request: method, path, form fields, user agent and the order number
  where one is issued.
- It is written to a directory outside the bot's home.

**Out of the bot's reach.** The browsing cases turn off `shell`, `web_fetch` and
`web_search` for the bot. That leaves the browser as the only way to the sites, and
`write_file` as the only way to save results.
- `read_file` and `write_file` are confined to the bot's home.
- `browser_navigate` accepts only `http(s)`.
- So the bot cannot read `sites.json`, the server or the log, or post to the sites
  outside the browser.

## The four tasks

Each task has exactly one correct answer under `sites.json`. A unit test proves this
before any model runs it.

1. **`browse-compare-cheapest`**: find the cheapest in-stock waterproof jacket available in
   size M, and save `<name> — <price>` to `results/cheapest.md`.
   - **Data shape:** the answer is past page 1 of the jackets listing. Page 1 holds cheaper
     decoys that fail one condition each: not waterproof, out of stock, or no M.
   - **Passes when:** the file holds the expected name and price.
2. **`browse-form-checkout`**: order two of a named item with standard shipping to a fake
   name and address, then report the order number.
   - **Passes when:** the log shows exactly one confirm with the expected item, quantity,
     shipping and address, and the reply contains the logged order number.
   - **Fails:** a double submit.
3. **`browse-extract-csv`**: save the specs of the three hiking boots to
   `results/boots.csv`.
   - **Passes when:** the rows match those built from `sites.json`. Header case, row
     order and surrounding whitespace don't matter.
4. **`browse-hard-page`**: report the year the article says the trail was first mapped,
   and save it to `results/fact.txt`.
   - **Passes when:** the file holds the year, which exists only in the late section, and
     the log shows the late section was requested.

Every task also has a `used-browser` criterion: browser tools appear in the trial's tool
names, and the task's site requests carry a Chrome user agent.

**Limits:** 60 tool calls and 5 minutes per task. Both can be overridden with the
existing flags.

## Runner and CLI changes

### Suite descriptions (`packages/testkit/src/cli/evals.ts`)

The `suites` map entries are `{ cases, fixtureVersion }` today. They grow optional fields
that describe a suite completely:

- `computer: "docker"`: run with real Docker computers instead of `EvalSandboxProvider`.
- `controls`: suite defaults for `timeoutMs` and `maxToolCalls`.
  - Explicit flags still win. The flag defaults move from `parseArgs` into this
    resolution, so the product, history and silence suites keep 180000 ms and 30 calls.
- `fixtures` and `limitations`: the report text that is hard-coded for the product suite
  today. Existing suites keep today's text exactly.

The unknown-suite error lists the map's keys instead of a hard-coded list.

### Shared Docker computer helper (`packages/testkit/src/docker-computers.ts`)

This is extracted from code that already exists twice. Its exports:

- **`dockerComputerEnv(dataDir, image)`:** the pinned settings now written inline in
  `cli/computer-replay.ts`:
  - `DATA_DIR` and `RAKAZO_COMPUTER_IMAGE`;
  - `SANDBOX_SCREEN_NETWORK=published` and `SANDBOX_SCREEN_HOST=127.0.0.1`;
  - `SANDBOX_CONTROL_VIA_LOOPBACK=true`.

  It adds what an eval needs so `.env` cannot leak in: `SANDBOX_PROVIDER=docker`,
  `SANDBOX_IDLE_MS=0` and `SANDBOX_COMPUTER_EGRESS=open`. The replay CLI uses it too.
- **`serveSupervisor()`:** imports `supervisorApp`, serves it on an ephemeral loopback port
  and returns `{ url, close }`. This is lifted from `computer-replay.docker.test.ts`,
  which then uses it.
- **Running as root:** the supervisor refuses homes the computer user (uid 1000) cannot
  write, and by design never changes ownership itself. Compose handles this with
  `data-init`. The harness doesn't re-derive home folder names, which come from the
  space's computer mode and a hashed path. Instead, when the process runs as root, the CLI
  sets `process.umask(0)` before the first trial. The homes the API creates inside this
  run's disposable data directory are then writable by the computer user. That's one
  line, with no dependence on how homes are named.
- **`destroyComputers(prisma, sandbox)`:** destroys every computer row that has a
  provider reference, through `toComputerRef` and `sandbox.destroy`. This follows the
  cleanup loop in `cli/harness.ts`.

### Shared fixture-server helper (`packages/testkit/src/computer-fixture-server.ts`)

`installContactsFixture` and the visual fixture in `computer-use.e2e.test.ts` each
contain their own write, start and poll-until-ready code.
- **Extracted:** `executeChecked`, moved from `computer-replay-fixture.ts` and extended to
  return stdout, and
  `startFixtureServer(sandbox, computer, context, { files, command, readyUrl, logPath })`.
- **Users:** `installContactsFixture` switches to them with unchanged behavior, and
  `installBrowsingSites` uses them.
- **Nothing left in the home:** `installBrowsingSites` writes the server and data into the
  home, because the sandbox writes there. Its start command moves them to
  `/tmp/rakazo-sites` before the server starts. `readSiteRequests` reads the log with
  `executeChecked`.
- **Left alone:** the visual fixture in an upstream end-to-end test, to keep this diff
  small.

### Runner hooks (`packages/testkit/src/evals/runner.ts`, `cases.ts`)

**New case fields, in the same style as the existing `approvalTool` and `connections`:**
- **`EvalCase.disabledBuiltinTools?: string[]`:** the bot field's own name, applied in `setupActor` through the existing
  `bots/update` call that sets the model.
- **`connections: []`:** the browsing cases use the existing field to skip the default
  Composio connections.

**`TrialOptions.computerFixture?`**, supplied by the CLI for Docker suites:

```ts
type ComputerFixture = {
  install(trial: EvalApp, botId: string): Promise<void>;
  siteRequests(trial: EvalApp, botId: string): Promise<SiteRequest[]>;
};
```

When it is present, the runner:
1. calls the existing `computer/boot` RPC, as `taughtSkill` already does;
2. calls `install`;
3. after the steps, puts `siteRequests` into the new optional `Evidence.siteRequests`.
   Other suites never set it.

**Cleanup needs no runner change.** The CLI's `createApp` wrapper already returns
`stop`. For Docker suites, `stop` calls `destroyComputers` before `handles.stop()`.
- **Interrupted runs:** Ctrl-C keeps today's "finish the in-flight trial" behavior, so
  that trial's computer is destroyed too.
- **Hard kills:** these can leave a container behind. The docs give the one `docker ps`
  filter that finds it. There's no automatic sweep, because a sweep broad enough to
  catch it would also remove a developer's own running computers.

**Shared data directory:** Docker suites pass one data directory to every trial, because
the supervisor accepts homes only under its own `DATA_DIR`. Other suites keep a
per-trial directory.

## Metrics

The existing report keeps every field. `latencyMs` keeps its meaning (setup included), so
earlier reports stay comparable. `TrialResult` gains optional `timings`, read from records
the product already writes:

- **`setupMs`:** account and bot setup.
- **`bootMs`:** computer boot and site install.
- **`taskMs`:** the sum over the task's runs of `Run.startedAt` → `Run.completedAt`.
  This is the browsing speed figure.

`summarize` adds `taskMsP50` and `taskMsP95` per case when timings exist.

Steps are the existing `toolCalls`. Tokens and cost, including helper cost under the
existing `subagent` operation, are unchanged.

## Failures

The runner already sorts failures into its existing categories. The new cases add these:

- **Harness:** missing image, boot failure, or the site server never answering. These
  never count against the model.
- **Agent:**
  - a criterion failed: wrong answer, double submit, no browser use, or not a Chrome
    user agent;
  - out of tool calls;
  - timed out.
- **Provider and product:** unchanged.

Stop rules are unchanged. A cleanup failure or a spend-cap hit stops the remaining
trials, which are reported as not run.

## Pricing

Add `fixtures/pricing-anthropic-sonnet-5-5-<date>.json` in the existing `EvalPricing`
shape. It includes `cacheWrite1h`, which the spend guard requires for Anthropic's
one-hour cache writes. Values are copied from Anthropic's public pricing page, with that
page and date as `source` and `version`.

## Tests

All of these run in `pnpm test`, offline:

1. **Site server** (`browsing/site-server.test.ts`): start `site_server.py` with the local
   `python3` on a free port and send plain HTTP requests.
   - Pages render from `sites.json`.
   - Pagination, search and filters work.
   - The banner markup is present, and the late section is served on its own path.
   - The checkout logs exactly what was posted, with one order number per confirm.
2. **One answer per task** (`browsing/cases.test.ts`):
   - Each grader's expected answer is unique under `sites.json`.
   - The answer appears on the rendered page where the task needs it: past page 1, on
     the product pages, or in the late section.
   - The cheapest-jacket decoys each fail exactly one condition.
3. **Graders** (`browsing/cases.test.ts`): canned evidence that passes, and that fails for
   - a double submit;
   - a curl user agent;
   - a right answer with no browser use;
   - a wrong order number.

   CSV header-case, order and whitespace variations pass.
4. **Suite descriptions and CLI** (`evals/cli.test.ts`):
   - Product, history and silence resolve to today's controls, fixtures and limitations
     text.
   - `--list --suite browsing` runs without importing `@rakazo/db` or `@rakazo/adapters`.
5. **Shared helpers:**
   - `dockerComputerEnv` pins every setting even when the environment says otherwise.
   - `startFixtureServer` reports the server log when the server never answers.
   - The contacts replay tests stay green through the extraction.

The Docker wiring is checked by running one live case once (`--case browse-hard-page
--trials 1`, about $0.10). An emulator run-through would need the replay lane to start its
own Postgres and run migrations, which costs more than it proves.

## Docs

`docs/agent-verification.md` gets a row in its layer table and a "Browsing benchmark"
section covering:

- the command and pricing file;
- what is measured, and how to read `taskMs`;
- what isn't measured:
  - shell and web tools are off;
  - the sites are synthetic;
  - one model per run;
  - three trials give a baseline, not a precise rate.

## Rejected alternatives

- **Extending the Docker replay CLI:** it skips the product API, executor, helpers and run
  lifecycle, which is where the live bugs were.
- **A script against a hand-started stack:** state leaks between trials, and it has no
  spend cap or reports.
- **Three sites on three ports:** cross-site comparison is a later phase. One server and
  one port cover Phase 1.
- **A separate site container now:** turning off shell and web tools already keeps the
  sites out of the bot's reach. Real hostnames wait for Phase 2.
- **Answers typed into graders:** they would drift from the data. Graders compute answers
  from `sites.json`.

## Risks

- **Docker network pool:** each trial creates a computer network. Destroying the
  computer in `stop` after every trial keeps the pool from running out.
- **Small `/tmp`:** the run's data directory is created under the OS temp directory,
  which may be a RAM disk. The docs say to point `TMPDIR` at disk if it is small.
- **Late-loading content and downloads:** a page that loads after a delay can still be
  mid-render when the grader runs. Graders read files after the run ends, and the
  late section has a fixed delay.
- **Few trials:** four tasks × three trials is a baseline. The report says so, and does
  not present rates as precise.
