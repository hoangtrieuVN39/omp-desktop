# Spike: phone views of background tabs (Giai đoạn 6)

> Status: investigation only, no code changed. Written 2026-11-16 against branch `phone-remote` (commit 1ad777b plus the uncommitted protocol 2 fixes).
> Question from [`PLAN.md`](PLAN.md) Giai đoạn 6: can a phone show and work on tab B while the desktop shows tab A?
> Line numbers are for the files as they were when this was written.

## TL;DR

**Recommendation: option C, a "shadow view" kept in the webview.** For each tab a phone looks at that is **not** the desktop's active tab, a new pure module (`src/app/remote-shadow.js`) builds a phone-sized transcript. It starts from what the desktop already has for that tab: the tab's saved snapshot, or `get_messages` plus `streaming_message` when the tab was never opened. It then reads the tab's Rust journal (`replay_events`) and its live `agent://line/{id}` events. It never touches `live.js`'s module state. Phone actions that make sense on a background tab (answer a question, stop, prompt/steer) go straight to that tab's omp through `send_command`. A small record of the answers the phone gave makes sure the desktop shows those questions as answered when the user later opens the tab.

- Option A (Rust builds the view from the journal) would copy the UI transcript logic into Rust and add a second control path. The plan rules that out, and the journal ring alone is not enough data.
- Option B taken literally (run `live.js`'s own reducer for the tabs in `remote://watch`) cannot work without rewriting `live.js`. That reducer writes one set of globals and sends follow-up commands to the **active** tab (`_send`). Running it for tab B would send B's `get_state`s and cancels to tab A.
- Option C uses B's data sources (the journal plus a webview reducer) and A's idea (Rust already keeps per-session state that outlives the listener). It touches `live.js` only with thin bridge methods and two one-line hooks.

Estimated size: about 1.5k lines including tests (about 700 of production code), 3 to 5 dev days. It needs no design work beyond what the phone already shows: the phone simply stops sending `select` when the server announces `views`.

---

## 1. How it works today (with citations)

### 1.1 Only the active tab is processed

- `live.js` keeps a **single** set of per-tab variables: `state` (`src/live.js:57-103`) plus module `let`s such as `streamingBubble`, `streamAcc`, `activeToolCards`, `pendingAskBubbles`, `lastSeq`, `_replayBuffer`, `extSnapshotSeq` and `streamSnapshot` (`src/live.js:107-133`). A background tab's copy lives in `sessionSnapshots` (`src/live.js:160`), written by `_saveCurrentSession` (`src/live.js:857-906`, including `lastSeq` at `:901`) and read back by `_restoreSession` (`src/live.js:908-950`).
- `_switchToSession` (`src/live.js:972-1175`) saves the tab being left, removes its listeners (`:999-1003`), restores or resets the new one, and then listens to `agent://line/${id}` only for the new tab. The callback checks `current()` (`:1043-1044`). It then replays the journal (`replay_events`, `:1083`). If the replay comes back `dropped`, it also loads `extension_ui_state` (`:1096`) and `streaming_message` (`:1104`). Last it drains the buffered lines (`:1131-1133`) and calls `_initFetch()` (`:1169`). AGENTS.md (Architecture §2) states the rule: "A background tab's frames are not processed until it is activated."
- `_dispatchEnvelope` drops anything at or below the one global `lastSeq` (`src/live.js:2021-2024`). `ready` triggers `_initFetch()` for the active tab (`:2038-2041`).

### 1.2 Frame handlers send commands to the active tab

`_send` always writes to `activeSessionId` (`src/live.js:3058-3067`), and so does `_sendWithResponse` (`:287-327`, the check is at `:291`). The event reducer calls them as side effects:

- `turn_end` → `get_session_stats` plus `get_state` (`src/live.js:2528-2529`);
- `agent_start` / `agent_end` → `get_state` (`src/live.js:2835`);
- an `ask` whose questions cannot be parsed → `extension_ui_response {cancelled}` (`src/live.js:2432-2435`); an unknown `extension_ui_request` method → cancel (`src/live.js:2495`).

The reducer also calls `notify()` on almost every frame, and that publishes the global `state` to React.

### 1.3 Asks are tied to the active tab

- `_askMessage` stamps `sessionId: activeSessionId` (`src/live.js:502-521`, at `:510`). `select` and `ask` go through the `_queueAskBubble` buffer (`:547-556`); `input` / `confirm` / `editor` are pushed directly (`src/live.js:2418-2475`).
- `answerAsk` / `answerAskDialog` / `answerConfirm` / `cancelAsk` (`src/live.js:4177-4222`) all call `_resolveAsk` (`:610-613`). It settles the bubble in the global `state.messages` (`_settleAsk`, `:579-591`), then calls `_send` → active tab. A tab that is not active has no bubble in `state` and no target for `_send`.
- In Rust, `AgentBridge::send` takes **any** `session_id`. It checks the type allowlist, settles approvals and tells the tracker the question is answered (`src-tauri/src/agent/mod.rs:373-401`, `on_answered` at `:399`). So Rust already supports answering a background tab; only the webview is limited to the active one.
- The tracker knows busy state and open question **ids** for every tab (`src-tauri/src/remote/tracker.rs:150-237`, `on_answered` `:215-224`), but not the question content.

### 1.4 What Rust keeps per session

| Store | Contents | Bound | Cite |
|---|---|---|---|
| `EventJournal` | raw stdout lines with `seq` (`Arc<str>`) | 4096 lines **and** 8 MiB per tab | `agent/journal.rs:28-31,58-90`, `agent/mod.rs:51,58,237` |
| `InFlight` | the assistant message being streamed, rebuilt from deltas, with the last applied `seq` | one message | `agent/inflight.rs:1-39,214` |
| `ExtUiState` | extension status lines and widgets with `seq` | 32 keys × 50 lines × 4 KiB | `agent/ext_ui.rs:1-63` |
| tracker | `busy`, open question ids | 64 questions | `remote/tracker.rs` |

The reader pushes every line into the journal, then `ext_ui::record`, then emits it (only while `alive`), then `inflight::record`. This happens for **every** tab whether or not anything listens (`src-tauri/src/agent/reader.rs:356-376`). A respawn under the same tab id creates a new journal, so `seq` starts again at 1 (`agent/mod.rs:237-239`).

### 1.5 The remote pipeline is built around one view

- The hub stores **one** `view: Option<Value>` (`src-tauri/src/remote/hub/state.rs:35`), broadcasts it to every socket (`src-tauri/src/remote/hub.rs:150-165`), and sends it to a new socket after `hello` (`src-tauri/src/remote/hub/connections.rs:56-77`). `PublishPayload` is `{tabs, view, theme}` (`hub.rs:49-54`).
- `remote://watch` is the list of **all** published tab ids whenever any socket is connected (`hub/state.rs:160-170`). The webview ignores the payload and treats the event only as a reason to republish (`src/app/use-remote.jsx:69`).
- `buildView` needs `snapshot.activeSessionId` and reads the global transcript (`src/app/remote-view.js:55-87`). It returns `{tabId, busy, messages[≤100], asks}`. Each message is `{id, role, text, echo?, tool:{name, summary, output≤2000}}`. Asks come from `askCard` (`:16-29`) and are listed separately from the messages (asks are skipped as messages, `:61`). `busy` is `snapshot.isStreaming`.
- The executor calls `ensureTab` for every legacy kind and for every non-`TABLESS` op (`src/app/remote-view.js:160-174,198`), which activates the desktop tab. `answer` waits for the ask in the **active** snapshot (`:226-238`). Protocol 2 ops do the same (`TABLESS` = projects/profiles/approvalModes only, `src/app/remote-ops.js:139`). `toolOutput` reads the active snapshot (`remote-ops.js:107-120`).
- Phone: tapping a tab sends `select` (`src/remote/remote.js:145-152`), and a `view` frame then sets the phone's selected tab (`:191-193`). `select` needs `view` scope (`src-tauri/src/remote/scope.rs:41`).

---

## 2. Options compared

### Option A: Rust builds background views from the journal (`journal.rs`, `inflight.rs`, `ext_ui.rs`)

**Data available.** The journal holds the raw frames, but only the last 4096 lines / 8 MiB. One streamed reply is one line per delta (`agent/mod.rs:45-50`), so a long turn pushes older lines out. To build a view whenever a phone asks, Rust would need a **continuous** per-session reducer in the reader thread, like `inflight.rs` / `ext_ui.rs`: messages, tool cards, asks. Without it, a view built on demand loses everything older than the ring. History from before the process started (a `--resume`d tab) is in neither the ring nor `get_messages` unless Rust asks omp, and it cannot correlate the response without the webview.

**What the phone needs vs what Rust would have to copy.** The tool card `summary` and title, tool-name normalization and outputs come from `buildToolStartCard` / `updateToolCard` / `finalizeToolCard` (`src/adapter.js:277-330`, exported `:595-618`). Failure notices come from `OMP_TURN_STATUS` (`isHidden`, `failureOf`, retry rows; used in `remote-view.js:60` and `live.js:2770-2830`). Steer echo, skill prompts and job rows come from `live.js:2535-2588`. All of this would be written a second time in Rust and drift with every upstream release. That is the plan's highest-rated risk ("Fork lệch upstream").

**Asks/answers.** Rust could answer with `AgentBridge::send` directly. That is a second control path outside the webview, which PLAN.md Approach 1 forbids ("Không tạo đường điều khiển thứ hai"). The desktop would still re-show the question as open when the tab is activated (see §3.4).

**Cost.** The reducer runs on **every** line of **every** tab, in the hot path the tracker rule protects ("must stay O(1) and non-blocking", AGENTS.md *Things easy to break*). A transcript copy per tab sits in Rust memory all the time, even with no phone connected.

**Invariants touched.** Reader hot path (`reader.rs:356-376`); clippy pedantic on a large new module; a new Rust view shape that must match `remote-view.js`.

**Verdict:** rejected. Most code, most drift, and it breaks the "webview is the source of truth" approach.

### Option B (literal): `live.js` also processes the tabs in `remote://watch`

**Data available.** Everything: the same frames the active tab gets.

**Why it fails.** The reducer is `_handleEvent` / `_handleResponse` over module globals (§1.1). Using it for tab B means one of two things:

1. **Swapping globals per frame** (`_restoreSession(B)` → dispatch → `_saveCurrentSession`). While B's state is swapped in, the side effects in §1.2 go to `activeSessionId` (A): B's `turn_end` would send `get_state` to A, and B's unparseable ask would send a cancel with B's request id to A's omp. `notify()` would publish B's transcript to the desktop's React for a moment. `lastSeq` is shared, and the switch-generation guards (`src/live.js:953-970`) assume only one tab is ever being activated. A tab switch or a buffered ask timer (`_queueAskBubble`'s `setTimeout`, `:549-554`) firing while B is swapped in would corrupt both tabs.
2. **Making the state per session**: refactoring a 5154-line file in which nearly every function reads `state` / `activeSessionId`. That rewrites the riskiest code in the repo (AGENTS.md: `_handleResponse` brace chains, transcript merge by `ts`, `abort` staying id-less) and makes every upstream merge painful.

