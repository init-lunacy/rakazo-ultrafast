# Action cards

Status: design, awaiting review (2026-10-20).

## Why

A bot often finishes a task and can see the next step: book the hotel it found, check
the price again tomorrow, save what it just did as a skill. Today it can only say so in
text, and the user has to type the request back. Hark's most praised feature is the
opposite: offers that run end to end on one tap. This design adds those offers to
Rakazo as **action cards**: the bot offers up to a few next steps, and one tap starts a
normal run that does it.

Two sources are in scope for the design; the first ships first:

1. **Follow-ups to a bot's own work** (this build). The bot offers next steps after a run.
   "Save this as a skill" is one such card.
2. **Inbox and life admin** (later). A routine that reads connected email or a calendar
   offers tasks such as "Answer these 3 emails". This needs no new mechanism: it is a
   routine prompt that calls the same tool. Shipping it is a later routine template.

## Decisions

| Question | Decision |
|---|---|
| Where cards appear | In the chat that made them; a push when nobody was watching the run; one collected list that links back to the source message |
| What a tap does | Starts the task at once, as a normal run under the user's approval rules |
| Lifetime | Open until taken, dismissed, replaced by newer cards from the same chat, or expired. The bot sets an expiry when it matters; otherwise the user's default (3 days) |
| "Save as a skill" | The bot decides when to offer it, inside guards enforced in code. A tap has the bot write an agent skill with the existing `skill_create` tool |
| Collected list | A sidebar entry with a count, shown only while cards are open; a native sheet on mobile |
| Limits | Tunable by each person in settings, within hard ceilings in code |

## Architecture

Offers are their own records, not paused runs. Every tappable card today belongs to a run
waiting for input (`ask` blocks through `pauseRunForInput`), which the stuck-work sweep
cancels after 24 hours and which cannot be replaced. An offer instead starts new work, so
it follows the one run-less precedent, the onboarding `choice` card: posted on a message,
answered by its own RPC.

```
offer_actions (tool, main agent only)
  → ActionOffer rows, status "held"          (survive a pause and resume)
run completes cleanly
  → rows "open", action_offer block on the run's last reply, the bot's older open rows
    in that chat "replaced"
  → push (routine, webhook and routine-watch runs only)
run fails or is cancelled
  → held rows deleted
actionOffers.take
  → claim the row ("taken"), then sendThreadMessage(task, replyTo: source message)
  → an ordinary run
```

## Data

### `ActionOffer` (`packages/db/prisma/schema.prisma`, table `action_offers`)

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `spaceId` | relation to `Space`, cascade | |
| `userId` | relation to `User`, cascade | The run's user; the only person who can act on it |
| `threadId` | relation to `Thread`, cascade | |
| `botId` | relation to `Bot`, cascade | The bot that offered it |
| `groupId?` | relation to `Group`, cascade | Set when the chat is a group chat; the target is then the group, as in `threadTarget` |
| `runId` | relation to `Run`, cascade | The run that offered it |
| `messageId?` | relation to `Message`, cascade | Set on publish. Clearing a chat or deleting the message removes its cards |
| `kind` | `String` | `"task"` or `"save_skill"` |
| `label` | `String` | Button text, at most 60 characters |
| `task` | `String` | The full text the new run receives, at most 2,000 characters |
| `fromOutsideContent` | `Boolean` | Set by code (see Guards) |
| `status` | `String` | `held`, `open`, `taken`, `dismissed`, `replaced`, `expired` |
| `expiresAt` | `DateTime` | |
| `takenRunId?` | `String` | The run a tap started |
| `createdAt`, `updatedAt` | `DateTime` | |

Indexes: `@@index([spaceId, userId, status, expiresAt])` for the list and counts, and
`@@index([threadId, botId, status])` for replacement. Replacement is per bot, so in a group
chat one bot's new cards never close another bot's.

Expiry is evaluated on read: an `open` row whose `expiresAt` has passed reads as expired
everywhere, and is written as `expired` only when an RPC touches it. No sweep job.

A `taken` row with no `takenRunId` whose `updatedAt` is more than a minute old reads as
`open`: its take was interrupted before the run started (see Taking).

### User settings

`User.actionOfferSettings Json?`, validated by `ActionOfferSettingsSchema` in
`packages/contracts`, the single source of every default and ceiling:

| Setting | Default | Range |
|---|---|---|
| `enabled` | `true` | |
| `perReply` | 3 | 1–10 |
| `defaultLifetimeDays` | 3 | 1–30 |
| `saveSkillMinSteps` | 3 | 1–50 |

The column stays null until the user changes something; a parse fills defaults for
missing keys, so adding a setting needs no migration. `MeSchema` gains
`actionOfferSettings` (always fully populated) and `preferences.update` accepts a partial
patch of it.

### Notification preference

`NotificationPreference.offer Boolean @default(true)`, beside `finish`, `help` and
`takeover`, and shown wherever those toggles are.

## Contracts

