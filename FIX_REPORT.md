# DD Turf Zone — Full Audit & Fix Report (UP10)

Source for this pass: **UP08** (already contained every fix from earlier sessions —
Coach Settlements Firebase sync, Pending Enrolments realtime notification, WhatsApp
popup-timing fixes, phone-as-number crashes, birthday-page QR code, fees-reverting-
to-Due bug, and the session-restore TDZ crash). This report covers only what was
found and changed **in this pass**, on top of that baseline. `UP08` itself was left
untouched as a backup — all new work is in `UP10` only.

---

## 1. Bugs found and fixed

### 1.1 `getFirebaseStatus` / `refreshFirebaseConnectionIndicator` / `verifyFirebaseConnection` were missing entirely
**Files:** `firebase.js`, `admin.html`
**Root cause:** admin.html called `window.getFirebaseStatus()` in ~8 places (the
reconnect watchdog, the Diagnostics page, enrolment approve/reject) but the function
never existed in `firebase.js`. Two other functions it depends on
(`refreshFirebaseConnectionIndicator`, `verifyFirebaseConnection`) were also missing.
**Impact:** The reconnect watchdog (`_firebaseReconnectWatchdog`, fires on tab-focus/
online/reconnect) always read `status.fullyReady` as `undefined` and returned early
on **every single trigger** — meaning a Firebase listener that dropped after a
network blip was **never actually restored**, for any module, for the lifetime of
this feature.
**Fix:** Implemented all three functions in `firebase.js`, exposing the real internal
state (`connectionStatus`, `firebaseFullyReady`, `authState`, `lastFirebaseError`)
that the file already tracked. Read-only, no data-mutation risk.
**Existing data untouched.**

### 1.2 Enrolment approve/reject "atomic claim" system was designed but never implemented
**File:** `admin.html`
**Root cause:** `approveEnrolment`/`confirmRejectEnrolment` call
`window.claimEnrolmentForApproval` / `window.rejectEnrolmentFirebase` /
`window.finalizeEnrolmentApproval` / `window.releaseEnrolmentClaim` — none of these
exist anywhere in the codebase. They were gated behind `getFirebaseStatus()...
fullyReady === true`, which was always `false` (see 1.1), so this dead branch never
ran and every approval/rejection already used the safe fallback path.
**Fix:** Rather than build and activate a brand-new, never-tested Firebase
transaction system on a live student-approval workflow in one autonomous pass, both
gates were changed to also require `typeof window.claimEnrolmentForApproval ===
'function'` (and the reject equivalent). Now that `getFirebaseStatus()` actually
works, this keeps approve/reject behavior **exactly as it has always safely run in
production** — zero behavior change, zero new risk.
**Existing data untouched.**

### 1.3 Booking Requests never got an instant Firebase push (same class of bug as the earlier Pending Enrolments fix)
**Files:** `Code.gs`, `index.html`
**Root cause:** `index.html`'s public booking form calls
`window.submitBookingRequestFirebase(payload)`, guarded by `typeof ... ===
'function'`. That function never existed in `firebase.js`, and `index.html` has no
Firebase Auth SDK loaded (same deliberate omission as `enroll.html`), so even
defining a client-side version would hit the same `auth != null`
`PERMISSION_DENIED` wall already diagnosed for enrolments in an earlier session.
**Impact:** `admin.html`'s `initBookingRequestsFirebaseListener` /
`syncBookingRequestFirebase` / `listenBookingRequests` were already fully built and
already correctly handle a brand-new record arriving (badge update, render, voice/
toast announcement) — they simply never received one from a public submission.
Booking Requests were **not silently broken**: `postBookingRequestToSheet` plus the
existing 30-second Sheets-poll fallback (`fetchPendingRequestsFromSheet`) already
delivered every request — just not instantly.
**Fix:** Added `_pushBookingRequestToFirebase(requestId, payload)` in `Code.gs`,
mirroring the already-proven `_pushEnrolmentToFirebase` pattern exactly (same
Database-Secret REST push, same `muteHttpExceptions`, same `Logger.log`
diagnostics), writing to `bookingRequests/{requestId}` — the same path
`syncBookingRequestFirebase` already uses for admin-originated writes. Wired into
`handleBookingRequestCreate` on both the dedupe-return path and the main write path.
**Existing data untouched. No Sheet/rule change required** (uses the already-
configured `FIREBASE_DB_SECRET`).