**Watch semantics.** `remote://watch` today means "all tabs" while any phone is connected (`hub/state.rs:160-170`). Literal B would therefore process **every** tab whenever a phone is open, not just the one being looked at.

**Verdict:** rejected in this form. Its sound part, a webview reducer fed by the journal, becomes option C.

### Option C (recommended): a shadow view per viewed background tab, in the webview

**Data available.**
- Seed, best first:
  1. the desktop's own snapshot of B: the exact UI transcript `buildView` expects, with its journal cursor `lastSeq` and the in-progress `streamingBubble`/`streamAcc` (`live.js:857-906`);
  2. for a tab never activated (restored tabs other than the auto-activated one, `live.js:1961-1975`): `get_messages` (adapted by the pure `adaptAgentMessages`, `adapter.js:480-525`) plus `streaming_message` for a reply in progress (`agent/mod.rs:445-453`), with the cursor set to the journal seq of the `get_messages` response line.
- Then: `replay_events(B, cursor)` (`agent/mod.rs:418-428`), then live `agent://line/B`. The reader already emits these for every live tab (`reader.rs:365-367`), so listening adds no Rust work.
- If a replay comes back `dropped`: reseed through path 2, the same recovery the desktop uses (`live.js:1094-1107`).

**What the phone needs** (`buildView` output) and where the shadow gets it:

