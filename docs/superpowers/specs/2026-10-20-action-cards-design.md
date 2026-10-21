# Action cards

Status: design, awaiting review (revised 2026-10-21 after two self-reviews).

## Why

A bot often finishes a task and can see the next step: book the hotel it found, check
the price again tomorrow, save what it just did as a skill. Today it can only say so in
text, and the user has to type the request back. Hark's most praised feature is the
opposite: offers that run end to end on one tap. This design adds those offers to
Rakazo as **action cards**: the bot offers a few next steps, and one tap starts a normal
run that does it.

Two sources are in scope for the design; the first ships first:

1. **Follow-ups to a bot's own work** (this build). The bot offers next steps after a run.
   "Save as a skill" is one such card.
2. **Inbox and life admin** (later). A routine that reads connected email or a calendar
   offers tasks such as "Answer these 3 emails". This needs no new mechanism: it is a
   routine prompt that calls the same tool. Shipping it is a later routine template.

## Decisions

| Question | Decision |
|---|---|
| Where cards appear | In the chat that made them; a push for routine and webhook runs; one collected list that links back to the source message |
| What a tap does | Starts the task at once, as a normal run under the user's approval rules |
| Lifetime | Open until taken, dismissed, replaced by the same bot's newer cards in that chat, or expired. The bot sets an expiry when it matters; otherwise the user's default |
| "Save as a skill" | The bot decides when to offer it, inside guards enforced in code. A tap has the bot write an agent skill with the existing `skill_create` tool |
| Collected list | A sidebar entry with a count, shown only while cards are open; a native sheet on mobile |
| Limits | Tunable by each person in settings, within hard ceilings in code |

## Architecture

Offers are their own records, not paused runs. Every tappable card today belongs to a run
waiting for input (`ask` blocks through `pauseRunForInput`), which the stuck-work sweep
cancels after 24 hours and which cannot be replaced. An offer instead starts new work, so
it follows the run-less precedent of the onboarding `choice` card
(`apps/api/src/onboarding.ts`): its state is written into the message's own block and
announced with the existing `thread.message.updated` event, under a lock on the thread
row. The `ActionOffer` table is the source of truth for claims, lists and counts; the
block mirrors it for display.

```
offer_actions (tool, main agent only)
  → ActionOffer rows, status "held" (invisible; survive a pause and resume)
finalizeRunOnce, run completed (same transaction as the final reply)
  → this run's held rows "open"; an action_offer block on the final reply
  → the same bot's older open rows in that thread "replaced", their blocks updated
  → push, for routine and webhook runs, through the existing runNotice
actionOffers.take
  → claim the row under the thread lock, then send the task as a user message that
    wakes only the offering bot and refuses a chat waiting for an answer
  → an ordinary run (or, for a card made from outside content, an action_offer run)
```

## Data

### `ActionOffer` (`packages/db/prisma/schema.prisma`, table `action_offers`)

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `spaceId` | relation to `Space`, cascade | |
| `userId` | relation to `User`, cascade | The run's user; the only person who can act on it |
| `threadId` | relation to `Thread`, cascade | A group chat's thread carries its `groupId`, so the offer needs no group column |
| `botId` | relation to `Bot`, cascade | The bot that offered it |
| `runId` | relation to `Run`, cascade | The run that offered it |
| `messageId?` | relation to `Message`, cascade | Set on publish. Clearing a chat deletes its messages and so its cards |
| `kind` | `String` | `"task"` or `"save_skill"` |
| `label` | `String` | Button text, at most 60 characters |
| `task` | `String` | The text the new run receives, at most 2,000 characters |
| `fromOutsideContent` | `Boolean` | Set by code (see Guards) |
| `status` | `String` | `held`, `open`, `taken`, `dismissed`, `replaced`, `expired` |
| `expiresAt` | `DateTime` | |
| `takenRunId?` | `String` | The run a tap started or steered |
| `createdAt`, `updatedAt` | `DateTime` | |

Indexes: `@@index([spaceId, userId, status, expiresAt])` for the list and counts, and
`@@index([threadId, botId, status])` for replacement.

Held rows of a run that never completes are never deleted by a separate step: nothing
reads `held` rows, and they go when the run is deleted. This avoids a hook in each of the
many cancel paths (`stopThreadRuns`, `clearThread`, superseded runs, the stuck-work
expiry, the failure path).