### 1.4 Finance Expenses had **zero** Google Sheets backup — every sync silently failed
**Files:** `Code.gs`
**Root cause:** `admin.html`'s `_finSyncExpenseToSheets()` has been sending
`type: 'finance_expense'` via `queuedSync` (the real write path, not the audit log)
on every add/edit/delete, and `syncFinanceExpensesFromSheet()` has been GETting
`action=financeExpenses` on every login for a Finance-access user — but `doPost`'s
switch had no case for the former and `doGet`'s switch had no case for the latter.
**Impact:** Every Finance Expense write got `"Unknown payload type: finance_expense"`
and every read got `"Unknown or missing action"`. Finance Expenses has been running
on Firebase alone this whole time, with **no persistent Sheets backup at all** —
directly violating the stated architecture ("Google Sheets remains the persistent
backup/authoritative store").
**Fix:** Added a brand-new `FinanceExpenses` Sheet tab (auto-created by `_sheet()` on
first use — no existing tab/header/data touched), `handleFinanceExpenseWrite`
(create/update/soft-delete, same pattern as `handleCoachWrite`),
`handleFinanceExpensesGet`, and wired both into `doPost`/`doGet`. Also added the
matching `finance_summary` case (upserted by month, same generic-upsert pattern
already used elsewhere) for `_finSyncSummaryToSheets()`, which had the identical gap.
**Existing data untouched** — this only adds a new tab and new dispatch cases.

### 1.5 Session-restore crash on every page refresh (carried in from the previous session, verified still present at the start of this pass, already fixed before this audit began)
Already documented from the prior turn — `restoreSession()`'s auto-login path ran
synchronously before the rest of the 19,000-line script had finished executing,
throwing on `RT_POLL_MAX_BACKOFF_MS` and `onFeeStudentChange`. Fixed by deferring the
whole IIFE with `setTimeout(..., 0)`. Re-verified clean in this pass's smoke test
(zero uncaught errors on a simulated auto-restored session).

### 1.6 Two duplicate/shadowed function declarations
**File:** `admin.html`
**Root cause:** `_announceStudentEvent` and `_announceFeeEvent` were each declared
**twice**. JS function-declaration hoisting means the later declaration in the file
always wins — the earlier ones (taking a `{ text, voice }` object) were 100%
unreachable dead code, fully shadowed by later, more complete declarations (taking a
plain string, and also writing to the Notification Bell/Center, which the dead ones
never did). Verified via every real call site: none still use the old signature.
**Fix:** Removed the two dead declarations. Zero runtime behavior change (proven —
they were never executed), reduces future-maintainer confusion.
**Note (not fixed, flagged only):** `window._onAttendanceVoiceNotification` and
`window._onFeeVoiceNotification` (lines ~5351/5392) are also 100% dead code — written
for a Firestore `onSnapshot`-style listener architecture that was later replaced by
the current Realtime-Database listener pattern. Never called anywhere. Left in place
since removing them wasn't part of a "duplicate declaration" bug and touching them
uninvited would be scope creep; safe to delete in a future pass if desired.

### 1.7 WhatsApp popup-blocking on booking confirmation and reservation-confirmation
**File:** `admin.html`
**Root cause:** `saveBooking`'s auto-WhatsApp for a brand-new confirmed booking was
wrapped in `setTimeout(..., 600)`, itself running **after** two real network awaits
(`saveDoc`, `autoSyncBooking`). `confirmReservation`'s WhatsApp call ran directly
after two more real network awaits. By the time either fired, the click's user-
gesture window had almost certainly expired, so `window.open()` inside
`sendBookingWhatsApp` was silently blocked by the browser — the exact class of bug
already fixed elsewhere in this file for Fees/Receipts/Café Bill, but missed for
Bookings.
**Fix:** Applied the same proven "open a blank tab synchronously before any await,
navigate its `.location` once the real URL is known" pattern to both functions. Also
closes the blank tab if the save itself fails, so a failed booking never leaves a
stray tab open.
**Existing data untouched.**

### 1.8 `₹` still used in two WhatsApp message templates
**File:** `admin.html`
**Root cause:** `buildBookingWhatsAppMessage` (booking-confirmation WhatsApp) and
`window.csShareWhatsApp` (Coach Settlement WhatsApp share) both still used the ₹
symbol; every other WhatsApp message in the file had already been converted to
"Rs." in earlier sessions.
**Fix:** Converted both to "Rs." for consistency with the rest of the app and with
this pass's explicit requirement (some low-end phones' default fonts have no glyph
for ₹, rendering it as a broken box regardless of correct percent-encoding).
Receipt HTML/on-screen UI (which the spec did not ask to change) was left as ₹.

