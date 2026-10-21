# Action cards

Status: implemented on 2026-10-21, pending final review (design revised 2026-10-21 after three self-reviews).

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
| What a tap does | Starts the task as an ordinary run under the user's approval rules. The card always shows the full task first. A card never steers a run already in progress: it waits and runs next |
| Lifetime | Open until taken, dismissed, closed by the bot, or expired. Nothing closes a card silently: a bot closes its earlier cards only by naming them |
| "Save as a skill" | The bot decides when to offer it, inside guards enforced in code. A tap has the bot write an agent skill with the existing `skill_create` tool, from a record of what it actually did |
| Collected list | A sidebar entry with a count, shown only while cards are open; a native sheet on mobile |
| Limits | Tunable by each person in settings, within hard ceilings in code |

Also in this build, because cards make it reachable: approval cards in runs where every
side effect needs approval stop offering "Always allow this tool" (see Related fix).

## Architecture

Offers are their own records, not paused runs. Every tappable card today belongs to a run
waiting for input (`ask` blocks through `pauseRunForInput`), which the stuck-work sweep
cancels after 24 hours. An offer instead starts new work, so it follows the run-less
precedent of the onboarding `choice` card (`apps/api/src/onboarding.ts`): its state is
written into the message's own block and announced with the existing
`thread.message.updated` event, under a lock on the thread row. The `ActionOffer` table is
the source of truth for claims, lists and counts; the block mirrors it for display.

```
offer_actions (tool, main agent only)
  → ActionOffer rows, status "held" (invisible; survive a pause and resume)
finalizeRunOnce, run completed (same transaction as the final reply)
  → new held rows "open", an action_offer block on the final reply
  → repeats merge into the bot's matching open cards; cards the bot closed become "closed"
  → push, for routine and webhook runs
actionOffers.take
  → inside the send transaction: claim the row, then add the task as the user's message
    to the offering bot; if that bot is busy the message waits and runs next
  → an ordinary run
```

## Data

### `ActionOffer` (`packages/db/prisma/schema.prisma`, table `action_offers`)

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | |
| `spaceId` | relation to `Space`, cascade | |
| `userId` | relation to `User`, cascade | The run's user; bots, groups and threads are per user, so nobody else sees the card |
| `threadId` | relation to `Thread`, cascade | A group chat's thread carries its `groupId` |
| `botId` | relation to `Bot`, cascade | The bot that offered it |
| `runId` | relation to `Run`, cascade | The run that offered it |
| `messageId?` | relation to `Message`, cascade | Set on publish. Clearing a chat deletes its messages and so its cards |
| `kind` | `String` | `"task"` or `"save_skill"` |
| `label` | `String` | Button text, at most 60 characters |
| `task` | `String` | The text the new run receives, at most 2,000 characters |
| `skillSource?` | `Json` | `save_skill` only: the offering run's tool calls (see Save as a skill) |
| `status` | `String` | `held`, `open`, `taken`, `dismissed`, `closed`, `expired` |
| `expiresAt` | `DateTime` | |
| `takenRunId?` | `String` | The run a tap started |
| `createdAt`, `updatedAt` | `DateTime` | |

Indexes: `@@index([spaceId, userId, status, expiresAt])` for the list and counts, and
`@@index([threadId, botId, status])` for merging and the per-chat cap.

**Held rows** of a run that never completes are left alone: nothing reads `held` rows, and
they go when the run is deleted. This avoids a hook in each cancel path (`stopThreadRuns`,
`clearThread`, superseded runs, the stuck-work expiry, the failure path).

**Expiry** is evaluated on read: an `open` row past `expiresAt` reads as expired in every
RPC and count. When an RPC touches such a row, it writes the status column only (no block
rewrite, no event), so `list` never turns into writes across many threads. The block
carries `expiresAt`, so clients show an expired card on their own. No sweep job.

### User settings

`User.actionOfferSettings Json?`, validated by `ActionOfferSettingsSchema` in
`packages/contracts`, the single source of every default and ceiling:

| Setting | Copy | Default | Range |
|---|---|---|---|
| `enabled` | "Offer next steps" | `true` | |
| `perReply` | "Cards per reply" | 3 | 1–10 |
| `openPerChat` | "Open cards per chat" | 6 | 1–20 |
| `defaultLifetimeDays` | "Keep cards for (days)" | 3 | 1–30 |
| `saveSkillMinSteps` | "Steps before offering to save a skill" | 3 | 1–50 |