**Expiry** is evaluated on read: an `open` row past `expiresAt` reads as expired in every
RPC and count, and is written `expired` when one touches it. The block carries
`expiresAt`, so clients show an expired card without a server update. No sweep job.

**An interrupted take** (the server stops after the claim and before the send finishes)
is detected precisely, not by time: the take's message uses the offer id as its
`clientNonce`, so a `taken` row without `takenRunId` is reconciled on the next read by
looking up that message in the thread. Found: the row gets its `takenRunId`. Not found:
the row returns to `open`.

### User settings

`User.actionOfferSettings Json?`, validated by `ActionOfferSettingsSchema` in
`packages/contracts`, the single source of every default and ceiling:

| Setting | Copy | Default | Range |
|---|---|---|---|
| `enabled` | "Offer next steps" | `true` | |
| `perReply` | "Cards per reply" | 3 | 1–10 |
| `defaultLifetimeDays` | "Keep cards for (days)" | 3 | 1–30 |
| `saveSkillMinSteps` | "Steps before offering to save a skill" | 3 | 1–50 |

The column stays null until the user changes something; a parse fills defaults for missing
keys, so adding a setting needs no migration. `MeSchema` gains `actionOfferSettings`
(always fully populated), and `preferences.update` accepts a partial patch of it (its
"Nothing to update" refine gains the new key).

Pushes use the existing per-bot `notifyOnFinish` and group rules through `runNotice`; no
new notification preference.

## Contracts

- **Message block.** A new `action_offer` kind in the `MessageBlock` union
  (`packages/contracts/src/events.ts`), snake_case like `skill_draft`:
  `{ kind: "action_offer", offers: [{ id, kind, label, task, fromOutsideContent,
  expiresAt, status, takenMessageId? }] }`. Status is mirrored from the table on every
  change; `takenMessageId` lets a taken card link to the message it sent.
  - `blocksToAgentHistoryText` renders it as `[offered: label; label]`, so in later turns
    the bot knows what it offered.
  - Quotes use the labels; speech text skips the block.
  - Older clients ignore unknown kinds (mobile picks blocks by kind; web ends in
    `return null`). A cards-only message may show as an empty bubble there, which is
    acceptable for an older app.
- **Counts.** `BotSchema` and `GroupSchema` gain an optional `openOfferCount` (absent
  means 0, so existing fixtures and older clients are unaffected). The web sidebar
  already polls `spaces.list` every 3 seconds and the mobile chat list every 5 seconds
  while focused; one grouped count query rides on those. The Actions total is the sum.
- **RPCs** (new `actionOffers` namespace in `packages/contracts/src/rpc.ts`, beside
  `approvalRules`):
  - `actionOffers.list()` returns the user's open offers across bots and groups, newest
    first, with the bot or group, `threadId` and `messageId` for the link back.
  - `actionOffers.take({ offerId })` returns `{ runId }`.
  - `actionOffers.dismiss({ offerId })`.
  All use `authed`, filter on `actor.spaceId` and `offer.userId`, and resolve the chat with
  `resolveThreadTarget`, so ownership and archived bots behave as in `threads.send`.
- **Run trigger.** `RUN_TRIGGERS` gains `action_offer`, used only for runs taken from a card
  made from outside content (see Taking). It is conversational, not owner-started, and
  `unattendedTriggerToolRequiresApproval` treats it like `webhook`.
- **Notifications.** `NotificationMessage.kind` (`packages/adapter-kit/src/types.ts`)
  gains `"offer"`; `NotificationMessage` and `expoPushData` gain `messageId`.

## The tool

`offer_actions`, declared with the other built-in tools in
`packages/adapters/src/builtin-tools.ts` and listed in the contracts copy that names the
tools a user can turn off:

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

- **Availability**, decided in `selectBuiltinToolsForRun` with the flags it already has:
  - only when `enabled` is on;
  - only for runs with a person in this chat to tap: `user` (not a voice call),
    `follow_up` written by the user (`followUpFromUser`), `reaction`, `routine`,
    `webhook` and `action_offer`;
  - not for runs between bots, bot handoffs, voice calls, `messaging` runs (the person is
    on another platform), `created`, `spawn`, `tickets`, `cloud_agent` or `skill` test
    runs.
  - A helper's call is refused (`isSubagentToolExecution`); only the main agent offers.