- **Message block.** A new `action_offer` kind in the `MessageBlock` union
  (`packages/contracts/src/events.ts`), snake_case like `skill_draft` and `app_connect`:
  `{ kind: "action_offer", offers: [{ id, kind, label, task, fromOutsideContent, expiresAt }] }`.
  The block holds the cards' immutable content, so quoting and plain rendering work from
  the message alone. Status is mutable and lives only in the table. Quotes use the labels;
  speech text (`speech-text.ts`) skips the block, so a spoken reply never reads cards
  aloud.
  The kind joins the visible-block lists in `message-visibility.ts` and
  `thread-message-pages.ts`, and the new event joins the thread stream's forwarded types
  there, as `computer.browser_tabs` did.
- **Thread pages.** `ThreadMessagePageSchema` gains `offerStatuses: Record<offerId,
  { status, takenRunId? }>` for the offers on that page, read in the same transaction as
  the messages.
- **Live updates.** A new `thread.action_offer.updated` value in `ProductEventType`,
  appended to the thread's event stream with `{ offerId, status, takenRunId? }`, so an
  open chat updates in place on every device.
- **Counts.** `BotSchema` and the group list schema gain an optional `openOfferCount`
  (absent means 0, so existing fixtures and older clients are unaffected). The web sidebar
  already refreshes the bot list every 3 seconds, and the mobile chat list on its own
  refresh; one grouped count query rides on those, so no new stream is needed. The
  Actions total is the sum.
- **RPCs** (new `actionOffers` namespace in `packages/contracts/src/rpc.ts`, beside
  `approvalRules`):
  - `actionOffers.list()` returns the user's open offers across bots and groups, newest
    first, with the bot or group, `threadId` and `messageId` for the link back.
  - `actionOffers.take({ offerId })` returns `{ runId }`.
  - `actionOffers.dismiss({ offerId })`.
  All use `authed`, check `offer.userId` against the actor, and resolve the chat with
  `resolveThreadTarget`, so ownership and archived bots behave as in `threads.send`.
- **Notifications.** `NotificationMessage.kind` gains `"offer"`, and its push data gains
  `messageId`.

## The tool

`offer_actions`, declared in `builtin-tools.ts`:

```
offer_actions({ offers: [ { label, task, expiresAt? } | { kind: "save_skill" } ] })
```

Its description, and one conditional sentence in the main agent's instructions: when
there is a clear next step the bot could take on request, offer it as a card rather than
asking in text, and write the task so it makes sense on its own later.

**Latest call wins.** Each call replaces the run's held offers, so the bot can revise its
offer before the run ends. The result lists what will be shown.

### Guards (code, not prompt)

Each refusal says what to do instead.

- **Availability.** Offered only when `enabled` is on, only to the main agent (a helper's
  call is refused by `piToolAgent`), and only for runs with a person to tap: triggers
  `user`, `follow_up`, `reaction`, `routine`, `webhook` and `skill`. Runs between bots, voice
  calls, `messaging` runs (the person is on another platform), `created`, `spawn` and
  `tickets` runs do not get the tool.
- **Size.** At most `perReply` offers; label 1–60 characters, task 1–2,000; expiry an
  ISO 8601 time with an offset, in the future and within 30 days, defaulting to
  `defaultLifetimeDays`.