| View field | Source in the shadow | Reused pure code |
|---|---|---|
| user messages, steer `echo` | `message_start` role user/custom skill | `adaptUserContent` (`adapter.js:469`) |
| assistant text | `message_start` / `message_update` / `message_end` | `OMP_STREAM_DELTA.accFor/applyEvent/view` (`app/stream-delta.js:22-107`) |
| tool `name/summary/output` | `tool_execution_start/update/end` | `buildToolStartCard/updateToolCard/finalizeToolCard` (`adapter.js:277-330`) |
| failure notices, retry rows | `message_end`, `agent_end` yield, `auto_retry_*` | `OMP_TURN_STATUS` (`turn-status.js`; used as in `live.js:2650-2680,2760-2830`) |
| asks | `extension_ui_request` select/confirm/input/editor/ask, plus `cancel` | the `askCard` input shape; `OMP_ASK_DIALOG.parseQuestions` |
| `busy` | `agent_start` / yielding `agent_end` (the tracker's rule, `remote-access.md` *Tracker*) | `OMP_TURN_STATUS.isYield` |
| large frames | `rpc_chunk` runs | `window.reassembleRpcChunks` (`live.js:1194-1218`, pure, exported) |

Because `buildView` lists asks apart from messages (`remote-view.js:59-61`), the shadow does not need `_queueAskBubble`'s tool-card ordering.

**Asks/answers** (details in §3.4): answer through `send_command(B, extension_ui_response)`. Rust then settles approvals and the tracker as it does today (`agent/mod.rs:383-400`). A per-tab record of remote answers marks the bubble answered in B's snapshot and in replayed `_askMessage`s, so the desktop never shows a question the phone already answered as open.

**Cost.** Memory: one transcript array per *viewed* background tab, sharing most entries with B's snapshot (entries are replaced, never mutated). The bound comes from the hub limits, at most 8 sockets (`hub.rs:31`), so at most 8 shadows; in practice one. The 8 MiB journal per tab exists already. CPU: one `JSON.parse` plus a small reducer step per line, for the viewed tabs only. Publishes stay throttled at 4/s (`use-remote.jsx:44-46`). [INFERENCE] Tauri already sends each `agent://line/*` event to the webview, so the IPC cost is not new; only parsing is.

**Invariants touched** (§5): one prefix added to the existing `live-history-` skip in `_handleResponse` (`live.js:2074`); one lookup in `_askMessage`; `abort` stays id-less; nothing the shadow builds enters the desktop transcript, so the `ts` rule is not affected.

### Option D (noted, not recommended now): make all of `live.js` per session

This is the end state that would also give the desktop live background tabs. It is option B.2: a large refactor of the most fragile file, and an upstream-merge burden for every later stage. It can be done later; option C does not block it. The shadow module's reducer is the seed of a per-session reducer.

### Option E (fallback): stale snapshot plus tracker

Show B's last desktop snapshot with the tracker's `busy`/`hasAsk` (already in `tabs`, `hub/state.rs:53-66`), and keep switching tabs for any action. Almost free, but nothing updates live. It is what option C shows if a seed fails.

---

## 3. Recommended design (option C)

### 3.1 Protocol

- `hub.rs:28`: `CAPS` gains `"views"`; `PROTOCOL` stays 2 (a new capability, not a new protocol).
- New phone → server frame **`watch {tabId}`** (`view` scope; `tabId` ≤ 128 bytes and in the published `tabs`, else ignored). It sets the connection's viewed tab and does not touch the desktop. `select` keeps its current meaning (it activates the desktop tab). A phone that sees `views` in `caps` sends `watch` on tab taps and `?tab=` deep links; an old phone keeps sending `select`.
- `PublishPayload` (`hub.rs:49-54`): `view` becomes **`views: Map<tabId, View>`**, plus `active: Option<String>`.
- Hub: each connection has `viewing: Option<String>`. A socket with no `watch` follows `active`, which is today's behaviour, so old phones are unchanged. The server still sends `{t:"view", view}` frames, now **per socket**: on publish, only to the sockets whose viewed tab's view changed, and on `watch`, the current view of that tab right away.
- `remote://watch` payload: the **distinct viewed tab ids** (`viewing`, or `active` for sockets that follow it) instead of all tab ids (`hub/state.rs:160-170`). The webview builds a shadow only for ids in this list that are not active.
- Action routing stays the same on the wire: `action {tabId, …}` already names its tab.

### 3.2 Webview modules

**New `src/app/remote-shadow.js`** (IIFE, `window.OMP_REMOTE_SHADOW`, about 320 lines, pure). It loads after `adapter.js`, `app/stream-delta.js` and `app/turn-status.js` and before `app/remote-view.js` (`src/index.html`, and update `docs/architecture/frontend-load-order.md`).
- `fromSnapshot(snap)` → `{ messages, cursor: snap.lastSeq, busy: snap.isStreaming, stream, tools, chunk: null, gen }`. `stream` is a copy of `snap.streamAcc` made with `OMP_STREAM_DELTA.seed({content: blocks})` (`stream-delta.js:65-68`), so the shadow never changes the desktop's snapshot in place. `tools` is toolCallId → index, rebuilt from running tool cards (as in `live.js:2121-2127`).
- `fromHistory(rawMessages, streamingCopy, cursor)`: seed path 2.
- `apply(shadow, envelope)` → `{ shadow, changed, reseed }`:
  - `seq <= cursor` → skip.
  - `seq` far below `cursor` (the journal restarted after a respawn), or a `ready` frame → `reseed`.
  - `rpc_chunk` → collect, then `reassembleRpcChunks`.
  - Then handle only the frames in the table in §2C. Everything else is ignored, and the shadow sends nothing.
- `view(shadow, tabId, opts)` → the same shape as `buildView`. To share code, `buildView` is split into `viewOf(messages, busy, tabId, opts)`, which both use, and a thin `buildView(snapshot)` wrapper (`remote-view.js:55-87`).
- `settle(shadow, askId, patch)`: the shadow side of an answer.

**`src/live.js`** (about 90 lines added, all thin):
- `_sendTo(sessionId, cmd)`: `send_command` for an explicit id (like `_invokeSend`, `:3064-3067`, but with no `activeSessionId`). It refuses the active id (the normal methods already cover it) and ids not in `sessionRegistry`.
- Bridge methods (next to `remotePublish`, `:4455`):
  - `remoteShadowSeed(id)` → copy of `{messages, lastSeq, isStreaming, streamAcc}` from `sessionSnapshots`, or null;
  - `remoteShadowHistory(id)` → sends `negotiate_protocol` v2 (a never-activated process has not had one, `:3015`; a repeat is harmless, `:3013`) and then `get_messages`, both with ids `remote-shadow-<n>`, and returns the request id (the shadow matches the response line in B's stream by id). Plus `streaming_message`;
  - `onSessionLine(id, cb)` / `onSessionExit(id, cb)` → Tauri `listen` handles (a listener separate from `activeListeners`);
  - `remoteBackgroundAnswer(id, askId, payload, patch)`, `remoteBackgroundAbort(id)`, `remoteBackgroundPrompt(id, text, images, streaming)` (see 3.4 and 3.5).
- `_remoteSettled: Map<sessionId, Map<askId, patch>>`, filled by `remoteBackgroundAnswer`. Consumed in two places:
  1. right away, by applying `patch` to the matching open ask in `sessionSnapshots.get(id).messages` and in its `pendingAskBubbles` (a new array, `_settleAsk`'s rule);
  2. in `_askMessage` (`:502`): when `_remoteSettled.get(activeSessionId)?.get(ev.id)` exists, the bubble is created already settled. That covers the replay of B's journal on activation, both for buffered `select`/`ask` and for direct `input`/`confirm`/`editor`.
  Entries are deleted on settle-at-replay and when the tab closes or respawns.
- `_handleResponse` (`:2074`): the existing `live-history-` early return also covers the `remote-shadow-` prefix. Otherwise, when B is activated, the replayed shadow `get_messages` response would run the uncorrelated merge path (`:2114`). That path is harmless (it is ground truth) but runs twice. This is the **only** edit inside `_handleResponse`, a condition on one existing line, with no new branch.

**`src/app/use-remote.jsx`** (grows from about 95 to about 190 lines; can be split into `app/use-remote-shadows.jsx` if needed): a shadow controller.
- On `remote://watch` (now meaningful) and on every bridge update, compute the wanted set = watched ids that are not active and are in `sessions`.
- Per wanted id:
  1. attach the line/exit listeners (buffer while seeding);
  2. seed (`remoteShadowSeed` → `fromSnapshot`, else `remoteShadowHistory` → `fromHistory`, applied when its response line arrives);
  3. `replay_events(id, cursor)` (reseed when `dropped`);
  4. drain the buffer;
  5. on each `changed`, `schedule()`.
- When an id becomes active, drop its shadow (the view comes from `buildView`). When it stops being active again, reseed from the fresh snapshot. Drop shadows for ids that are no longer wanted (unlisten).
- An exit event marks it not busy plus a notice. Reseed after a respawn (`ready`).
- Publishing: `views = {[active]: buildView(snapshot), ...shadows}`, each compared with `viewsEqual` per id.

**`src/app/remote-view.js`** (about 60 lines added, from 283 to about 345): `makeActionHandler(bridge, getSnapshot, getStatus, getShadow)`.
- Kinds in `BACKGROUND = {answer, abort, prompt, steer, toolOutput}` run without `ensureTab` when `tabId !== activeTab()` and `getShadow(tabId)` exists.
- `answer` waits up to 5 s for the ask in the **shadow** (the same loop as `:226-238`), validates with the same `invalidAnswer`/`answerCall`, and delivers through `bridge.remoteBackgroundAnswer`.
- `toolOutput` uses `OMP_REMOTE_OPS.toolDetail` on the shadow's messages (`remote-ops.js:107`; export it).
- Every other op keeps activating the tab as today.
- The `refusal`/`guard` checks (`:154-161`) apply unchanged; `deliver` (`:200-209`) gets a variant that checks the target is still a background tab with a shadow.

### 3.3 Rust

| File | Change | ~Lines |
|---|---|---|
| `remote/hub.rs` | `CAPS += "views"`; `PublishPayload { tabs, views, active, theme }`; `publish` sends the changed views per socket | 40 |
| `remote/hub/state.rs` | `Entry.viewing`; `views: HashMap<String, Value>`, `active`; `send_view(conn)`; `take_changes` watch = distinct viewed ids | 60 |
| `remote/hub/connections.rs` | initial `view` = the view for `active` (`:65-77`) | 5 |
| `remote/ws/messages.rs` | `Some("watch")` arm: scope check (as `select`, `:27-33`), id bound, `hub.watch(conn, tab_id)` | 20 |
| `remote/scope.rs` | `("watch", Scope::View)` and its test | 5 |
| tests (`ws_tests.rs`, `server_tests.rs`, hub tests) | below | 150 |

The agent layer (`agent/*`) does not change: `replay_events`, `streaming_message` and `send_command` already accept any session id, and the reader already emits every live tab.

### 3.4 Asks and answers on a background tab

1. The phone sends `action {kind:"answer", tabId:B, askId, value}`. Rust checks scope (`control`) as today.
2. The executor finds the open ask in B's shadow and validates it with `invalidAnswer`. `answerCall` maps it to `{value}` / `{confirmed}` / `{answers}` / `{cancelled}`, the same payloads `_resolveAsk` sends (`live.js:4177-4222`).
3. `remoteBackgroundAnswer(B, askId, payload, patch)`: `_sendTo(B, {type:"extension_ui_response", id, ...payload})`. Rust `AgentBridge::send` validates the type, settles a pending approval (it can no longer be granted) and tells the tracker the question is answered, so `hasAsk` drops in `tabs` (`agent/mod.rs:383-400`). On a successful hand-off, record `_remoteSettled[B][askId] = patch`, patch B's snapshot and queue, and `settle` the shadow.
4. Later the desktop activates B. The replayed `extension_ui_request` goes through `_askMessage`, finds the record, and the bubble is created settled. The run state does not get stuck on "question", and the desktop does not send a second response.
5. omp withdrawing the question (`method:"cancel"`) settles it in the shadow with `closedByOmp`, as `live.js:2478-2489` does. The phone sees it gone; nothing is recorded.
6. Not covered on purpose: "approve and remember" (`approveAndRemember`, `manage`) and asks whose shape the desktop would cancel (an unparseable `ask` dialog, unknown methods). The shadow does not cancel them (it never writes on its own), so they wait for desktop activation, as today. The first activates the tab, as today.
7. Never-activated tabs have not received `set_ask_dialog` (`live.js:3017-3020`), so omp asks one `select` per question. The phone answers those as ordinary selects.

### 3.5 Stop and prompt on a background tab

- `abort`: `_sendTo(B, {type:"abort"})`, **without an id**, so the AGENTS.md invariant holds. Also set `sessionSnapshots.get(B).userAbortInFlight = true`, so the replay on activation marks the goal pause as the user's stop and the abort response clears it (`live.js:2094-2100`, snapshot field `:904-905`, restore `:947`).
- `prompt` / `steer`: `_sendTo(B, …)` with the frame the desktop would build. `OMP_SLASH.queuedFrame` / `isCommandInvocation` take the tab's `commands` from its snapshot (AGENTS.md: commands must reach omp as a `prompt`). The shadow adds a user bubble without a `ts`; omp's echo (`live.js:2556-2566`) creates the desktop's bubble on activation. Desktop bookkeeping that is skipped: the "sending" queue rows, `_recordPrompt` (write to `promptHistories.get(B)` directly, `:169`) and the auto-rename gate `_disarmAutoRename`. That last one is a risk; if it shows up in testing, prompts stay on the activate path. Images use the existing `remoteTakeUpload` path unchanged.

---

## 4. Size estimate

| Area | Production | Tests |
|---|---|---|
| `app/remote-shadow.js` (new) | ~320 | `tests/test-remote-shadow.mjs` ~350 |
| `app/remote-view.js` (`viewOf` split, background routing) | ~60 | `test-remote-view.mjs` +~150 |
| `app/use-remote.jsx` (shadow controller, `views` publish) | ~100 | in `test-remote-view.mjs` (publisher lifecycle, as today) |
| `live.js` (bridge methods, `_remoteSettled`, two hooks) | ~90 | none: no `__TAURI__` harness (AGENTS.md); logic kept in pure modules |
| Rust hub / ws / scope | ~130 | ~150 |
| Phone (`client.js` `watchFor`, `remote.js` caps switch) | ~30 | `test-remote-client.mjs` +~40 |
| Docs (`remote-access.md`, load order, CHANGELOG) | ~60 | |
| **Total** | **~790** | **~840** |

About 3 to 5 dev days. Rust is checked on CI only (no local linker).

## 5. Invariants and risks

| Invariant / risk | Effect | Mitigation |
|---|---|---|
| `_handleResponse` brace chain (AGENTS.md *Things easy to break*) | one condition added to the existing line `:2074` | no new branch; check braces; `npm test` loads `live.js` |
| transcript merge by `ts` / desktop entries never carry `ts` | shadow entries never enter `state.messages`; `_askMessage` only changes the answered flags | the shadow's own user bubble has no `ts`, so the rule holds even if it were reused |
| `OMP_BRIDGE.abort()` id-less | background abort is id-less too | test asserts the frame has no `id` |
| new RPC types → `ALLOWED_COMMAND_TYPES` | none: `extension_ui_response`, `abort`, `prompt`, `get_messages`, `negotiate_protocol` are already sent | the Rust test that scans `live.js` still passes |
| tracker hot path O(1) | unchanged; no reader change | |
| `remote_apply_settings` complete object | unchanged | |
| shadow and desktop disagree after activation (ask ordering, a tool card lost after a `dropped` reseed: `adaptAgentMessages` drops tool cards, `adapter.js:504`) | the phone switches source when B becomes active | ids are stable (`_toolCallId`, `ts`), so `<details>` stay open; same loss as the desktop's own dropped path |
| respawn under the same id (journal seq restarts at 1, `agent/mod.rs:237`) | the shadow would skip everything as `seq <= cursor` | `ready` frame or `seq` regression → reseed; `_remoteSettled[B]` cleared on respawn |
| process exits while shadowed | `replay_events` errors with `not found` (`agent/mod.rs:421`) | exit listener → not busy plus notice; stop seeding |
| double answer (desktop and phone) | desktop: the bubble is settled before activation, so no second send; phone after desktop: the shadow is gone once B is active | `_settleAsk` re-answer guard |
| a never-activated tab gets `negotiate_protocol` from the shadow | changes the process to v2 framing early | the desktop's own negotiate later is a harmless repeat (`live.js:3013`); chunk reassembly in the shadow |
| auto-rename gate skipped for background prompts | a title refinement may count one turn differently | fall back to activation for `prompt`/`steer` if it shows up |
| memory / CPU | ≤ 8 shadows, entries shared with snapshots | wanted set = viewed tabs only, not all tabs |
| phone and desktop seeing different tabs confuses the user | design question | the designer decides whether to show it; the protocol does not depend on it |

## 6. Test plan

**Pure, `node tests/test-remote-shadow.mjs`** (new, added to `npm test` with `test:remote-shadow`). Load `adapter.js`, `turn-status.js`, `transcript-merge.js`, `stream-delta.js`, `ask-dialog.js`, `remote-view.js` and `remote-shadow.js` into one VM, as `test-remote-view.mjs` does.
- `fromSnapshot` leaves the snapshot unchanged after a delta run (deep-equal before and after).
- A recorded frame sequence (user → streamed assistant → tool start/update/end → select ask → cancel → agent_end) gives the same `view()` as `buildView` over the desktop's own transcript for the same frames. Use one shared fixture: a short session log of the `scripts/omp-sim.mjs` kind.
- `seq` dedupe; a seq regression and `ready` → `reseed`; `rpc_chunk` reassembly; a malformed line is ignored.
- A `dropped` seed through `fromHistory` plus a streaming copy: frames at or below the copy's seq are skipped (`accFor` semantics).
- Asks of all five kinds appear in `asks`; `settle` removes one; an omp `cancel` removes one; `invalidAnswer` refuses wrong values.

**`tests/test-remote-view.mjs`** (extend):
- A background `answer` does not call `activateSession`, calls `remoteBackgroundAnswer` with the `_resolveAsk` payload shape, and acks `ok`. A missing ask acks "question no longer open" after 5 s on the fake clock.
- Background `abort` sends no id. Non-background ops still activate. Revoke and expiry during the ask wait still refuse.
- Publisher: `views` holds the active view plus shadows, an unchanged view is not republished, a shadow is dropped when its tab becomes active and reseeded when it stops being active.

**`tests/test-remote-client.mjs`**: `watchFor(tabId)` frame shape; the phone uses `watch` only when `caps` has `views`.

**Rust (CI):**
- `ws_tests.rs`: `watch` needs `view` scope; an unknown tab is ignored; two sockets watching different tabs each get only their own `view` frames; a socket without `watch` follows `active` (protocol-2 compatibility); `remote://watch` carries the distinct viewed ids.
- `scope.rs`: `watch` → `View`.
- No `agent/` tests change.

**Manual, real phone, with `omp-sim`** (AGENTS.md *Commands*):
1. Two tabs, desktop on A. The phone watches B while B streams: live text, tool cards and busy, and the desktop does not switch.
2. B asks a `select` / an `ask` dialog: the phone answers. B continues, `hasAsk` clears, then open B on the desktop: the bubble shows answered and the run state is not "question".
3. Stop B from the phone, then open B: the goal pause (if any) is labelled as the user's stop.
4. Profile-switch B while it is watched: the shadow reseeds and nothing freezes.
5. Restart the app (restored tabs); watch a never-opened tab: the history appears through `get_messages`.
6. Old phone page (no `views`): behaviour is unchanged (`select` switches the desktop).

## 7. Decision gate

Build option C in the order Rust protocol → `remote-shadow.js` plus tests → controller/executor → `live.js` hooks. Ship `answer`/`abort`/`toolOutput` first. If the auto-rename / queue-row gaps in §3.5 cause trouble, keep `prompt`/`steer` on the activate path. If the shadow-vs-desktop comparison test (§6, second pure bullet) cannot be kept green without copying `live.js` logic, stop and keep today's switching behaviour (plus option E for reading only).