- **Size.** At most `perReply` offers; label 1–60 characters, task 1–2,000; expiry an
  ISO 8601 time with an offset, in the future and within 30 days, defaulting to
  `defaultLifetimeDays`.
- **Secrets.** Labels and tasks pass through the same redaction as the run's published
  text (`redactSecrets` with the run's secrets) before they are stored.
- **Save as a skill.** Accepted only when:
  - the run has made at least `saveSkillMinSteps` tool calls so far, counting helpers'
    calls and not counting `offer_actions`;
  - it did not run a saved or agent skill (`invokedSkill`, `promptInvokesSkill`, or an
    agent-skill expansion);
  - it was not itself started by a save-skill card (its source message's `clientNonce` is
    the id of a `save_skill` offer);
  - it has no other save-skill offer.
  The card's label ("Save as a skill") and task are written by code; the model only asks
  for the kind.
- **Outside content.** `fromOutsideContent` is true unless every tool call in the run
  was on a short allowlist of calls that read only the user's own data in this chat
  (memory, scratchpad, the thread's files, schedule and task tools). Browser, computer,
  shell, web, connected-app, MCP, helper and agent-connection calls all flag it, as does
  a `webhook` trigger. Defaulting to flagged means a new tool is treated as outside
  content until someone decides otherwise.

### Publishing

In `finalizeRunOnce` (`packages/db/src/events.ts`), inside the transaction that writes
the final reply, when the run completed:

1. Drop this run's held offers that have already expired (a paused run can sit for a
   day).
2. **Unchanged offers.** If the remaining labels equal the labels of the same bot's open
   offers in that thread, keep the existing rows, extend their expiry, delete the new
   ones, and post nothing new. A routine that offers the same card every 15 minutes
   neither repeats the message nor notifies again.
3. Otherwise: the held rows become `open`; the `action_offer` block is added to the final
   reply's blocks (a run with no reply, such as a routine that answered `NO_RESPONSE`,
   gets a bot message holding only the cards); the same bot's other open offers in that
   thread become `replaced`, and their messages' blocks are updated with
   `thread.message.updated`.

After the transaction, for `routine` and `webhook` runs (routine-watch runs are
`routine`) that published new cards, the run's completion push becomes an offer push,
sent through `runNotice` so the existing recipients and `notifyOnFinish` apply: title the
bot's name, body the first label plus "and N more", `messageId` so a tap opens the
message. When nothing new was published, the completion push follows today's rules.

## Taking and dismissing

`actionOffers.take`, following the `choice` card's pattern:

1. **Claim**, in a transaction holding the thread row lock (`SELECT … FOR UPDATE`): the
   offer must belong to the actor, be `open` and unexpired (an expired one is written
   `expired` and refused with `CONFLICT`). Mark it `taken`, mirror the status into its
   block, and append `thread.message.updated`.
2. **Checks** the `threads.send` handler runs before sending, which live in the router,
   not in `sendThreadMessage`: a model is set up, and no teaching session is active
   (`assertTeachingSendAllowed`). On failure the claim is undone and the error shown as
   for `threads.send`.
3. **Send** through `sendThreadMessage` with:
   - `text: task`, `replyToMessageId: messageId`, `clientNonce: offer.id`;
   - the full source message as reply context, not the automatic one-line preview, so the
     new run sees what the bot said when it made the offer (the reply context's existing
     20,000-character cap applies);
   - for a group chat, an explicit mention of the offering bot and no wake by name or
     fallback, so only that bot runs (`resolveGroupTargetBotIds` gains an
     explicit-mentions-only option); if that bot has left the group, the take is refused;
   - `refuseWhenWaiting`: a new option checked inside the send transaction, so a chat
     whose run is waiting for input or takeover refuses the message with "Answer {bot}'s
     question first." rather than taking it as the answer. The claim is then undone;
   - trigger `action_offer` when the card is `fromOutsideContent`, so the run gets the
     same approval gating as a webhook run; otherwise the ordinary `user` trigger.
   If the bot is already working in that chat, the task steers that run exactly as a typed
   message would.
4. **Finish.** Store `takenRunId`, mirror it into the block, return `{ runId }`.

The nonce also makes a retry after an interrupted take replay the same message instead
of starting a second run.