The column stays null until the user changes something; a parse fills defaults for missing
keys, so adding a setting needs no migration. `MeSchema` gains `actionOfferSettings`
(always fully populated), and `preferences.update` accepts a partial patch of it (its
"Nothing to update" refine gains the new key).

Pushes follow the existing per-bot `notifyOnFinish` and group rules; no new notification
preference.

## Contracts

- **Message block.** A new `action_offer` kind in the `MessageBlock` union
  (`packages/contracts/src/events.ts`), snake_case like `skill_draft`:
  `{ kind: "action_offer", offers: [{ id, kind, label, task, expiresAt, status,
  takenMessageId? }] }`. Status is mirrored from the table on every change;
  `takenMessageId` lets a taken card link to the message it sent.
  - `blocksToAgentHistoryText` renders it as `[offered: {id} {label}; …]`, so later
    turns know what the bot offered and can close a card by id.
  - Quotes use the labels; speech text skips the block.
  - Older clients ignore unknown kinds (mobile picks blocks by kind; web ends in
    `return null`). A cards-only message may show as an empty bubble on an older app.
- **Counts.** `BotSchema` and `GroupSchema` gain an optional `openOfferCount` (absent
  means 0, so existing fixtures and older clients are unaffected). The web sidebar already
  polls `spaces.list` every 3 seconds and the mobile chat list every 5 seconds while
  focused; one grouped count query rides on those. The Actions total is the sum.
- **RPCs** (new `actionOffers` namespace in `packages/contracts/src/rpc.ts`, beside
  `approvalRules`):
  - `actionOffers.list()` returns the user's open offers across bots and groups, newest
    first, with the bot or group, `threadId` and `messageId` for the link back.
  - `actionOffers.take({ offerId })` returns `{ runId? }` (absent while the task waits
    behind a busy bot).
  - `actionOffers.dismiss({ offerId })`.
  All use `authed`, filter on `actor.spaceId` and `offer.userId`, and resolve the chat with
  `resolveThreadTarget`, so ownership and archived bots behave as in `threads.send`.
- **Notifications.** `NotificationMessage.kind` (`packages/adapter-kit/src/types.ts`)
  gains `"offer"`; `NotificationMessage` and `expoPushData` gain `messageId`.

## The tool

`offer_actions`, declared with the other built-in tools in
`packages/adapters/src/builtin-tools.ts`, and listed in the contracts copy that names the
tools a user can turn off:

```
offer_actions({
  offers: [ { label, task, expiresAt? } | { kind: "save_skill" } ],
  close?: [offerId]
})
```

Its description, and one conditional sentence in the main agent's instructions: when
there is a clear next step the bot could take on request, offer it as a card rather than
asking in text, and write the task so it makes sense on its own later.

- **Latest call wins** within a run: each call replaces the run's held offers, so the bot
  can revise before the run ends.
- **The result lists this bot's open cards in the chat** (id and label), plus what will be
  shown. A routine run, whose turn carries the routine prompt rather than the
  conversation, still sees its earlier cards this way.
- **`close`** names earlier open cards of this bot in this chat that the new offer
  supersedes; they become `closed` when the run completes. Unknown or foreign ids are
  refused with the list of valid ones.
- `offer_actions` joins `UNATTENDED_SAFE_BUILTIN_TOOLS` and `APPROVAL_EXEMPT_TOOLS`: it has
  no outside effect (its rows stay held until the run completes), so a routine or webhook
  run never stops to approve it.

### Guards (code, not prompt)

Each refusal says what to do instead.

- **Availability**, decided in `selectBuiltinToolsForRun` with the flags it already has:
  - only when `enabled` is on;
  - only for runs with a person in this chat to tap: `user` (not a voice call),
    `follow_up` written by the user (`followUpFromUser`), `reaction`, `routine` and
    `webhook`;
  - not for runs between bots, bot handoffs, voice calls, `messaging` runs (the person is
    on another platform), `created`, `spawn`, `tickets`, `cloud_agent` or `skill` test
    runs.
  - A helper's call is refused (`isSubagentToolExecution`); only the main agent offers.
- **Size.** At most `perReply` offers per run; label 1–60 characters, task 1–2,000; expiry
  an ISO 8601 time with an offset, in the future and within 30 days, defaulting to
  `defaultLifetimeDays`.