### 1.9 Due Adjustments had no Sheets-fallback for a fresh browser/Incognito/Firebase outage
**File:** `admin.html`
**Root cause:** `Code.gs`'s `handleDueAdjustmentsGet` (`action=dueAdjustments`) was
added in an earlier session specifically because "every device could write a
correction to the permanent Sheet but none could ever read one back" — but the
client-side fetch to actually use it was never written. Due Adjustments has relied
entirely on the Firebase listener ever since, with none of the Sheets-fallback
safety net every other module has.
**Fix:** Added `syncDueAdjustmentsFromSheet()`, mirroring the exact seeded-gate +
backfill-only merge pattern every other module's fallback already uses (e.g.
`syncFinanceExpensesFromSheet`), wired into `loadAllData()`. Verified both behaviors
directly in the browser: correctly backfills when Firebase hasn't seeded yet, and
correctly skips (no redundant fetch) once the Firebase listener is active.
**Existing data untouched.**

---

## 2. Items verified as already correct (no change made)

- **Quarterly coaching fee due-calculation** — already fixed in an earlier session
  (`_dueCurrentPeriod`, with an explicit "QUARTERLY FEE DUE-DATE FIX" comment).
  Manually traced against both of the spec's exact examples (May ₹4000 → covers to
  July 31; July ₹5500 → covers to September 30) — both match precisely.
- **Receipt "empty space below logo"** — already fixed in an earlier session
  (explicit bugfix comment, margins tightened 18px/12px → 10px/8px). Re-verified
  numerically by rendering the live template in an isolated iframe and measuring
  `getBoundingClientRect()`: 10px gap logo→divider, 10px divider→title. Not
  reproducible as "large/unnecessary."
- **Receipt "duplicated/stale payment data"** — traced `_saveFeeImpl`,
  `_receiptDocHTML`, `shareReceiptWhatsApp`, `_receiptWhatsAppMessage` end-to-end;
  all correctly re-fetch the current record and never merge/accumulate old and new
  payment data. The actual root cause of stale-looking data after an edit is the
  Sheets-poll-overwriting-fresh-Firebase-data bug already fixed earlier this
  engagement (the `_feesFirebaseSeeded` gate on `syncFeesFromSheet`).
- **Birthday widget re-render on async data arrival** — already fixed in an earlier
  session. Both `initStudentsFirebaseListener` and `syncStudentsFromSheet` already
  call `renderBirthdayWidget?.()` on change, each with its own explicit comment
  describing this exact bug.
- **Notification badges (Booking Requests, Pending Enrolments)** — both already
  correctly call their `update*Badge()` function inside their Firebase listener's
  change handler and their Sheets-poll fallback's change handler. No separate badge
  exists for Enquiries/Fees/Dues/Birthdays — that's the original design (viewed via
  their own pages), not a missing feature.
- **Café Items has no Sheets backup** — confirmed this is an explicit, documented
  design decision ("this module never had a Google Sheets sync at all, so there's
  nothing to background here"), not an oversight. Café *Sales* (the actual revenue
  records) do have full Sheets backup; the menu itself is Firebase-only by design.
  Left unchanged — adding this would be new-feature scope, not a bug fix.