**A save-skill card** sends code-written text: "Save what you did in the message I'm
replying to as a skill with `skill_create`, so any bot can repeat it. Describe the steps,
the inputs it needs, and how to tell it worked." Its reply context also carries the source
run's tool steps (the message's `steps` block, which history text otherwise drops), so the
bot writes the skill from what it actually did.

`actionOffers.dismiss` marks an `open` offer `dismissed` and mirrors it into the block;
dismissing one that is no longer open returns its current status without error.

## Screens

New copy, which the PR will quote and justify: **"Actions"**, **"Dismiss"**, **"From
outside content"**, **"Save as a skill"**, **"and N more"** (the push), **"Answer
{bot}'s question first."**, the group title **"Action cards"** and the four setting names
above. Card states use icons and muted text, not words.

### Web

- **`OfferCard`** under the bot's message, from the vendored shadcn `Card` and `Button`:
  the label as the button, the task as one muted line that expands, "Dismiss" on hover or
  focus, and the "From outside content" tag when set. A taken card shows a check icon and
  links to the message it sent; expired, replaced and dismissed cards show the label in
  muted text.
- **Sidebar:** an "Actions" entry with the open count, using the sidebar's existing item
  component, shown only while the count is above zero. It opens the list in the existing
  `ResizableSidePanel`: bot avatar and name, label, expiry, and the card's button. A row
  opens its chat and jumps to the source message with the existing `jumpToMessage`.
- **Settings:** an "Action cards" group under Advanced in account settings.

### Mobile

- The card in the thread beside the existing ask cards, with native buttons; "Dismiss" in
  the card's context menu.
- An "Actions" row with the count at the top of the chat list, shown only while cards are
  open, opening a native sheet; a row opens the thread at the message with the existing
  `applyMessageJump`.
- The same settings in the native settings screen, with native switches and steppers.
- An `"offer"` notification opens the thread at `messageId` through
  `notificationOpenTarget`.

## Errors and edge cases

- Taking a card that is no longer open: `CONFLICT` with its status; both screens show the
  card in that state.
- Two devices tap at once: the thread lock lets one claim win; the other sees `taken`.
- A chat waiting for an answer: refused inside the send, never taken as the answer.
- A card in a group chat runs only the bot that offered it, even if the task names others.
- A card made from outside content starts a run gated like a webhook run.
- Turning cards off removes the tool from new runs; a run already holding offers still
  publishes them, and open cards stay until they close.
- A deleted or archived bot: its cards cascade away or are filtered from the list, and
  `take` refuses as `threads.send` would.
- Clearing a chat deletes its messages and so its cards.
- Parallel runs in one chat: whichever finishes last replaces the same bot's other open
  cards.

## Testing

All offline and deterministic, extending existing fixtures:

| Layer | Proves | Fixture |
|---|---|---|
| Contracts | settings defaults and ceilings; block and RPC schemas; the `preferences.update` refine | existing contract tests |
| Database (`*.postgres.test.ts`) | publish inside `finalizeRunOnce`; held rows invisible after a failure; expired held offers dropped; unchanged offers kept without a new message; replacement per bot; expiry on read; one claim from two concurrent takes; an interrupted take reconciled by nonce; refusal inside the send while waiting; owner and space only; cascade on clear | existing Postgres journey setup |
| Core | `resolveGroupTargetBotIds` explicit-only; webhook gating for `action_offer` | existing core tests |
| Executor | tool availability per trigger and flag; helpers refused; every save-skill guard; `fromOutsideContent` allowlist; redaction; settings applied; latest call wins; history text; offer push replacing the completion push only when new cards were published | the `scripted` agent runtime, extended so a scripted turn can call `offer_actions`; `CapturingNotificationProvider` |
| API | `actionOffers.list`, `take`, `dismiss` authorization; group take waking only the offering bot; full reply context; `openOfferCount` | the `authorization.test.ts` pattern |
| Web | `OfferCard` states; the Actions entry hidden at zero; jump to the source message | existing component test setup |
| Mobile | card states, the list sheet, the notification route | existing mobile tests |
| Web E2E | a chat with cards and the Actions list, with a screenshot for the PR | a new spec using `computer-browser-tabs.spec.ts`'s request mocking |

## Not in this build

The inbox routine template, action buttons inside notifications, per-bot settings and a
home screen. The design leaves room for each.