- **Secrets.** Labels and tasks pass through the run's secret redaction
  (`redactConnectorPayload` with the run's secrets) before they are stored, like any text
  the run publishes.
- **Save as skill.** Accepted only when the run has made at least `saveSkillMinSteps` tool
  calls so far, did not run a saved skill (`promptInvokesSkill`), was not itself started
  by a save-skill card (an `ActionOffer` with `kind: "save_skill"` and this run as its
  `takenRunId`), and has no other save-skill offer. The card's label and task are
  written by code; the model only asks for the kind.
- **Outside content.** `fromOutsideContent` is set by code when the run read anything it
  did not get from its user: any browser or computer tool, web search or fetch, a
  connected app or MCP read, or a `webhook` trigger's payload. Known limit: it covers the
  run's own reads, not outside text that reached it through earlier turns in the chat.
  The defence there is the same as everywhere: the card shows the full task, and the run
  it starts is bound by the user's approval rules.
- **Turning cards off** removes the tool from new runs. A run that already holds offers
  still publishes them; the setting was on when it made them.

### Publishing

When the run completes cleanly (the executor's completion path, the same place the final
reply is written):

1. Held offers become `open`, in one transaction that also marks the thread's other `open`
   offers `replaced`.
2. The `action_offer` block is appended to the run's last reply message. A run with no
   reply, such as a routine that answered `NO_RESPONSE`, gets a bot message holding only
   the cards.
3. `thread.action_offer.updated` events go out for every row that changed.
4. Runs started by `routine`, `webhook` or routine-watch send one push per run, kind
   `"offer"`: title the bot's name, body the first label plus "and N more", `collapseId`
   per thread so newer cards replace the older notification. This push replaces that run's
   completion push and respects `NotificationPreference.offer`. It is skipped when the new
   cards have the same labels as the ones they replaced, so a routine that offers the same
   thing every 15 minutes notifies once.

When the run fails or is cancelled, held offers are deleted. A run that pauses for input
keeps them held, so they survive a resume in another worker, and the stuck-work sweep's
cancellation deletes them like any other failure.

## Taking and dismissing

`actionOffers.take`:

1. **Claim.** One conditional update moves the offer from `open` (unexpired, or an
   interrupted take older than a minute) to `taken`. Only one caller can win, so two
   devices tapping at once start one run; the loser gets `CONFLICT` with status `taken`.
   An expired offer is written `expired` and refused the same way.
2. **Refuse a waiting chat.** If that chat has a run waiting for input or takeover, the
   claim is undone and the call returns `CONFLICT`: "Answer {bot}'s question first."
   Sending text into such a chat answers the waiting question, and a tapped card must
   never become an answer by accident.
3. **Send.** `sendThreadMessage(actor, target, { text: task, replyToMessageId: messageId,
   clientNonce: offer.id })`. Replying to the source message gives the new run its
   context. The nonce makes a retry after an interrupted take replay the same message
   instead of starting a second run. If the bot is busy in that chat, the task steers the
   active run exactly as a typed message would.
4. **Finish.** Store `takenRunId`, emit `thread.action_offer.updated`, return `{ runId }`.

A save-skill card's task, written by code: "Save what you did in the message I'm replying
to as a skill with `skill_create`, so any bot can repeat it. Describe the steps, the
inputs it needs, and how to tell it worked."

If step 3 fails (no model set up, a teaching session is active), the claim is undone and
the error is shown as for `threads.send`. If the server stops between steps 1 and 4, the
offer reads as `open` again after a minute, and taking it again replays through the
nonce.

`actionOffers.dismiss` marks an `open` offer `dismissed`; dismissing one that is no longer open
returns its current status without error.

## Screens

New copy, all of which the PR will quote and justify: **"Actions"**, **"Dismiss"**,
**"From outside content"**, **"Answer {bot}'s question first."**, and the four setting
names.

### Web

- **`OfferCard`** under the bot's message, from the vendored shadcn `Card` and `Button`:
  the label as the button, the task as one muted line that expands, "Dismiss" on hover
  or focus, and the "From outside content" tag when set. Taken shows as done with a link
  to its run; expired, replaced and dismissed collapse to one muted line.
- **Sidebar:** an "Actions" entry with the open count, using the sidebar's existing item
  component, shown only while the count is above zero. It opens the list in the existing
  `ResizableSidePanel`: bot avatar and name, label, expiry, and the card's button. A row
  opens its chat and jumps to the source message with the existing jump-to-message.
- **Settings:** an "Action cards" group under Advanced in account settings.

### Mobile

- The card in the thread beside the existing ask cards, with native buttons; "Dismiss" in
  the card's context menu.
- An "Actions" row with the count at the top of the chat list, shown only while cards are
  open, opening a native sheet; a row opens the thread at the message.
- The same settings in the native settings screen, with native switches and steppers.
- An `"offer"` notification opens the thread at `messageId` through
  `notificationOpenTarget`.

## Errors and edge cases

- Taking a card that is no longer open: `CONFLICT` with its status; both screens show the
  card in that state.
- Two devices tap at once: the conditional claim lets one win; the other sees `taken`.
- A chat waiting for an answer: the tap is refused with "Answer {bot}'s question first",
  shown on the card.
- Turning cards off hides the tool for new runs; open cards stay until they close.
- A deleted or archived bot: its cards cascade away or are filtered from the list, and
  `take` refuses as `threads.send` would.
- Clearing a chat removes its cards through the message cascade.
- Parallel runs in one chat: whichever finishes last replaces the same bot's other open
  cards.
- A card taken from a group chat starts the run in the group, through the same target.

## Testing

All offline and deterministic, extending existing fixtures:

| Layer | Proves | Fixture |
|---|---|---|
| Contracts | settings defaults and ceilings; block, page and RPC schemas | existing contract tests |
| Database (`*.postgres.test.ts`) | held → open on success; deleted on failure and cancel; replacement per bot; expiry on read; one run from two concurrent takes; an interrupted take reopening; refusal while the chat waits for input; owner only; cascade on clear | existing Postgres journey setup |
| Executor | helpers refused; trigger allowlist; every save-skill guard; `fromOutsideContent`; secret redaction; settings applied; tool hidden when off; latest call wins; push only for background runs, replacing the completion push, and skipped for unchanged labels | the `scripted` agent runtime, extended so a scripted turn can call `offer_actions`; `CapturingNotificationProvider` |
| API | `actionOffers.list`, `take`, `dismiss` authorization and the cross-bot list; `openOfferCount` | the `authorization.test.ts` pattern |
| Web | `OfferCard` states; the Actions entry hidden at zero; jump to the source message | existing component test setup |
| Mobile | card states, the list sheet, the notification route | existing mobile tests |
| Web E2E | a chat with cards and the Actions list, with a screenshot for the PR | a new spec using the tab-strip test's request mocking |

## Not in this build

The inbox routine template, action buttons inside notifications, per-bot settings and a
home screen. The design leaves room for each.