- **Every other `doGet`/`doPost` action/type** — cross-referenced exhaustively
  against every caller in `admin.html`; no other gaps found.
- **Every other `window.*Firebase`/`listen*` call in `admin.html`/`index.html`/
  `enroll.html`/`birthday-page.html`** — cross-referenced against `firebase.js`'s
  actual exports; no other missing bridges found.
- **No other duplicate/conflicting function or `window.X =` declarations** anywhere
  in `admin.html`, `firebase.js`, or `Code.gs` (checked programmatically).

---

## 3. Files changed

- `Code.gs` — added `_pushBookingRequestToFirebase`, wired into
  `handleBookingRequestCreate`; added `FINANCE_EXPENSES`/`FINANCE_SUMMARY` tabs,
  `handleFinanceExpenseWrite`, `handleFinanceExpensesGet`, wired into
  `doPost`/`doGet`.
- `firebase.js` — added `window.getFirebaseStatus`,
  `window.refreshFirebaseConnectionIndicator`, `window.verifyFirebaseConnection`.
- `admin.html` — guarded the enrolment claim/reject call sites; removed two dead
  duplicate function declarations; fixed booking-confirmation and reservation-
  confirmation WhatsApp popup-timing; `₹` → `Rs.` in two WhatsApp templates; added
  `syncDueAdjustmentsFromSheet` and wired it into `loadAllData()`.
- `index.html`, `enroll.html`, `birthday-page.html` — no changes this pass (each
  audited; no new issues found beyond what earlier sessions already fixed).

## 4. Testing performed

- Full-file console smoke test after every edit (zero uncaught errors, both isolated
  per-change and combined, using a simulated auto-restored login session against a
  local static server — no production Firebase/Sheets writes).
- Numerical DOM measurement of the live receipt template (logo/divider/title
  spacing) via an isolated iframe.
- Direct function-level testing of `syncDueAdjustmentsFromSheet()` with a stubbed
  `fetch`: confirmed correct backfill when unseeded, and confirmed the seeded-gate
  correctly skips the redundant poll when Firebase is already active.
- Manual trace of the quarterly fee due-calculation against both of the spec's
  worked examples.
- Programmatic duplicate-declaration scan across all three script files.
- Exhaustive cross-reference of every `doGet`/`doPost` action/type in `Code.gs`
  against every caller in `admin.html`, and every `firebase.js` export against every
  caller in `admin.html`/`index.html`/`enroll.html`/`birthday-page.html`.

All testing used a local static file server with a simulated session and (where
needed) a stubbed `fetch` — no destructive or test writes were sent to the live
Firebase project or Google Sheet at any point.

## 5. Data-safety confirmation

No existing Student/Coach/Fee/Attendance/Enquiry/Café/Booking/Enrolment/Birthday
record was deleted, reset, or migrated. No existing ID, receipt number, or Sheet
header was changed. No Firebase security rule was touched. No User/Admin/Manager/
Staff account or password was touched. Every Code.gs change either adds a brand-new
Sheet tab (auto-created on first use, colliding with nothing existing) or adds a new
`switch` case that was previously falling through to "Unknown payload type" — in
both cases, nothing that previously worked was altered.

## 6. Could not be verified

- **Live production behavior** — everything above was verified via local, isolated,
  stubbed-network testing (per the no-test-writes-to-production constraint). The
  actual live site's behavior (real Firebase project, real Google Sheet, real
  Apps Script deployment) should be spot-checked after deploying `Code.gs` and
  redeploying the web app (new deployment version, not just saving the script).
- **Café Items image/logo asset internals** — the receipt logo comes from an
  existing `<img class="ddtz-logo-img">` already used elsewhere in the app; its
  rendered spacing was measured and confirmed tight, but the image file's own
  internal pixel content (e.g. any baked-in transparent padding) wasn't inspected,
  since it's the same asset already used successfully across the rest of the site.