- **Per-chat cap.** If this bot's open cards in the chat, plus the new ones, minus those
  in `close`, would exceed `openPerChat`, the call is refused with the open list and a
  request to close some. Nothing is dropped silently.
- **Secrets.** Labels, tasks and `skillSource` pass through the same redaction as the run's
  published text (`redactSecrets` with the run's secrets) before they are stored.
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

### Save as a skill

A new run rebuilds its context from the chat's text, so it cannot see the tool calls an
earlier run made, and the stored `steps` block holds only tool names and counts. So when
a save-skill offer is accepted, code records `skillSource`: the offering run's tool calls
so far, as name plus arguments, each argument value cut to 300 characters, at most 60
calls and 8,000 characters, redacted. The executor already sees every call's arguments
(`agent.tool.called` handling), so this is a list it keeps for the run.

When a save-skill card is taken, its run's prompt carries the `skillSource` digest as
context after the visible task, so the bot writes the skill from what it actually did.
The visible message stays the short code-written task: "Save what you did in the message
I'm replying to as a skill with `skill_create`, so any bot can repeat it. Describe the
steps, the inputs it needs, and how to tell it worked."

### Publishing

In `finalizeRunOnce` (`packages/db/src/events.ts`), inside the transaction that writes the
final reply, when the run completed:

1. Drop this run's held offers that have already expired (a paused run can sit for a day).
2. **Merge exact repeats.** A held offer with the same kind, label and task as one of this
   bot's open cards in the chat extends that card's expiry instead of becoming a new
   card; the card's block is rewritten and `thread.message.updated` appended. Anything
   else is a new card, so two different tasks with the same label are never merged and
   neither is lost. A routine whose emails changed offers a new card and closes the old
   one by id (its result lists the open cards); if it forgets, the per-chat cap stops it
   piling up and asks it to close some.
3. Apply `close`: those cards become `closed`, with their blocks updated.
4. The remaining held offers become `open`, and the `action_offer` block is added to the
   final reply's blocks. A completed run with no reply, such as a routine that answered
   `NO_RESPONSE`, gets a bot message holding only the cards. A run that handed off to
   another bot publishes nothing and keeps its offers held: `FinalizeRunInput` gains a
   `handedOff` flag, because finalize cannot tell why a reply is empty.
5. `FinalizeRunResult` gains the ids of offers that were newly opened.

After the transaction, for `routine` and `webhook` runs (routine-watch runs are `routine`)
whose result lists any such offers, and when no continuation run follows:
- the run sends one push, kind `"offer"`, through `runNotice` so the existing recipients
  and `notifyOnFinish` apply: the bot's name as the title, the first label plus "and N
  more" as the body, and `messageId` so a tap opens the message. It replaces the
  completion push for that run, and is sent even when the reply text is empty;
- the chat is marked unread (`completionMarksUnread` treats published cards as content).

Expiry extensions alone do not notify.

## Taking and dismissing

`actionOffers.take`:

1. **Pre-send checks** shared with `threads.send`: the model and teaching checks that
   `threads.send`, `threads.react`, `threads.followUp` and `endCall` repeat inline today
   move into one `assertMayStartTurn(deps, actor, target)` that all of them call. Nothing
   has been changed yet, so a failure needs no undo.
2. **Claim and send in one transaction.** `sendThreadMessage` gains a `beforeSend(tx)` hook
   that runs under the thread lock before the message is created. Take uses it to require
   the offer `open`, unexpired and the actor's, mark it `taken`, and mirror that into its
   block; the claim is final. A second tap on any device, or any later request, is
   refused with `CONFLICT` and the current status. The message is sent with:
   - `text: task`, `replyToMessageId: messageId`, `clientNonce: offer.id`, so a retry of the
     same request replays the same message instead of starting a second run;
   - no automatic one-line reply quote (a new `fullReplyContext` option), so the new run
     receives the whole source message as reply context (the existing 20,000-character
     cap applies); normal replies are unchanged;
   - `targetBotIds: [offer.botId]` in a group chat, so only the offering bot wakes, even if
     the task names others; if that bot has left the group, the take is refused;
   - `holdBehindActiveRun`: if the offering bot has a run `queued` or `running` in this
     chat, the message is held (`runId: null`, as messages behind a routine are today) and
     becomes its own follow-up run when that run finishes, instead of steering it;
   - if the offering bot has a run `waiting_input` or `waiting_takeover` in this chat, the
     take is refused with "Answer {bot}'s question first." Text sent into such a chat
     would answer the question or end the takeover.
3. **Finish.** Store `takenRunId` when a run started, mirror it into the block, and return
   `{ runId }`. A held task's card shows as taken and links to its message; it fills in
   the run once the held message runs.

`actionOffers.dismiss` takes the same thread lock (the block is read, changed and written)
and marks an `open` offer `dismissed`; dismissing one that is no longer open returns its
current status without error.

## Related fix: "Always allow" where approval is mandatory

Webhook runs require approval for every side effect, whatever the user's rules say, yet
their approval cards still offer "Always allow this tool". Answering it saves a
space-wide rule the webhook run then ignores (it asks again), while the rule widens every
ordinary run. A crafted webhook payload could use that to get the owner to permanently
allow something like sending email. `buildApprovalAskBlock` gains `allowAlways`, false
whenever the approval is mandatory (`unattendedTriggerToolRequiresApproval` or an
explicit-approval tool), and leaves the "always" action out. This is independent of action
cards and could go upstream on its own.

## Screens

New copy, which the PR will quote and justify: **"Actions"**, **"Dismiss"**, **"Save as a
skill"**, **"and N more"** (the push), **"Answer {bot}'s question first."**, the settings
group **"Action cards"** and the five setting names above. Card states use icons and muted
text, not words.

### Web

- **`OfferCard`** under the bot's message, from the vendored shadcn `Card` and `Button`:
  the label as the button and the full task as muted text below it (one line, expandable),
  with "Dismiss" on hover or focus. A taken card shows a check icon and links to the
  message it sent; expired, closed and dismissed cards show the label in muted text.
- **Sidebar:** an "Actions" entry with the open count, using the sidebar's existing item
  component, shown only while the count is above zero. It opens the list in the existing
  `ResizableSidePanel`: bot avatar and name, label, task, expiry, and the card's button. A
  row opens its chat and jumps to the source message with the existing `jumpToMessage`.
- **Settings:** an "Action cards" group under Advanced in account settings.

### Mobile

- The card in the thread beside the existing ask cards, with native buttons and the task
  shown; "Dismiss" in the card's context menu.
- An "Actions" row with the count at the top of the chat list, shown only while cards are
  open, opening a native sheet; a row opens the thread at the message with the existing
  `applyMessageJump`.
- The same settings in the native settings screen, with native switches and steppers.
- An `"offer"` notification opens the thread at `messageId` through
  `notificationOpenTarget`.

## Errors and edge cases

- Taking a card that is no longer open, or tapping twice from two devices: one claim wins,
  every other request gets `CONFLICT` with the current status, and both screens show it.
- The bot is busy in that chat: the task waits and runs next, as its own run.
- The bot is waiting for an answer in that chat: refused with "Answer {bot}'s question
  first."
- A card in a group chat runs only the bot that offered it, even if the task names others.
- A routine repeating the same offer keeps one card. A changed task is a new card, and the
  bot closes the old one by id; nothing is silently lost.
- Too many open cards: the bot is refused and asked to close some; nothing is dropped.
- Turning cards off removes the tool from new runs; a run already holding offers still
  publishes them, and open cards stay until they close.
- A deleted or archived bot: its cards cascade away or are filtered from the list, and
  `take` refuses as `threads.send` would.
- Clearing a chat deletes its messages and so its cards.
- Parallel runs: each publishes its own cards; repeats merge and the cap applies to all.

## Testing

All offline and deterministic, extending existing fixtures:

| Layer | Proves | Fixture |
|---|---|---|
| Contracts | settings defaults and ceilings; block and RPC schemas; the `preferences.update` refine | existing contract tests |
| Database (`*.postgres.test.ts`) | publish inside `finalizeRunOnce`; held rows invisible after a failure; expired held offers dropped; exact repeats merged and same-label different tasks kept apart; `close`; nothing published after a handoff; expiry on read; one claim from two concurrent takes; a held task behind a busy run becoming its own run; refusal while waiting; owner and space only; cascade on clear | existing Postgres journey setup |
| Core | `buildApprovalAskBlock` without "always" when approval is mandatory | existing core tests |
| Executor | tool availability per trigger and flag; helpers refused; every save-skill guard; `skillSource` capture, caps and redaction; the per-chat cap; latest call wins; the open-card list in results; history text; offer push and unread for routine runs with empty replies; no push for expiry-only changes | the `scripted` agent runtime, extended so a scripted turn can call `offer_actions`; `CapturingNotificationProvider` |
| API | `actionOffers.list`, `take`, `dismiss` authorization; a group take waking only the offering bot; full reply context; `assertMayStartTurn` shared by every send path; `openOfferCount` | the `authorization.test.ts` pattern |
| Web | `OfferCard` states; the Actions entry hidden at zero; jump to the source message | existing component test setup |
| Mobile | card states, the list sheet, the notification route | existing mobile tests |
| Web E2E | a chat with cards and the Actions list, with a screenshot for the PR | a new spec using `computer-browser-tabs.spec.ts`'s request mocking |

## Corrections from planning and implementation

Where this section and the text above differ, this section is what the code does.

**Data.** `ActionOffer` gains `closingRunId`: a close takes effect only when the closing run completes. `userId` is a plain column, like `Run.userId`. Held cards keep the order the model gave them, and `replaceHeldActionOffers` takes the thread lock first, the same order as `finalizeRun`. Action card settings merge in one SQL statement, so two devices never overwrite each other.

**Taking a card.** A card taken while its bot is busy is a held `SteeringMessage` with `originTrigger: "action_offer"`. `claimSteering` never takes it; it becomes a private `follow_up` continuation, and `runTookOutsideSteering` does not count the owner's queued card as outside content, so the continuation keeps fleet tools. The take claims the card, sends its task, and records the run and the block's "taken" state in one transaction, through `beforeSend` and `afterSend`. A tap racing the first replays the same message; any later tap gets `CONFLICT`. A queued card links to its message, and `takenRunId` is set only when a run started at once. Stopping the bot reopens a card whose queued task the stop dropped, and clears the message nonce so the card can be taken again.

**Send options.** `queueBehindActiveRun` (which also refuses a bot waiting for the user) replaces the spec's `holdBehindActiveRun` and `refuseWhenWaiting`. The other options are `fullReplyContext`, `targetBotIds`, `beforeSend` and `afterSend`. A take passes no `releaseTakeover`. `prepareTurn` (model, then target, then teaching, the order `threads.send` used) is shared by `threads.send` and `actionOffers.take`; `threads.react`, `threads.followUp` and `endCall` keep their differing checks.

**Refusals.** They carry `data.reason`: `card_closed` with `status`, `waiting_for_answer` with `botName`, or `left_group`. The apps render them in the user's language. A closed card just shows its state.

**The tool.** `resume` and `call_end` runs do not get it. It redacts every nested string before encoding or cutting, refuses a card that still contains a secret, and refuses malformed offers. Clearing offers is allowed even when the open count is above a lowered cap. The save-skill source covers tool calls since the run last started or resumed; the step count reads the run's `agent.tool.called` events, so it survives a pause.

**Save as a skill.** In a run started by a save-skill card, `skill_create` always needs approval: no "Always allow" and no automatic review. The recorded tool calls are untrusted text, so the user sees the skill before it is saved.

**Publishing.** `FinalizeRunResult.publishedOffers` is optional and present only when cards opened. The spec's `handedOff` flag is `publishOffers`, false after a handoff or a loop-guard stop. A message holding only cards previews by its labels. Offer pushes follow the bot's `notifyOnFinish` and group rules through the unchanged `notifyRun`.

**Screens.** The web card lives with the other message cards in `apps/web/src/pages/shell/message-cards.tsx`. "Open a chat at a message" is one helper, `chatMessagePath`, shared with the routine run history. The web list is a page at `/app/actions`, like Artifacts, opened from a sidebar row; `/app/actions` is reserved in `bootstrap-target`. The side panel opens only inside a chat. The mobile card is `components/OfferCard.tsx` with `NativeActionButton`. Mobile number settings use native menus of preset values through `MenuPicker`, with no stepper, and keep a saved value that is outside the presets. A taken card in the mobile thread opens its message.

**Known limit.** Held cards of a parallel run in the same chat are not counted toward `openPerChat` until they open.

## Not in this build

The inbox routine template, action buttons inside notifications, per-bot settings, a home
screen, and parallel runs per bot (several tasks at once on one computer). The last is its
own sub-project, building on the browser tab registry. The design leaves room for each.
