/**
 * ============================================================================
 *  DD TURF ZONE — APPS SCRIPT BACKEND (Code.gs)
 * ============================================================================
 *  This is the ONE backend both admin.html and index.html already talk to
 *  (PRODUCTION_APPS_SCRIPT_URL / getLiveSheetUrl()). It makes the Google
 *  Sheet the real single source of truth for:
 *    - Admin login (Users sheet)                    -> fixes Issue #1
 *    - Live BOOKED/BLOCKED availability              -> fixes Issue #2
 *    - Every other record type the front-end already posts (bookings,
 *      blocked slots, reservation requests, students, attendance,
 *      enquiries, café sales, coaching fees, site content, audit log)
 *
 *  INSTALL
 *  1. Open the Google Sheet you want as the database.
 *  2. Extensions -> Apps Script.
 *  3. Delete anything in Code.gs, paste this whole file in, Save.
 *  4. Deploy -> New deployment -> type "Web app".
 *       Execute as:  Me
 *       Who has access: Anyone
 *  5. Copy the /exec URL it gives you into admin.html Settings (or replace
 *     PRODUCTION_APPS_SCRIPT_URL) and into index.html's PUBLIC_APPS_SCRIPT_URL.
 *  6. (Optional but recommended) Project Settings -> Script properties ->
 *     add SHARED_SECRET = some-long-random-string, and put the exact same
 *     value into admin.html Settings -> "Shared Secret / Token". Once set,
 *     every write except public reservation requests must include it.
 *  7. Re-run Deploy -> Manage deployments -> Edit -> New version whenever
 *     you change this file — Apps Script does NOT auto-update a live URL.
 *  8. ONE-TIME (per script project): to enable the daily automatic backup,
 *     open Extensions -> Apps Script, choose "setupDailyBackupTrigger" from
 *     the function dropdown next to Run, click Run, and approve the
 *     permission prompt. This step exists because installing a time-driven
 *     trigger needs an authorization prompt Google can only show inside
 *     the editor, never from a request made through the deployed Web App
 *     URL — see the "TRIGGER STATE" comment further down for why. You only
 *     need to do this once; after that, Refresh Status in the Admin panel
 *     will correctly show the trigger as installed.
 *  9. ONE-TIME (only if "Delete Backup" ever reports a Drive permission
 *     message): same idea as step 8, but choose "authorizeBackupDriveAccess"
 *     instead. Backup creation itself doesn't need this (it already works),
 *     only deleting an existing backup file by ID does on some deployments.
 *
 *  All sheet tabs below are created automatically the first time they're
 *  needed. Nothing here touches or renames any tab it doesn't own, and
 *  nothing ever deletes a row except an explicit delete action.
 *
 *  PHASE 2.5 (real-time sync & live notifications) reuses the AuditLog tab
 *  as the change-event feed — see the "PHASE 2.5" section further down —
 *  and adds one new read-only GET action, syncEvents. No redeploy step
 *  beyond the usual "New version" is needed; there is no new tab to seed
 *  and no new Script Property to configure.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const TABS = {
  USERS:      'Users',
  BOOKINGS:   'Bookings',
  BLOCKED:    'BlockedSlots',
  REQUESTS:   'BookingRequests',
  STUDENTS:   'Students',
  ATTENDANCE: 'Attendance',
  ENQUIRIES:  'Enquiries',
  CAFE_SALES: 'CafeSales',
  AUDIT:      'AuditLog',
  SITE_CONFIG:'SiteConfig',
  BACKUP_LOG: 'BackupLog',
  IMPORT_LOG: 'ImportLog',
  // PHASE 3.1 — Coaches Backend. See the COACHES section further down for
  // the handlers; this just gives the tab a name like every other module.
  COACHES:    'Coaches',
  // PHASE 3.4b — Fee Collection. One consolidated tab (like Students/
  // Coaches) replacing the old ad-hoc "<Sport> Coaching - <Mon YYYY>"
  // tabs handleCoachingFee wrote to — those were push-only (no GET
  // reader), so nothing in the app ever actually read them back; nothing
  // user-facing depended on that destination, only on payments being
  // saved somewhere. This tab is what makes real cross-device sync,
  // receipt numbering, and backup coverage possible. Old per-sport-per-
  // month tabs are left untouched (historical data isn't migrated or
  // deleted), they just stop receiving new rows.
  FEES:       'Fees',
  // PHASE 3.5 — Student Enrolment Request System. Public form writes here
  // directly (no login); Admin's Pending Enrolments page reads/upserts it.
  ENROLMENTS: 'EnrolmentRequests',
  // Priority 4 — Manual Due Correction. Append-only, same pattern as
  // Attendance/CafeSales — every correction is a permanent row, never
  // edited or deleted, so the full history stays intact even if a
  // correction later turns out to be wrong (a new, offsetting correction
  // would be entered instead, same principle as accounting reversals).
  DUE_ADJUSTMENTS: 'DueAdjustments',
  // PHASE 5 — Coach Settlement & Revenue Sharing. One consolidated tab,
  // same "JSON-in-cell for nested data" convention already used by
  // SiteConfig (Images/Pricing/Videos columns) — Totals/Students/
  // PaymentHistory are stored as JSON strings, never flattened into
  // dozens of columns. Read back and parsed by handleCoachSettlementsGet.
  COACH_SETTLEMENTS: 'CoachSettlements',
  // ROOT-CAUSE FIX — admin.html's _finSyncSummaryToSheets() (Finance page)
  // has been POSTing type:'finance_summary' since Phase 4.2, but this
  // handler never existed server-side: every push hit doPost's `default`
  // branch and returned "Unknown payload type: finance_summary", surfaced
  // to the user as a red toast on every Finance page view/refresh. One row
  // per calendar month, upserted by `period` ("YYYY-MM") — same generic
  // upsert pattern as CoachSettlements above.
  FINANCE_SUMMARY: 'FinanceSummary'
};

// ----------------------------------------------------------------------------
// PHASE 1 — BACKUP CONFIG (server-side, unattended — runs even with no
// browser open, unlike admin.html's own localStorage snapshot layer, which
// this is designed to sit alongside rather than replace).
// ----------------------------------------------------------------------------
const BACKUP_FOLDER_NAME = 'DD Turf Zone Backups';

// First-run seed — identical to admin.html's old localStorage seed, so
// nobody is locked out the moment this script goes live. Change these
// passwords from User Management immediately after deploying.
const DEFAULT_USERS = [
  { email: 'ddturfzone@gmail.com',   name: 'Owner',   password: 'DDturfzone@321', role: 'superadmin', active: true },
  { email: 'manager@ddturfzone.com', name: 'Manager', password: 'Manager@321',    role: 'admin',       active: true },
  { email: 'staff@ddturfzone.com',   name: 'Staff',   password: 'Staff@321',      role: 'staff',       active: true }
];

function _sharedSecret() {
  return PropertiesService.getScriptProperties().getProperty('SHARED_SECRET') || '';
}

// ----------------------------------------------------------------------------
// SMALL HELPERS
// ----------------------------------------------------------------------------
function _ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function _ok(extra)  { return _json(Object.assign({ ok: true }, extra || {})); }
function _fail(error, extra) { return _json(Object.assign({ ok: false, error: error }, extra || {})); }

// Gets (or creates, with a header row) a sheet tab. Every existing call
// site omits ssOverride, so behavior is unchanged; the Phase 1 backup
// verifier/restore-reader is the only caller that passes a backup copy's
// Spreadsheet object in, to read its tabs without touching the live one.
function _sheet(name, headers, ssOverride) {
  const ss = ssOverride || _ss();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _headers(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

function _rowsAsObjects(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const headers = _headers(sh);
  const values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row, i) {
    const obj = {};
    headers.forEach(function (h, c) { obj[h] = row[c]; });
    obj._row = i + 2;
    return obj;
  });
}

// Finds the sheet row number (1-indexed, includes header) whose colName
// matches value, or -1. Case-sensitive exact match on the string form.
function _findRow(sh, colName, value) {
  const headers = _headers(sh);
  const col = headers.indexOf(colName);
  if (col === -1) return -1;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  const values = sh.getRange(2, col + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

// Upserts one row (by header name -> value map). If rowNum is given,
// updates only the columns present in obj (leaves the rest of that row
// untouched); otherwise appends a new row.
function _writeRow(sh, rowNum, obj) {
  const headers = _headers(sh);
  if (rowNum) {
    const existing = sh.getRange(rowNum, 1, 1, headers.length).getValues()[0];
    const merged = headers.map(function (h, i) {
      return obj.hasOwnProperty(h) ? obj[h] : existing[i];
    });
    sh.getRange(rowNum, 1, 1, headers.length).setValues([merged]);
  } else {
    const rowValues = headers.map(function (h) {
      return obj.hasOwnProperty(h) ? obj[h] : '';
    });
    sh.appendRow(rowValues);
  }
}

function _deleteRow(sh, rowNum) {
  if (rowNum && rowNum > 1) sh.deleteRow(rowNum);
}

// ----------------------------------------------------------------------------
// PHASE 2.5 (cont.) — OPTIMISTIC EDIT-CONFLICT DETECTION
// ----------------------------------------------------------------------------
// Purely additive and OPT-IN: a client that never sends expectedUpdatedAt
// (every call site untouched by this phase) gets EXACTLY the old
// behavior — last-write-wins, no conflict object, nothing new to break.
// Only a client that (a) read a record's UpdatedAt earlier and (b) sends
// it back as expectedUpdatedAt on an edit gets the new protection: if the
// row's UpdatedAt has changed since, the write is refused (never applied,
// never silently merged) and the caller gets the current row back so it
// can show the person what changed instead of clobbering it.
// payload.forceOverwrite:true is the explicit-consent escape hatch (the
// "Save my version anyway" button) — it skips the check entirely, same as
// never having sent expectedUpdatedAt.
function _versionConflict(sh, rowNum, expectedUpdatedAt, forceOverwrite) {
  if (forceOverwrite) return null;
  if (!expectedUpdatedAt) return null; // caller didn't opt in — unchanged behavior
  if (!rowNum || rowNum === -1) return null; // brand-new record — nothing to conflict with
  const headers = _headers(sh);
  const col = headers.indexOf('UpdatedAt');
  if (col === -1) return null; // this tab has no UpdatedAt column yet — nothing to compare
  const currentRaw = sh.getRange(rowNum, col + 1, 1, 1).getValues()[0][0];
  const current = currentRaw instanceof Date ? currentRaw.toISOString() : String(currentRaw || '');
  if (!current || current === String(expectedUpdatedAt)) return null; // matches what the caller last saw — no conflict
  const row = _rowsAsObjects(sh).find(function (r) { return r._row === rowNum; });
  return { currentUpdatedAt: current, current: row || null };
}

// Standard "someone else changed this" rejection, shared by every write
// handler below so the shape is always identical for the client.
function _editConflictFail(conflict) {
  return _fail('This record was changed on another device. Reload it before saving your changes.', {
    conflict: true, editConflict: true, current: conflict.current, currentUpdatedAt: conflict.currentUpdatedAt
  });
}

// "HH:MM" (24h, what the admin's <input type="time"> stores) ->
// "H:MM AM/PM" (what index.html's availability grid parses, and what
// admin's Pending Requests display shows). Mirrors admin.html's own
// formatTime() exactly so both sides always agree.
//
// ROOT CAUSE FIX: Google Sheets frequently auto-detects a plain
// time-looking value typed/written into a cell (e.g. "18:00" or "6:00 PM")
// and silently stores it as a real date-time serial value instead of
// text. Read back via getValues(), that comes back as an actual JS Date
// object (on Sheets' time epoch, Dec 30 1899) rather than the original
// string. Passing that object straight into a JSON response
// (JSON.stringify auto-converts a bare Date to a full ISO timestamp) is
// exactly how a selected time like "6:00 PM" turns into a stray
// "1899-12-30T18:00:00.000Z"-style string on the client — or, if it went
// through the old string-splitting logic instead, into unparseable
// garbage that silently failed every downstream time match (so a booked
// slot simply never showed as booked). This function is now the ONE
// place that normalizes either shape back to clean "H:MM AM/PM" text, and
// every handler below always routes Start/End/StartTime/EndTime through
// it before they leave this script.
// Same Date-object safety as _to12h below, but returns 24h "HH:MM" —
// admin.html's LOCAL bookings/blockedSlots collections store times in this
// format (from <input type="time">), so handleFullSync (which merges
// Sheet records INTO that local storage) must match it, not the 12h
// display format the public site/Pending-Requests UI expect.
function _to24h(t) {
  if (t === null || t === undefined || t === '') return '';
  if (Object.prototype.toString.call(t) === '[object Date]') {
    return Utilities.formatDate(t, Session.getScriptTimeZone() || 'Asia/Kolkata', 'HH:mm');
  }
  const s = String(t).trim();
  const ampm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (/pm/i.test(ampm[3])) h += 12;
    return String(h).padStart(2, '0') + ':' + ampm[2];
  }
  return s; // already "HH:MM" or unrecognized — pass through
}

function _to12h(t) {
  if (t === null || t === undefined || t === '') return '';
  if (Object.prototype.toString.call(t) === '[object Date]') {
    return Utilities.formatDate(t, Session.getScriptTimeZone() || 'Asia/Kolkata', 'h:mm a');
  }
  const s = String(t).trim();
  if (/\d{1,2}:\d{2}\s*(AM|PM)/i.test(s)) return s.replace(/\s+/g, ' '); // already "H:MM AM/PM" text — pass through
  const parts = s.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) || 0;
  if (isNaN(h)) return s; // unrecognized shape — pass through rather than silently dropping it
  const h12 = (h % 12) || 12;
  const mm = (m < 10 ? '0' : '') + m;
  return h12 + ':' + mm + ' ' + (h >= 12 ? 'PM' : 'AM');
}

function _dateStr(d) {
  if (!d) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  // Already a "yyyy-MM-dd" string (or something close to it) from the client.
  return String(d).slice(0, 10);
}

function _lock() { return LockService.getScriptLock(); }

// ----------------------------------------------------------------------------
// ENTRY POINTS
// ----------------------------------------------------------------------------
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    switch (action) {
      case 'availability':    return handleAvailability(e);
      case 'pendingRequests': return handlePendingRequests(e);
      case 'siteConfig':      return handleSiteConfigGet(e);
      case 'users':           return handleUsersGet(e);
      case 'fullSync':        return handleFullSync(e);
      case 'backupStatus':    return handleBackupStatus(e);
      case 'backupData':      return handleBackupData(e);
      case 'importHistory':   return handleImportHistoryGet(e);
      case 'syncEvents':      return handleSyncEvents(e); // PHASE 2.5 — real-time sync/notification feed
      case 'coaches':         return handleCoachesGet(e); // PHASE 3.1 — Coaches Backend
      case 'students':        return handleStudentsGet(e); // PHASE 3.2a — Student Core
      case 'fees':            return handleFeesGet(e); // PHASE 3.4b — Fee Collection
      case 'enrolments':      return handleEnrolmentsGet(e); // PHASE 3.5 — Student Enrolment Request System
      case 'coachSettlements':return handleCoachSettlementsGet(e); // PHASE 5 — Coach Settlement Backend
      // PHASE 6 — Dues Synchronization. Manual Due Corrections were
      // POST-only (handleAppendOnly into TABS.DUE_ADJUSTMENTS below) with
      // no matching GET — every device could write a correction to the
      // permanent Sheet but none could ever read one back, including the
      // device that wrote it after a reload. This is the missing read side.
      case 'dueAdjustments':  return handleDueAdjustmentsGet(e);
      // ROOT-CAUSE addition — see handleAttendanceGet's own comment: needed
      // so the Coaching Module Reset's verification step can confirm
      // Attendance is actually empty, not just trust the delete report.
      case 'attendance':      return handleAttendanceGet(e);
      default:
        return _fail('Unknown or missing action. Supported: availability, pendingRequests, siteConfig, users, fullSync, backupStatus, backupData, importHistory, syncEvents, coaches, students, fees, enrolments, coachSettlements, dueAdjustments, attendance.');
    }
  } catch (err) {
    Logger.log('doGet error: ' + err.message + '\n' + (err.stack || ''));
    return _fail('Server error: ' + err.message);
  }
}

// Types handled here NEVER take the booking-write lock below (see doPost).
// A spreadsheet copy + verification can legitimately take many seconds on a
// large sheet, and none of these read/write anything the booking lock is
// actually protecting (Bookings/BlockedSlots row-level conflict checks), so
// holding that lock for their whole duration would only block unrelated
// booking/reservation writes for no safety benefit — a pure performance
// regression Phase 1 must not introduce.
const BACKUP_POST_TYPES = ['backup_now', 'install_backup_trigger', 'remove_backup_trigger', 'delete_backup'];

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return _fail('Malformed request body.');
  }
  const type = payload.type || '';

  // Every write except a public reservation request, a connectivity
  // test, or a login attempt must present the shared secret, IF one has
  // been configured. Login is deliberately exempt: the email+password
  // check is already the real security gate here, and gating login
  // ITSELF behind the token would create a lockout loop — the token is
  // only ever entered via Settings, which you can't reach without
  // logging in first. If SHARED_SECRET is blank (default / not set up
  // yet), this check is skipped entirely regardless. Applied identically
  // to backup types, so they get exactly the same protection as every
  // other write even though they bypass the booking lock below.
  const secret = _sharedSecret();
  if (secret && type !== 'booking_request' && type !== 'enrolment_request' && type !== 'test' && type !== 'login') {
    if (String(payload.token || '') !== secret) {
      return _fail('Invalid or missing token.');
    }
  }

  if (BACKUP_POST_TYPES.indexOf(type) !== -1) {
    try {
      switch (type) {
        case 'backup_now':             return handleBackupNow(payload);
        case 'install_backup_trigger': return handleInstallBackupTrigger(payload);
        case 'remove_backup_trigger':  return handleRemoveBackupTrigger(payload);
        case 'delete_backup':          return handleDeleteBackup(payload);
      }
    } catch (err) {
      // Belt-and-braces: install/remove already catch their own trigger
      // errors internally and never throw, but this guards backup_now /
      // delete_backup too, and guarantees a raw Apps Script permission
      // error can never reach the Admin panel from any backup action.
      return _fail(_friendlyBackupError(err, type));
    }
  }

  const lock = _lock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    return _fail('Server busy, please try again in a moment.', { retry: true });
  }
  try {
    switch (type) {
      case 'test':                  return _ok({ message: 'Connected.' });
      case 'login':                 return handleLogin(payload);
      case 'user':                  return handleUserWrite(payload);
      case 'booking':               return handleBookingWrite(payload);
      case 'blocked_slot':          return handleBlockedSlotWrite(payload);
      case 'booking_request':       return handleBookingRequestCreate(payload);
      case 'booking_request_update':return handleBookingRequestUpdate(payload);
      case 'student':               return handleStudentWrite(payload); // PHASE 3.2a — Student Core
      case 'attendance':            return handleAppendOnly(payload, TABS.ATTENDANCE,
        ['attendanceId','date','student','batch','coach','status']);
      case 'enquiry':                return handleGenericUpsert(payload, TABS.ENQUIRIES,
        ['enquiryId','date','name','phone','sport','message','status','followUpDate'], 'enquiryId');
      case 'coach':                  return handleCoachWrite(payload); // PHASE 3.1 — Coaches Backend
      case 'fee':                    return handleFeeWrite(payload); // PHASE 3.4b — Fee Collection
      // PHASE 3.5 — Student Enrolment Request System. Split into two types,
      // same shape as booking_request/booking_request_update above: the
      // public form (no login) can only ever CREATE a new pending request;
      // every subsequent action (Edit/Approve/Reject) is an admin-only
      // UPDATE that requires the shared-secret token like every other
      // admin write.
      case 'enrolment_request':        return handleEnrolmentRequestCreate(payload);
      case 'enrolment_request_update': return handleGenericUpsert(payload, TABS.ENROLMENTS,
        ['requestId','studentName','dob','gender','parentName','mobile','email','address','school','sport','batch','medicalNotes','status','rejectionReason','approvedStudentId'], 'requestId');
      case 'cafe_sale':              return handleAppendOnly(payload, TABS.CAFE_SALES,
        ['itemName','qty','amount','method','date','loggedBy',
         // CAFÉ BILLING — additive columns appended AFTER the existing six,
         // so existing rows and any reader depending on the original column
         // order are unaffected. A legacy quick-sale writes these blank.
         'bookingId','teamName','phone','slotTime','itemsJson','subtotal','discount','status']);
      case 'siteConfig':             return handleSiteConfigSet(payload);
      // PHASE 2.5 — audit_log now writes to the extended Activity Log
      // schema (Role/Device/Module/RecordId/Summary/PrevValue/NewValue)
      // instead of the old 3-column generic append. See handleAuditLog.
      case 'audit_log':              return handleAuditLog(payload);
      // Phase 2 final polish — permanent, cross-user Import History. One
      // row per completed import batch (not per row imported), so this is
      // O(1) per import, never O(rows). See handleImportHistoryGet /
      // handleImportMarkRolledBack below for how it's read back and how
      // Undo flips RolledBack.
      case 'import_log':             return handleAppendOnly(payload, TABS.IMPORT_LOG,
        ['importId','timestamp','user','module','fileName','mode','imported','updated','skipped','errors','duplicates','device','rolledBack']);
      case 'import_mark_rolled_back':return handleImportMarkRolledBack(payload);
      case 'monthly_report':         return _ok({ message: 'Report received (not stored — informational only).' });
      // Priority 4 — Manual Due Correction. Same append-only pattern as
      // Attendance/CafeSales above — this is not gated by a separate
      // permission check here, because admin.html's saveDueAdjustment
      // already enforces manageDues (Super Admin/Manager only) before
      // this request is ever sent; Staff never reaches this call at all.
      case 'due_adjustment':         return handleAppendOnly(payload, TABS.DUE_ADJUSTMENTS,
        ['id','studentId','studentName','feeType','month','quarter','year','amount','reason','updatedBy','updatedAt']);
      // PHASE 5 — Coach Settlement. One row per coach+month settlement,
      // upserted by settlementId — same generic upsert every other
      // module (Enquiries, Enrolment updates) already uses. Nested data
      // (totals/students/paymentHistory) arrives already JSON-stringified
      // from admin.html, same convention as SiteConfig.
      case 'coach_settlement':       return handleGenericUpsert(payload, TABS.COACH_SETTLEMENTS,
        ['settlementId','coachId','coachName','sport','monthValue','monthLabel','year','revenueSharePercent',
         'totals','students','status','paymentHistory','generatedDate','generatedBy'], 'settlementId');
      // ROOT-CAUSE FIX — see the TABS.FINANCE_SUMMARY comment above. One row
      // per calendar month, upserted by `period` — refreshed every time the
      // Finance page is viewed (admin.html's _finSyncSummaryToSheets), same
      // generic upsert every other module here already uses.
      case 'finance_summary':        return handleGenericUpsert(payload, TABS.FINANCE_SUMMARY,
        ['period','totalIncome','incomeSlot','incomeCoaching','incomeCafe',
         'totalExpenses','expSlot','expCoaching','expCafe','expGeneral','expOwner','expEmployee','netProfit'], 'period');
      // Coaching Module Reset — see handleAdminResetCoaching's own comment
      // for the two-layer authorization this goes through.
      case 'admin_reset_coaching':   return handleAdminResetCoaching(payload);
      default:
        if (type.indexOf('coaching_') === 0) return handleCoachingFee(payload, type);
        return _fail('Unknown payload type: ' + type);
    }
  } catch (err) {
    Logger.log('doPost error (type=' + type + '): ' + err.message + '\n' + (err.stack || ''));
    return _fail('Server error: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// AUTH / USERS  (fixes Issue #1 — Google Sheet becomes the real login source)
// ----------------------------------------------------------------------------
function _usersSheet() {
  const sh = _sheet(TABS.USERS, ['Email', 'Name', 'Password', 'Role', 'Active', 'CreatedAt', 'UpdatedAt']);
  if (sh.getLastRow() < 2) {
    DEFAULT_USERS.forEach(function (u) {
      sh.appendRow([u.email, u.name, u.password, u.role, u.active, new Date().toISOString(), '']);
    });
  }
  return sh;
}

// ROOT CAUSE FIX — matches admin.html's _normalizeRole() exactly. A
// prior version here only did .trim().toLowerCase(), which fixes
// "SUPERADMIN" but not "Super Admin" (lowercasing leaves the internal
// space). This strips every non-alphanumeric character and maps the
// labels the UI itself displays ("Manager" for the 'admin' role), kept
// in lockstep with the client-side copy so a Sheet typo is caught here,
// at the source, not only by the client-side fallback.
function _normalizeRole(raw) {
  const cleaned = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = { superadmin: 'superadmin', super: 'superadmin', owner: 'superadmin', admin: 'admin', manager: 'admin', staff: 'staff' };
  return aliases[cleaned] || cleaned;
}

function handleLogin(payload) {
  // Same invisible-character stripping as admin.html's _cleanEmailInput/
  // _cleanPasswordInput, so a value normalized on the client still matches
  // byte-for-byte if this endpoint is ever called from anywhere else.
  const stripInvisible = function (v) { return String(v || '').replace(/[\u200B-\u200D\uFEFF\u00A0\u2060]/g, ''); };
  const email = stripInvisible(payload.email).trim().toLowerCase();
  const password = stripInvisible(payload.password).trim();
  if (!email || !password) return _fail('Email and password are required.');

  const sh = _usersSheet();
  const rows = _rowsAsObjects(sh);
  const user = rows.find(function (r) { return stripInvisible(r.Email).trim().toLowerCase() === email; });

  // Deliberately generic — never reveals whether the email or the
  // password was the wrong part (audit requirement).
  if (!user || String(user.Password) !== password) return _fail('Invalid email or password.');
  if (user.Active === false || user.Active === 'FALSE' || user.Active === 'false') {
    return _fail('This account is inactive.');
  }

  return _ok({
    // ROOT CAUSE FIX (investigation requested): admin.html's permission
    // checks (can()/hasPageAccess()) do a case-SENSITIVE match against
    // 'superadmin'/'admin'/'staff'. This endpoint previously returned
    // user.Role completely as-typed in the Sheet's Role column — if that
    // cell ever contained "Admin", "Manager", or trailing whitespace
    // instead of the exact lowercase "admin", every can(...) check for
    // that account would silently return false, with the permission
    // TABLE itself being completely correct the whole time. Normalizing
    // here closes that entire class of bug at its source, without
    // changing what any role is allowed to do.
    user: { email: user.Email, name: user.Name, role: _normalizeRole(user.Role) }
  });
}

// GET action=users — deliberately never returns Password. Used to render
// the User Management table and to let admin.html's session-restore
// re-check a cached session's role/active status against the live sheet.
function handleUsersGet(e) {
  const sh = _usersSheet();
  const rows = _rowsAsObjects(sh);
  const users = rows.map(function (r) {
    return {
      email: r.Email,
      name: r.Name,
      role: _normalizeRole(r.Role), // ROOT CAUSE FIX — same shared normalizer as handleLogin above, so session-restore's role re-check can't reintroduce the mismatch handleLogin just fixed
      active: !(r.Active === false || r.Active === 'FALSE' || r.Active === 'false'),
      // PHASE 2.5 — needed as the client's optimistic-concurrency baseline
      // for Staff edits (see handleUserWrite's _versionConflict check below).
      // Purely additive: an older client that ignores this field behaves
      // exactly as before.
      updatedAt: r.UpdatedAt || ''
    };
  });
  return _ok({ users: users });
}

// POST type:'user' — action: create | setName | setRole | setActive | setPassword | delete
function handleUserWrite(payload) {
  const sh = _usersSheet();
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return _fail('Email is required.');
  const action = payload.action || 'create';
  const rowNum = _findRow(sh, 'Email', email);

  if (action === 'create') {
    if (rowNum !== -1) return _fail('A user with this email already exists.');
    if (!payload.name) return _fail('Name is required.');
    if (!payload.password || String(payload.password).length < 6) return _fail('Password must be at least 6 characters.');
    _writeRow(sh, null, {
      Email: email, Name: payload.name, Password: payload.password,
      Role: payload.role || 'staff', Active: true,
      CreatedAt: new Date().toISOString(), UpdatedAt: ''
    });
    return _ok({ message: 'User created.' });
  }

  if (rowNum === -1) return _fail('No such user.');

  // PHASE 2.5 — opt-in optimistic conflict check, same pattern as every
  // other editable record. Guards against two admins changing the same
  // account (e.g. role vs. active-status) at the same moment.
  if (action !== 'create') {
    const conflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
    if (conflict) return _editConflictFail(conflict);
  }

  if (action === 'setName') {
    if (!payload.name) return _fail('Name is required.');
    const updatedAt = new Date().toISOString();
    _writeRow(sh, rowNum, { Name: payload.name, UpdatedAt: updatedAt });
    return _ok({ message: 'Name updated.', updatedAt: updatedAt });
  }
  if (action === 'setRole') {
    const updatedAt = new Date().toISOString();
    _writeRow(sh, rowNum, { Role: payload.role, UpdatedAt: updatedAt });
    return _ok({ message: 'Role updated.', updatedAt: updatedAt });
  }
  if (action === 'setActive') {
    const updatedAt = new Date().toISOString();
    _writeRow(sh, rowNum, { Active: !!payload.active, UpdatedAt: updatedAt });
    return _ok({ message: 'Status updated.', updatedAt: updatedAt });
  }
  if (action === 'setPassword') {
    if (!payload.password || String(payload.password).length < 6) return _fail('Password must be at least 6 characters.');
    const updatedAt = new Date().toISOString();
    _writeRow(sh, rowNum, { Password: payload.password, UpdatedAt: updatedAt });
    return _ok({ message: 'Password updated.', updatedAt: updatedAt });
  }
  if (action === 'delete') {
    _deleteRow(sh, rowNum);
    return _ok({ message: 'User deleted.' });
  }
  return _fail('Unknown user action: ' + action);
}

// ----------------------------------------------------------------------------
// BOOKINGS + AVAILABILITY  (fixes Issue #2 — live BOOKED/BLOCKED on the site)
// ----------------------------------------------------------------------------
const BOOKING_HEADERS = [
  'BookingId','Name','Phone','Date','Start','End','Duration','Sport','Ground',
  'Total','Advance','Pending','Payment','BalancePayment','BalancePaidAt','Status',
  'CreatedAt','AdvanceCash','AdvanceGPay','AdvanceCard','BalanceCash','BalanceGPay',
  'BalanceCard','TotalCash','TotalGPay','TotalCard','TotalPaid','CreatedBy','UpdatedAt'
];

function _bookingsSheet(ssOverride) { return _sheet(TABS.BOOKINGS, BOOKING_HEADERS, ssOverride); }

function handleBookingWrite(payload) {
  const sh = _bookingsSheet();
  const bookingId = payload.bookingId;
  if (!bookingId) return _fail('bookingId is required.');
  const rowNum = _findRow(sh, 'BookingId', bookingId);

  // Authoritative conflict check — only for a genuinely NEW booking on a
  // still-active status. Updating an existing booking (e.g. marking it
  // cancelled, or editing payment info) never re-checks itself.
  if (rowNum === -1 && payload.status !== 'cancelled') {
    const conflict = _findBookingConflict(payload.date, payload.start, payload.end, null);
    if (conflict) {
      return _fail('This slot is already booked (' + conflict.Name + ').', { conflict: true, retry: false });
    }
    const blocked = _findBlockConflict(payload.date, payload.start, payload.end);
    if (blocked) {
      return _fail('This time is blocked (' + (blocked.Reason || 'blocked') + ').', { conflict: true, retry: false });
    }
  }

  // PHASE 2.5 — opt-in optimistic conflict check: only fires for an edit
  // to an EXISTING booking (rowNum !== -1) and only when the client sent
  // expectedUpdatedAt. A brand-new booking already went through the slot
  // conflict check above, so there's nothing extra to guard here for it.
  const editConflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
  if (editConflict) return _editConflictFail(editConflict);

  const updatedAt = new Date().toISOString();
  _writeRow(sh, rowNum === -1 ? null : rowNum, {
    BookingId: bookingId, Name: payload.name, Phone: payload.phone, Date: payload.date,
    Start: payload.start, End: payload.end, Duration: payload.duration, Sport: payload.sport,
    Ground: payload.ground, Total: payload.total, Advance: payload.advance, Pending: payload.pending,
    Payment: payload.payment, BalancePayment: payload.balancePayment, BalancePaidAt: payload.balancePaidAt,
    Status: payload.status, CreatedAt: payload.createdAt, AdvanceCash: payload.advanceCash,
    AdvanceGPay: payload.advanceGPay, AdvanceCard: payload.advanceCard, BalanceCash: payload.balanceCash,
    BalanceGPay: payload.balanceGPay, BalanceCard: payload.balanceCard, TotalCash: payload.totalCash,
    TotalGPay: payload.totalGPay, TotalCard: payload.totalCard, TotalPaid: payload.totalPaid,
    CreatedBy: payload.createdBy, UpdatedAt: updatedAt
  });
  return _ok({ message: 'Booking saved.', bookingId: bookingId, updatedAt: updatedAt });
}

function _timeToMinutes12(t) {
  // Accepts a raw Date object (see _to12h's comment above for why that
  // happens), "HH:MM" (24h), or "H:MM AM/PM" — returns minutes since
  // midnight, or null only for a genuinely empty/unparseable value.
  if (t === null || t === undefined || t === '') return null;
  if (Object.prototype.toString.call(t) === '[object Date]') {
    return t.getHours() * 60 + t.getMinutes();
  }
  const ampm = String(t).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (/pm/i.test(ampm[3])) h += 12;
    return h * 60 + parseInt(ampm[2], 10);
  }
  const parts = String(t).trim().split(':');
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10) || 0;
  if (isNaN(h)) return null;
  return h * 60 + m;
}

function _rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = _timeToMinutes12(aStart), ae0 = _timeToMinutes12(aEnd);
  const bs = _timeToMinutes12(bStart), be0 = _timeToMinutes12(bEnd);
  if (as === null || ae0 === null || bs === null || be0 === null) return false;
  const ae = ae0 > as ? ae0 : ae0 + 24 * 60; // handle overnight wrap
  const be = be0 > bs ? be0 : be0 + 24 * 60;
  return as < be && bs < ae;
}

function _findBookingConflict(date, start, end, excludeBookingId) {
  const rows = _rowsAsObjects(_bookingsSheet());
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (_dateStr(r.Date) !== _dateStr(date)) continue;
    if (r.Status === 'cancelled') continue;
    if (excludeBookingId && r.BookingId === excludeBookingId) continue;
    if (_rangesOverlap(start, end, r.Start, r.End)) return r;
  }
  return null;
}

function _findBlockConflict(date, start, end) {
  const rows = _rowsAsObjects(_blockedSheet());
  const d = _dateStr(date);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (_isDeleted(r.Deleted)) continue;
    const from = _dateStr(r.FromDate || r.BlockedDate);
    const to = _dateStr(r.ToDate || r.BlockedDate);
    if (d < from || d > to) continue;
    if (_rangesOverlap(start, end, r.StartTime, r.EndTime)) return r;
  }
  return null;
}

const BLOCKED_HEADERS = ['BlockId','FromDate','ToDate','BlockedDate','StartTime','EndTime','Reason','Notes','SeriesId','CreatedBy','UpdatedAt','Deleted'];
function _blockedSheet(ssOverride) { return _sheet(TABS.BLOCKED, BLOCKED_HEADERS, ssOverride); }
function _isDeleted(v) { return v === true || v === 'TRUE' || v === 'true'; }

function handleBlockedSlotWrite(payload) {
  const sh = _blockedSheet();
  const blockId = payload.blockId;
  if (!blockId) return _fail('blockId is required.');
  const rowNum = _findRow(sh, 'BlockId', blockId);
  const action = payload.action || 'create';

  if (action === 'delete') {
    // Soft delete (fix Requirement #6): mark Deleted instead of removing
    // the row, so the record is never actually gone from the Sheet — it
    // simply stops counting toward availability/conflict checks. A
    // Super Admin can still recover it directly in the Sheet by clearing
    // the Deleted column if a block was removed by mistake.
    if (rowNum !== -1) _writeRow(sh, rowNum, { Deleted: true, UpdatedAt: new Date().toISOString() });
    return _ok({ message: 'Block removed.' });
  }

  // PHASE 2.5 — opt-in optimistic conflict check, same pattern as bookings.
  const editConflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
  if (editConflict) return _editConflictFail(editConflict);

  const updatedAt = new Date().toISOString();
  _writeRow(sh, rowNum === -1 ? null : rowNum, {
    BlockId: blockId, FromDate: payload.fromDate, ToDate: payload.toDate,
    BlockedDate: payload.blockedDate, StartTime: payload.startTime, EndTime: payload.endTime,
    Reason: payload.reason, Notes: payload.notes, SeriesId: payload.seriesId,
    CreatedBy: payload.createdBy, UpdatedAt: updatedAt, Deleted: false
  });
  return _ok({ message: 'Block saved.', updatedAt: updatedAt });
}

// GET action=fullSync — the read half of making the Sheet the actual
// single source of truth (fixes Requirements #5–#8): returns every active
// booking and blocked slot, in the same shape admin.html's local records
// use, so a device that never saw a record created elsewhere (a different
// admin, a different browser, a fresh install after clearing site data)
// can merge it in instead of just not knowing it exists. Cancelled
// bookings and soft-deleted blocks ARE included (marked as such) so a
// device's history stays complete rather than silently pruned.
// ssOverride lets the same reader serve both the live fullSync endpoint and
// the Phase 1 "restore bookings/blocked slots from a backup" endpoint below,
// so the two can never silently drift into different shapes.
function _readBookingsAndBlocks(ssOverride) {
  const bookings = _rowsAsObjects(_bookingsSheet(ssOverride)).map(function (r) {
    return {
      bookingId: r.BookingId, name: r.Name, phone: r.Phone, date: _dateStr(r.Date),
      start: _to24h(r.Start), end: _to24h(r.End), duration: r.Duration, sport: r.Sport, ground: r.Ground,
      total: r.Total, advance: r.Advance, pending: r.Pending, payment: r.Payment,
      balancePayment: r.BalancePayment, balancePaidAt: r.BalancePaidAt, status: r.Status,
      createdAt: r.CreatedAt, createdBy: r.CreatedBy, slot: 'Full Ground', notes: '', bookingType: 'confirmed'
    };
  });
  const blockedSlots = _rowsAsObjects(_blockedSheet(ssOverride))
    .filter(function (r) { return !_isDeleted(r.Deleted); })
    .map(function (r) {
      return {
        id: r.BlockId, date: _dateStr(r.FromDate || r.BlockedDate), start: _to24h(r.StartTime), end: _to24h(r.EndTime),
        reason: r.Reason, notes: r.Notes, seriesId: r.SeriesId, createdBy: r.CreatedBy
      };
    });
  return { bookings: bookings, blockedSlots: blockedSlots };
}

function handleFullSync(e) {
  return _ok(_readBookingsAndBlocks());
}

// GET action=availability&date=YYYY-MM-DD — merges Bookings + BlockedSlots
// for that date into one list of {start,end,status,reason}, all times
// converted to the "H:MM AM/PM" format index.html's grid expects, no
// matter which 24h/12h format was actually stored.
function handleAvailability(e) {
  const date = _dateStr(e.parameter.date);
  if (!date) return _fail('date parameter is required (YYYY-MM-DD).');

  const slots = [];
  _rowsAsObjects(_bookingsSheet()).forEach(function (r) {
    if (_dateStr(r.Date) !== date) return;
    if (r.Status === 'cancelled') return;
    slots.push({ start: _to12h(r.Start), end: _to12h(r.End), status: 'booked' });
  });
  _rowsAsObjects(_blockedSheet()).forEach(function (r) {
    if (_isDeleted(r.Deleted)) return;
    const from = _dateStr(r.FromDate || r.BlockedDate);
    const to = _dateStr(r.ToDate || r.BlockedDate);
    if (date < from || date > to) return;
    slots.push({ start: _to12h(r.StartTime), end: _to12h(r.EndTime), status: 'blocked', reason: r.Reason || '' });
  });

  return _ok({ date: date, slots: slots });
}

// ----------------------------------------------------------------------------
// PUBLIC RESERVATION REQUESTS
// ----------------------------------------------------------------------------
const REQUEST_HEADERS = ['RequestId','Name','Phone','Date','Start','End','Sport','Ground','Duration','Amount','Status','BookingId','CreatedAt','UpdatedAt','UpdatedBy'];
function _requestsSheet() { return _sheet(TABS.REQUESTS, REQUEST_HEADERS); }

function handleBookingRequestCreate(payload) {
  const sh = _requestsSheet();
  if (_findRow(sh, 'RequestId', payload.requestId) !== -1) {
    return _ok({ message: 'Already recorded.' }); // de-dupe a retried send
  }
  _writeRow(sh, null, {
    RequestId: payload.requestId, Name: payload.name, Phone: payload.phone, Date: payload.date,
    Start: payload.start, End: payload.end, Sport: payload.sport, Ground: payload.ground,
    Duration: payload.duration, Amount: payload.amount, Status: payload.status || 'PENDING',
    BookingId: '', CreatedAt: payload.createdAt, UpdatedAt: '', UpdatedBy: ''
  });
  return _ok({ message: 'Reservation request recorded.' });
}

function handleBookingRequestUpdate(payload) {
  const sh = _requestsSheet();
  const rowNum = _findRow(sh, 'RequestId', payload.requestId);
  if (rowNum === -1) return _fail('Unknown requestId — nothing to update.');

  // PHASE 2.5 — opt-in optimistic conflict check, same pattern as every
  // other editable record (see _versionConflict). Guards the case where
  // two admin devices both act on the same pending reservation request
  // (e.g. one confirms while the other rejects) at nearly the same time.
  const conflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
  if (conflict) return _editConflictFail(conflict);

  const updatedAt = payload.updatedAt || new Date().toISOString();
  _writeRow(sh, rowNum, {
    Status: payload.status, BookingId: payload.bookingId || '',
    UpdatedAt: updatedAt, UpdatedBy: payload.updatedBy || ''
  });
  return _ok({ message: 'Request updated.', updatedAt: updatedAt });
}

// GET action=pendingRequests — every request not yet CONFIRMED/REJECTED,
// for an admin device that hasn't seen it locally yet.
//
// STEP 2 ROOT-CAUSE FIX (Pending Reservation sync). This used to return
// PENDING rows and nothing else. That made the endpoint structurally
// incapable of ever delivering a STATUS CHANGE: the instant a Manager
// confirmed a request, its row simply vanished from this response, and
// admin.html's fetchPendingRequestsFromSheet() only ever reconciled rows it
// actually received. Any admin device whose Firebase listener was not
// attached — realtimeDb still null when the listener was started, a dropped
// socket, a throttled background tab — had the 30s Sheets poll as its only
// remaining channel and therefore kept showing the reservation as Pending
// forever, with nothing left in the system to correct it. That is exactly
// the reported symptom (Manager's list updates, Super Admin's does not).
//
// Now additionally returns rows actioned within RECENTLY_ACTIONED_DAYS so
// the status change itself can propagate over the Sheets path. Purely
// additive: the response shape is unchanged, every PENDING row is still
// returned exactly as before, and the extra rows carry their real Status so
// the client adopts the truth rather than inferring it. The window keeps the
// payload small — anything older than this has long since been reconciled on
// every device, and stale history is served by the Sheet itself, not here.
var RECENTLY_ACTIONED_DAYS = 14;

function handlePendingRequests(e) {
  const rows = _rowsAsObjects(_requestsSheet());
  const cutoff = new Date().getTime() - (RECENTLY_ACTIONED_DAYS * 24 * 60 * 60 * 1000);
  const requests = rows
    .filter(function (r) {
      const status = r.Status || 'PENDING';
      if (status === 'PENDING') return true;
      // Recently actioned — include so devices on the Sheets path learn the
      // new status instead of being left with a permanently stale PENDING row.
      const stamp = r.UpdatedAt || r.CreatedAt;
      if (!stamp) return false;
      const t = new Date(stamp).getTime();
      return !isNaN(t) && t >= cutoff;
    })
    .map(function (r) {
      return {
        requestId: r.RequestId, name: r.Name, phone: r.Phone, date: _dateStr(r.Date),
        start: _to12h(r.Start), end: _to12h(r.End), sport: r.Sport, ground: r.Ground, duration: r.Duration,
        amount: r.Amount, status: r.Status, bookingId: r.BookingId, createdAt: r.CreatedAt,
        // PHASE 2.5 — conflict-check baseline for the admin's first confirm/reject.
        updatedAt: r.UpdatedAt || ''
      };
    });
  return _ok({ requests: requests });
}

// ----------------------------------------------------------------------------
// GENERIC UPSERT / APPEND-ONLY HELPERS  (students, enquiries, attendance, café, audit)
// ----------------------------------------------------------------------------
function handleGenericUpsert(payload, tabName, fields, keyField) {
  const headers = fields.map(function (f) { return f.charAt(0).toUpperCase() + f.slice(1); });
  const sh = _sheet(tabName, headers);
  _ensureHeaders(sh, ['UpdatedAt']); // PHASE 2.5 — additive column, migrates an existing tab in place
  const keyHeader = keyField.charAt(0).toUpperCase() + keyField.slice(1);
  const keyValue = payload[keyField];
  const action = payload.action || 'create';
  const rowNum = keyValue ? _findRow(sh, keyHeader, keyValue) : -1;

  if (action === 'delete') {
    _deleteRow(sh, rowNum);
    return _ok({ message: 'Deleted.' });
  }

  // PHASE 2.5 — opt-in optimistic conflict check (see _versionConflict).
  const conflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
  if (conflict) return _editConflictFail(conflict);

  const obj = {};
  fields.forEach(function (f) {
    const header = f.charAt(0).toUpperCase() + f.slice(1);
    obj[header] = payload[f];
  });
  const updatedAt = new Date().toISOString();
  obj['UpdatedAt'] = updatedAt;
  _writeRow(sh, rowNum === -1 ? null : rowNum, obj);
  return _ok({ message: 'Saved.', updatedAt: updatedAt });
}

function handleAppendOnly(payload, tabName, fields) {
  const headers = fields.map(function (f) { return f.charAt(0).toUpperCase() + f.slice(1); });
  const sh = _sheet(tabName, headers);
  const obj = {};
  fields.forEach(function (f) {
    const header = f.charAt(0).toUpperCase() + f.slice(1);
    obj[header] = payload[f];
  });
  _writeRow(sh, null, obj);
  return _ok({ message: 'Logged.' });
}

// Coaching fees route to their own "<Sport> Coaching - <Mon YYYY>" tab so
// they never mix with turf bookings or each other.
function handleCoachingFee(payload, type) {
  const sport = type.replace('coaching_', '');
  const label = sport.charAt(0).toUpperCase() + sport.slice(1);
  const monthLabel = (payload.month && payload.year) ? (payload.month + ' ' + payload.year) : Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kolkata', 'MMM yyyy');
  const tabName = label + ' Coaching - ' + monthLabel;
  const headers = ['StudentId','StudentName','Sport','Month','Year','Amount','Paid','Pending','PaymentMethod','Date','Status','Notes'];
  const sh = _sheet(tabName, headers);
  _ensureHeaders(sh, ['UpdatedAt', 'IncludesJoiningFee']); // PHASE 2.5 / 3.4a — additive columns, migrate an existing tab in place
  const rowNum = payload.studentId ? _findRow(sh, 'StudentId', payload.studentId) : -1;

  // PHASE 2.5 — opt-in optimistic conflict check, same pattern as bookings.
  const conflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
  if (conflict) return _editConflictFail(conflict);

  const updatedAt = new Date().toISOString();
  _writeRow(sh, rowNum === -1 ? null : rowNum, {
    StudentId: payload.studentId, StudentName: payload.studentName, Sport: payload.sport,
    Month: payload.month, Year: payload.year, Amount: payload.amount, Paid: payload.paid,
    Pending: payload.pending, PaymentMethod: payload.paymentMethod, Date: payload.date,
    Status: payload.status, Notes: payload.notes,
    IncludesJoiningFee: !!payload.includesJoiningFee, // PHASE 3.4a
    UpdatedAt: updatedAt
  });
  return _ok({ message: 'Coaching fee recorded.', updatedAt: updatedAt });
}

// ----------------------------------------------------------------------------
// PHASE 3.4b — FEE COLLECTION
// ----------------------------------------------------------------------------
// One consolidated Fees tab (TABS.FEES) — the first time fee data gets a
// real GET reader, matching the pattern Coaches (3.1) and Students (3.2a)
// already established for "give it a real endpoint instead of push-only."
// ReceiptNo is the row's own key (like StudentId/CoachId elsewhere),
// minted server-side on create — never client-supplied — because only the
// server can guarantee a globally unique sequence across concurrent
// devices; doPost's existing script lock (see doPost above) already
// serializes every write, so no extra locking is needed here.
const FEES_HEADERS = ['ReceiptNo','StudentId','StudentName','Sport','Batch','Coach',
  'FeeType','DueMonth','Year','AmountPayable','AmountReceived','Pending',
  'PaymentMethod','PaymentType','Status','ReceiptDate','Notes','IncludesJoiningFee',
  'CreatedBy','CreatedAt','UpdatedAt'];
function _feesSheet() {
  return _sheet(TABS.FEES, FEES_HEADERS);
}

// GET action=fees — every fee payment ever recorded, translated back into
// the same field names admin.html's window.DB.fees records already use.
function handleFeesGet(e) {
  const fees = _rowsAsObjects(_feesSheet()).map(function (r) {
    return {
      receiptNo: r.ReceiptNo, studentId: r.StudentId, studentName: r.StudentName,
      sport: r.Sport, batch: r.Batch, coach: r.Coach,
      feeType: r.FeeType, dueMonth: r.DueMonth, year: r.Year,
      amountPayable: r.AmountPayable, amountReceived: r.AmountReceived, pending: r.Pending,
      paymentMethod: r.PaymentMethod, paymentType: r.PaymentType, status: r.Status,
      receiptDate: _dateStr(r.ReceiptDate) || r.ReceiptDate, notes: r.Notes,
      includesJoiningFee: !!r.IncludesJoiningFee,
      createdBy: r.CreatedBy, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt || ''
    };
  });
  return _ok({ fees: fees });
}

// Mints "DDTZ-YYYYMM-00001", sequential WITHIN that month, by scanning
// existing receipt numbers for the same prefix and taking max+1. Runs
// entirely inside doPost's already-held script lock, so this can't race
// against another concurrent save.
function _nextReceiptNumber(sh, dateVal) {
  const d = dateVal ? new Date(dateVal) : new Date();
  const prefix = 'DDTZ-' + Utilities.formatDate(d, _tz(), 'yyyyMM') + '-';
  const rows = _rowsAsObjects(sh);
  let maxSeq = 0;
  rows.forEach(function (r) {
    const rn = String(r.ReceiptNo || '');
    if (rn.indexOf(prefix) === 0) {
      const seq = parseInt(rn.slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  let candidate = prefix + String(maxSeq + 1).padStart(5, '0');
  // Belt-and-braces duplicate check — structurally shouldn't be possible
  // under the write lock, but costs nothing to confirm before committing.
  while (_findRow(sh, 'ReceiptNo', candidate) !== -1) {
    maxSeq++;
    candidate = prefix + String(maxSeq + 1).padStart(5, '0');
  }
  return candidate;
}

// POST type='fee' — action 'create' (default, mints a new ReceiptNo) or
// 'update' (payload.receiptNo identifies the existing row; every other
// field may change, but ReceiptNo/CreatedBy/CreatedAt never do). Never
// touches the Students tab — this only ever reads/writes the Fees tab.
function handleFeeWrite(payload) {
  const sh = _feesSheet();
  const action = payload.action || (payload.receiptNo ? 'update' : 'create');
  let receiptNo = payload.receiptNo || '';
  let rowNum = -1;

  // Fee Collection Integration (Phase 3) — this branch previously didn't
  // exist at all. A delete request had nowhere to go: 'delete' isn't
  // 'update', so it fell into the else below and CREATED A BRAND-NEW ROW
  // with a freshly-minted receipt number instead of removing anything —
  // the exact opposite of what was requested, and completely silent
  // about it. Soft-deletes (Status='deleted') rather than physically
  // removing the row, matching the same reasoning bookings' cancel
  // already uses: a financial record should stay traceable in the
  // permanent backend even after deletion, not vanish without a trace.
  if (action === 'delete') {
    if (!receiptNo) return _fail('receiptNo is required to delete a fee payment.');
    rowNum = _findRow(sh, 'ReceiptNo', receiptNo);
    if (rowNum === -1) return _fail('That receipt was not found — it may already be removed or not yet synced here.');
    _writeRow(sh, rowNum, { Status: 'deleted', UpdatedAt: new Date().toISOString() });
    return _ok({ message: 'Fee payment marked deleted.', receiptNo: receiptNo });
  }

  if (action === 'update') {
    if (!receiptNo) return _fail('receiptNo is required to update a fee payment.');
    rowNum = _findRow(sh, 'ReceiptNo', receiptNo);
    if (rowNum === -1) return _fail('That receipt was not found — it may have been created on another device and not synced here yet.');
    const conflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
    if (conflict) return _editConflictFail(conflict);
  } else {
    receiptNo = _nextReceiptNumber(sh, payload.receiptDate);
  }

  const updatedAt = new Date().toISOString();
  const obj = {
    ReceiptNo: receiptNo, StudentId: payload.studentId, StudentName: payload.studentName,
    Sport: payload.sport, Batch: payload.batch, Coach: payload.coach,
    FeeType: payload.feeType, DueMonth: payload.dueMonth, Year: payload.year,
    AmountPayable: payload.amountPayable, AmountReceived: payload.amountReceived, Pending: payload.pending,
    PaymentMethod: payload.paymentMethod, PaymentType: payload.paymentType, Status: payload.status,
    ReceiptDate: payload.receiptDate, Notes: payload.notes,
    IncludesJoiningFee: !!payload.includesJoiningFee, UpdatedAt: updatedAt
  };
  // Only stamp CreatedBy/CreatedAt on a brand-new row — same reasoning as
  // every other module here (_writeRow treats any present key as an
  // explicit overwrite, so an update must omit these).
  if (rowNum === -1) {
    obj.CreatedBy = payload.createdBy || '';
    obj.CreatedAt = updatedAt;
  }
  _writeRow(sh, rowNum === -1 ? null : rowNum, obj);
  return _ok({ message: 'Fee payment saved.', receiptNo: receiptNo, updatedAt: updatedAt });
}

// ----------------------------------------------------------------------------
// PHASE 3.2a — STUDENT CORE
// ----------------------------------------------------------------------------
// Students previously rode the generic upsert helper with only 8 narrow
// fields (studentId, studentName, phone, sport, batch, fees, joiningDate,
// status) — every other field the admin UI's Student form already collects
// (guardian, mother, dob, gender, bloodGroup, school, emergencyContact,
// address, altPhone, email, coach, feeStructure, quarterlyFees,
// medicalNotes, remarks) was silently dropped on the way to the Sheet, and
// there was no GET reader at all, so a brand-new device never backfilled
// existing students (same gap Coaches had before Phase 3.1). This section
// closes both gaps using the exact same building blocks as Coaches:
//   - Base header row kept EXACTLY as already deployed in production
//     (StudentId/StudentName/Phone/Sport/Batch/Fees/JoiningDate/Status),
//     with every new field added additively via _ensureHeaders — the same
//     non-destructive migration Phase 2.5 used to add UpdatedAt, so no
//     existing row or column is ever touched or reordered.
//   - Archive/Restore instead of a hard delete. Phase 3.2a's roadmap item
//     is "Add/Edit/View/Archive/Restore", not permanent delete (bulk
//     permanent delete is explicitly a Phase 3.2b item, Admin-only) — so a
//     student removed here is marked Archived, never actually erased.
//   - _versionConflict / _editConflictFail — identical opt-in optimistic
//     concurrency every other module already uses.
//   - Photo and document uploads are deliberately NOT synced here — those
//     stay device-local (as they already were) until Phase 3.2d.
const STUDENT_BASE_HEADERS = ['StudentId','StudentName','Phone','Sport','Batch','Fees','JoiningDate','Status'];
const STUDENT_EXTRA_HEADERS = ['AdmissionNo','AltPhone','Email','Guardian','Mother','Gender','Dob','BloodGroup','School',
  'EmergencyContact','Address','Coach','FeeStructure','QuarterlyFees','MedicalNotes','Remarks',
  'CreatedBy','CreatedAt','UpdatedAt','Archived',
  // PHASE 3.4a — Fee Structure & Plans. Additive via the same _ensureHeaders
  // migration every earlier column here already used — no existing row or
  // column is touched, reordered, or renamed.
  'YearlyFees','DiscountType','DiscountValue','JoiningFee','DueDay'];
function _studentsSheet(ssOverride) {
  const sh = _sheet(TABS.STUDENTS, STUDENT_BASE_HEADERS, ssOverride);
  _ensureHeaders(sh, STUDENT_EXTRA_HEADERS); // additive-only migration, matches every other module's pattern
  return sh;
}

// GET action=students — every non-archived student, translated back into
// the same field names the admin UI's window.DB.students records already
// use (see saveStudent/autoSyncStudent in admin.html), so a device that
// never created a given student locally can still merge it in on load —
// exactly the fix Coaches got in Phase 3.1.
function handleStudentsGet(e) {
  const students = _rowsAsObjects(_studentsSheet())
    .filter(function (r) { return !_isDeleted(r.Archived); })
    .map(function (r) {
      return {
        studentId: r.StudentId, admissionNo: r.AdmissionNo, name: r.StudentName, phone: r.Phone,
        altPhone: r.AltPhone, email: r.Email, parent: r.Guardian, mother: r.Mother,
        gender: r.Gender, dob: _dateStr(r.Dob) || r.Dob, bloodGroup: r.BloodGroup,
        school: r.School, emergencyContact: r.EmergencyContact, address: r.Address,
        sport: r.Sport, batch: r.Batch, coach: r.Coach,
        feeStructure: r.FeeStructure || 'monthly', fee: r.Fees, qfee: r.QuarterlyFees,
        // PHASE 3.4a — Fee Structure & Plans
        yearlyFee: r.YearlyFees, discountType: r.DiscountType || 'none', discountValue: r.DiscountValue,
        joiningFee: r.JoiningFee, dueDay: r.DueDay,
        joined: _dateStr(r.JoiningDate) || r.JoiningDate, medicalNotes: r.MedicalNotes,
        remarks: r.Remarks, status: r.Status,
        createdBy: r.CreatedBy, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt || '',
        archived: _isDeleted(r.Archived)
      };
    });
  return _ok({ students: students });
}

// POST type='student' — action: create | update | archive | restore |
// permanent_delete (default 'create' for a new record, matching
// handleGenericUpsert's convention elsewhere; a bare/legacy 'delete' is
// treated as an alias for 'archive' rather than removing the row, so no
// student record is ever silently destroyed by an older cached client —
// permanent_delete is the one and only real hard-delete path, and it's a
// distinct, deliberately-named action so it can never be triggered by
// accident or by a stale/legacy payload).
// PRODUCTION STABILIZATION — genuine server-side re-verification for this
// one specifically irreversible action, in ADDITION to (not instead of)
// the existing client-side gating + shared-secret convention every other
// handler in this file relies on. Reuses the exact same Users-sheet
// lookup + _normalizeRole already used by handleLogin/restoreSession's
// re-check — no new security mechanism invented, just applied here too.
function _requesterIsSuperAdmin(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return false;
  const rows = _rowsAsObjects(_usersSheet());
  const user = rows.find(function (r) { return String(r.Email || '').trim().toLowerCase() === cleanEmail; });
  if (!user) return false;
  if (user.Active === false || user.Active === 'FALSE' || user.Active === 'false') return false;
  return _normalizeRole(user.Role) === 'superadmin';
}

// PRODUCTION STABILIZATION — cascades a student's permanent deletion to
// their Fee Collection records, which (unlike Attendance and Due
// Adjustments — both documented append-only ledgers elsewhere in this
// file) are genuinely deletable, ordinary records; Fee Collection's own
// delete button already removes a single row the same way. Deletes in
// descending row order so removing one match never shifts the row
// number of another match still pending deletion.
function _deleteFeeRowsForStudent(studentId) {
  const sh = _feesSheet();
  const rows = _rowsAsObjects(sh).filter(function (r) { return String(r.StudentId) === String(studentId); });
  rows.sort(function (a, b) { return b._row - a._row; });
  rows.forEach(function (r) { _deleteRow(sh, r._row); });
  return rows.length;
}

function handleStudentWrite(payload) {
  const sh = _studentsSheet();
  const studentId = payload.studentId;
  if (!studentId) return _fail('studentId is required.');
  const rowNum = _findRow(sh, 'StudentId', studentId);
  const action = payload.action || (rowNum === -1 ? 'create' : 'update');

  if (action === 'archive' || action === 'delete') {
    if (rowNum !== -1) _writeRow(sh, rowNum, { Archived: true, UpdatedAt: new Date().toISOString() });
    return _ok({ message: 'Student archived.' });
  }
  if (action === 'restore') {
    if (rowNum !== -1) _writeRow(sh, rowNum, { Archived: false, UpdatedAt: new Date().toISOString() });
    return _ok({ message: 'Student restored.' });
  }
  // PHASE 3.2b-i — Bulk Delete (Super Admin only). Who may call this is
  // gated client-side (admin.html's ACTION_PERMISSIONS.bulkDeleteStudents
  // + the shared-secret token every write already requires), the same
  // convention every other handler in this file already uses — see the
  // Coaches section's comment for why no per-request role check lives
  // inside a handler here. No conflict check either: a permanent delete
  // is deliberately absolute, not something to retry after a merge.
  //
  // PRODUCTION STABILIZATION — this action is now ALSO re-verified
  // server-side (see _requesterIsSuperAdmin above), on top of the
  // existing client-side gating, per explicit requirement that this
  // specific irreversible action be enforced in both UI and backend.
  // Cascades to Fee Collection rows for this student; Attendance and Due
  // Adjustment rows are deliberately left untouched — both are
  // documented append-only historical ledgers (same "accounting
  // reversals" principle as DueAdjustments/CafeSales above) — a deleted
  // student is simply excluded from anything computed from this point
  // forward, never retroactively scrubbed from past history.
  if (action === 'permanent_delete') {
    if (!_requesterIsSuperAdmin(payload.requestedByEmail)) {
      return _fail('Only Super Admin may permanently delete a student.');
    }
    const feesDeleted = _deleteFeeRowsForStudent(studentId);
    if (rowNum !== -1) _deleteRow(sh, rowNum);
    return _ok({ message: 'Student permanently deleted.', feesDeleted: feesDeleted });
  }

  // PHASE 3.2a — opt-in optimistic conflict check, identical pattern to
  // every other editable record (see _versionConflict).
  const conflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
  if (conflict) return _editConflictFail(conflict);

  const updatedAt = new Date().toISOString();
  const obj = {
    StudentId: studentId, AdmissionNo: payload.admissionNo, StudentName: payload.studentName, Phone: payload.phone,
    AltPhone: payload.altPhone, Email: payload.email, Guardian: payload.guardian, Mother: payload.mother,
    Gender: payload.gender, Dob: payload.dob, BloodGroup: payload.bloodGroup, School: payload.school,
    EmergencyContact: payload.emergencyContact, Address: payload.address,
    Sport: payload.sport, Batch: payload.batch, Coach: payload.coach,
    FeeStructure: payload.feeStructure, Fees: payload.fees, QuarterlyFees: payload.quarterlyFees,
    // PHASE 3.4a — Fee Structure & Plans
    YearlyFees: payload.yearlyFees, DiscountType: payload.discountType, DiscountValue: payload.discountValue,
    JoiningFee: payload.joiningFee, DueDay: payload.dueDay,
    JoiningDate: payload.joiningDate, MedicalNotes: payload.medicalNotes, Remarks: payload.remarks,
    Status: payload.status, UpdatedAt: updatedAt
  };
  // Only stamp CreatedBy/CreatedAt/Archived on a brand-new row — same
  // reasoning as Coaches: _writeRow treats any key present as an explicit
  // overwrite, so an update must omit these rather than blank out the
  // original values (an update should never silently un-archive a student
  // that was archived out-of-band; only the archive/restore actions above
  // may ever flip that flag once a row exists).
  if (rowNum === -1) {
    obj.CreatedBy = payload.createdBy || '';
    obj.CreatedAt = new Date().toISOString();
    obj.Archived = false;
  }
  _writeRow(sh, rowNum === -1 ? null : rowNum, obj);
  return _ok({ message: 'Student saved.', updatedAt: updatedAt });
}

// ----------------------------------------------------------------------------
// PHASE 3.5 — STUDENT ENROLMENT REQUEST SYSTEM
// ----------------------------------------------------------------------------
// A parent-facing public form (no login) writes a PENDING request here.
// Admin's Pending Enrolments page then Views/Edits/Approves/Rejects it —
// Approve is the ONLY path that ever creates a real Student record
// (admin.html does that client-side, the same way a manually-added
// student is created, then syncs it through the normal 'student' write —
// nothing here auto-creates a student). Rows are never deleted: Approve
// and Reject both just change Status and keep the row as permanent
// history, same "never delete, just change Status" convention
// BookingRequests already uses.
const ENROLMENT_HEADERS = ['RequestId','StudentName','Dob','Gender','ParentName','Mobile','Email','Address',
  'School','Sport','Batch','MedicalNotes','Status','RejectionReason','ApprovedStudentId',
  'CreatedAt','UpdatedAt','UpdatedBy'];
function _enrolmentsSheet() { return _sheet(TABS.ENROLMENTS, ENROLMENT_HEADERS); }

// POST type='enrolment_request' — PUBLIC, no shared-secret token required
// (see the doPost exemption above), so this must never trust anything
// beyond "write exactly these fields, nothing else" the same way
// handleBookingRequestCreate treats its own public payload.
function handleEnrolmentRequestCreate(payload) {
  const sh = _enrolmentsSheet();
  if (_findRow(sh, 'RequestId', payload.requestId) !== -1) {
    return _ok({ message: 'Already recorded.' }); // de-dupe a retried submit
  }
  _writeRow(sh, null, {
    RequestId: payload.requestId, StudentName: payload.studentName, Dob: payload.dob, Gender: payload.gender,
    ParentName: payload.parentName, Mobile: payload.mobile, Email: payload.email || '',
    Address: payload.address || '', School: payload.school || '', Sport: payload.sport, Batch: payload.batch || '',
    MedicalNotes: payload.medicalNotes || '', Status: 'PENDING', RejectionReason: '', ApprovedStudentId: '',
    CreatedAt: payload.createdAt || new Date().toISOString(), UpdatedAt: '', UpdatedBy: ''
  });
  // The public form has no relationship to admin.html's client-side
  // queuedSync()/logAudit() (different page, different device, no
  // login) — every OTHER module gets its Activity Log / Notification
  // Center / real-time-sync entry for free because an admin device's own
  // queuedSync() logs it automatically, but nothing here would do that
  // for a parent's own submission. This is the one place a log row has
  // to be written ON THE SERVER so the Bell/Sound/Activity Log/real-time
  // sync requirement fires the instant a parent submits, with zero admin
  // device involved. Reuses handleAuditLog's own row shape directly
  // rather than a second copy of it.
  handleAuditLog({
    timestamp: payload.createdAt || new Date().toISOString(), user: payload.parentName || 'Enrolment Form',
    role: '', device: 'public-form', action: 'Enrolment Request Received', module: 'enrolment_request',
    recordId: payload.requestId, summary: 'Enrolment Request Received — ' + (payload.studentName || ''),
    newValue: payload
  });
  return _ok({ message: 'Enrolment request received.' });
}

// GET action=enrolments — every enrolment request regardless of status
// (Pending/Approved/Rejected), so Admin's History views have everything,
// not just what's still pending.
function handleEnrolmentsGet(e) {
  const requests = _rowsAsObjects(_enrolmentsSheet()).map(function (r) {
    return {
      requestId: r.RequestId, studentName: r.StudentName, dob: _dateStr(r.Dob) || r.Dob, gender: r.Gender,
      parentName: r.ParentName, mobile: r.Mobile, email: r.Email, address: r.Address, school: r.School,
      sport: r.Sport, batch: r.Batch, medicalNotes: r.MedicalNotes, status: r.Status || 'PENDING',
      rejectionReason: r.RejectionReason || '', approvedStudentId: r.ApprovedStudentId || '',
      createdAt: r.CreatedAt, updatedAt: r.UpdatedAt || ''
    };
  });
  return _ok({ requests: requests });
}

// ----------------------------------------------------------------------------
// PHASE 3.1 — COACHES BACKEND
// ----------------------------------------------------------------------------
// Coaches was local-only through Phase 2.5 (see CHANGELOG.md's "Known
// Limitation" entry for that freeze) — no Sheet tab, no endpoint, no sync.
// This section closes that gap using the exact same building blocks every
// other module already relies on:
//   - Soft delete (Deleted column), same as Blocked Slots — a coach
//     removed on one device still exists in the Sheet (recoverable by
//     clearing the column directly) and other devices can tell "gone" apart
//     from "never existed".
//   - _versionConflict / _editConflictFail — the identical opt-in
//     optimistic-concurrency check Bookings/Blocked Slots/Students/
//     Enquiries/Coaching Fees/Staff/Booking Requests already use. A client
//     that sends expectedUpdatedAt gets full conflict protection; the admin
//     UI's saveCoach()/deleteCoach() always sends it once a record has a
//     server updatedAt, matching every other module.
//   - A real GET reader (handleCoachesGet), unlike Students/Enquiries which
//     rely only on the live syncEvents feed and so never backfill a brand
//     new device's history. Coaches gets a proper list endpoint (same shape
//     idea as _readBookingsAndBlocks/handleFullSync) so a fresh device
//     actually sees every existing coach, not just ones added after it
//     started polling — this is what makes "cross-device sync" real for
//     this module instead of best-effort.
// Coach permissions (who may create/edit/delete a coach) are enforced the
// same way every other role-gated action in this app already is: client-
// side, in admin.html's ACTION_PERMISSIONS/PAGE_PERMISSIONS (checked before
// the request is even sent) plus the shared-secret token every write here
// already requires when one is configured (see doPost). There is no
// separate per-request role check inside this handler, because no other
// handler in this file has one either — adding one just for Coaches would
// be a new authorization model, not a finish of existing work, and Coaches
// already inherits the same protection Staff/Users/Bookings/etc. rely on.
const COACH_HEADERS = ['CoachId','Name','Phone','Sport','Salary','Joined','Status','CreatedBy','CreatedAt','UpdatedAt','Deleted'];
function _coachesSheet(ssOverride) { return _sheet(TABS.COACHES, COACH_HEADERS, ssOverride); }

// GET action=coaches — every active (non-deleted) coach, in the same
// shape the admin UI's window.DB.coaches records use, so a device that
// never created a given coach locally can still merge it in on load.
// PHASE 5 — Coach Settlement Backend. Same _rowsAsObjects + map shape as
// handleCoachesGet just below — JSON columns (Totals/Students/
// PaymentHistory) are parsed back into real objects/arrays here so
// admin.html never has to JSON.parse them itself. A malformed cell
// (shouldn't happen, since only this backend ever writes it) falls back
// to a safe empty value rather than throwing and failing the whole sync.
function _safeJsonParse(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; }
}
function handleCoachSettlementsGet(e) {
  const settlements = _rowsAsObjects(_sheet(TABS.COACH_SETTLEMENTS,
    ['SettlementId','CoachId','CoachName','Sport','MonthValue','MonthLabel','Year','RevenueSharePercent',
     'Totals','Students','Status','PaymentHistory','GeneratedDate','GeneratedBy','UpdatedAt']))
    .map(function (r) {
      return {
        settlementId: r.SettlementId, coachId: r.CoachId, coachName: r.CoachName, sport: r.Sport,
        monthValue: r.MonthValue, monthLabel: r.MonthLabel, year: r.Year,
        revenueSharePercent: Number(r.RevenueSharePercent) || 0,
        totals: _safeJsonParse(r.Totals, {}),
        students: _safeJsonParse(r.Students, []),
        status: r.Status || 'Pending',
        paymentHistory: _safeJsonParse(r.PaymentHistory, []),
        generatedDate: r.GeneratedDate, generatedBy: r.GeneratedBy, updatedAt: r.UpdatedAt || ''
      };
    });
  return _ok({ settlements: settlements });
}

// GET action=dueAdjustments — every Manual Due Correction ever logged,
// in the same shape admin.html's window.DB.dueAdjustments records use
// (see saveDueAdjustment in admin.html). TABS.DUE_ADJUSTMENTS is written
// by handleAppendOnly with Title-Case headers derived from the lowercase
// field list ['id','studentId','studentName','feeType','month','quarter',
// 'year','amount','reason','updatedBy','updatedAt'] — this just reverses
// that mapping. Append-only, so no Deleted/soft-delete filtering needed.
function handleDueAdjustmentsGet(e) {
  const rows = _rowsAsObjects(_sheet(TABS.DUE_ADJUSTMENTS,
    ['Id','StudentId','StudentName','FeeType','Month','Quarter','Year','Amount','Reason','UpdatedBy','UpdatedAt']));
  const adjustments = rows.map(function (r) {
    return {
      id: r.Id, studentId: r.StudentId, studentName: r.StudentName,
      feeType: r.FeeType, month: r.Month, quarter: r.Quarter, year: r.Year,
      amount: Number(r.Amount) || 0, reason: r.Reason,
      updatedBy: r.UpdatedBy, updatedAt: r.UpdatedAt || ''
    };
  });
  return _ok({ dueAdjustments: adjustments });
}

// ROOT-CAUSE addition — Attendance previously had no GET reader at all
// (write-only, same original gap DueAdjustments had before Phase 6). Added
// specifically so the Coaching Module Reset's post-reset verification step
// can independently re-fetch and confirm Attendance is genuinely empty,
// the same way it already does for Students/Fees/DueAdjustments/
// CoachSettlements — not just trust the delete step's own report.
function handleAttendanceGet(e) {
  const rows = _rowsAsObjects(_sheet(TABS.ATTENDANCE, ['AttendanceId','Date','Student','Batch','Coach','Status']));
  const records = rows.map(function (r) {
    return {
      attendanceId: r.AttendanceId, date: _dateStr(r.Date) || r.Date,
      student: r.Student, batch: r.Batch, coach: r.Coach, status: r.Status
    };
  });
  return _ok({ attendance: records });
}

function handleCoachesGet(e) {
  const coaches = _rowsAsObjects(_coachesSheet())
    .filter(function (r) { return !_isDeleted(r.Deleted); })
    .map(function (r) {
      return {
        coachId: r.CoachId, name: r.Name, phone: r.Phone, sport: r.Sport,
        salary: r.Salary, joined: _dateStr(r.Joined) || r.Joined, status: r.Status,
        createdBy: r.CreatedBy, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt || ''
      };
    });
  return _ok({ coaches: coaches });
}

// POST type='coach' — action: create | update | delete (default 'create'
// for a new record, matching handleGenericUpsert's convention elsewhere).
function handleCoachWrite(payload) {
  const sh = _coachesSheet();
  const coachId = payload.coachId;
  if (!coachId) return _fail('coachId is required.');
  const rowNum = _findRow(sh, 'CoachId', coachId);
  const action = payload.action || (rowNum === -1 ? 'create' : 'update');

  if (action === 'delete') {
    // Soft delete, same reasoning as Blocked Slots: never actually remove
    // the row, just stop it counting as an active coach.
    if (rowNum !== -1) _writeRow(sh, rowNum, { Deleted: true, UpdatedAt: new Date().toISOString() });
    return _ok({ message: 'Coach removed.' });
  }

  // PHASE 3.1 — opt-in optimistic conflict check, identical pattern to
  // every other editable record (see _versionConflict).
  const conflict = _versionConflict(sh, rowNum, payload.expectedUpdatedAt, payload.forceOverwrite);
  if (conflict) return _editConflictFail(conflict);

  const updatedAt = new Date().toISOString();
  const obj = {
    CoachId: coachId, Name: payload.name, Phone: payload.phone, Sport: payload.sport,
    Salary: payload.salary, Joined: payload.joined, Status: payload.status,
    UpdatedAt: updatedAt, Deleted: false
  };
  // Only stamp CreatedBy/CreatedAt on a brand-new row — _writeRow treats
  // any key present in this object as an explicit overwrite (even an
  // undefined one), so an update must simply omit these keys rather than
  // set them to undefined, or it would blank out the original values.
  if (rowNum === -1) {
    obj.CreatedBy = payload.createdBy || '';
    obj.CreatedAt = new Date().toISOString();
  }
  _writeRow(sh, rowNum === -1 ? null : rowNum, obj);
  return _ok({ message: 'Coach saved.', updatedAt: updatedAt });
}

// ----------------------------------------------------------------------------
// SITE CONFIG (images / pricing / videos shown on the public homepage)
// ----------------------------------------------------------------------------
function _siteConfigSheet() { return _sheet(TABS.SITE_CONFIG, ['Images', 'Pricing', 'Videos', 'UpdatedAt', 'UpdatedBy']); }

function handleSiteConfigSet(payload) {
  const sh = _siteConfigSheet();
  // Only ever keep one row — "Apps Script keeps only the latest one",
  // matching the comment already in admin.html.
  const obj = {
    Images: JSON.stringify(payload.images || {}),
    Pricing: JSON.stringify(payload.pricing || {}),
    Videos: JSON.stringify(payload.videos || []),
    UpdatedAt: payload.updatedAt || new Date().toISOString(),
    UpdatedBy: payload.updatedBy || ''
  };
  _writeRow(sh, sh.getLastRow() >= 2 ? 2 : null, obj);
  return _ok({ message: 'Site config published.' });
}

function handleSiteConfigGet(e) {
  const sh = _siteConfigSheet();
  if (sh.getLastRow() < 2) return _ok({ config: null });
  const row = _rowsAsObjects(sh)[0];
  let images = {}, pricing = {}, videos = [];
  try { images = JSON.parse(row.Images || '{}'); } catch (err) {}
  try { pricing = JSON.parse(row.Pricing || '{}'); } catch (err) {}
  try { videos = JSON.parse(row.Videos || '[]'); } catch (err) {}
  return _ok({ config: { images: images, pricing: pricing, videos: videos } });
}

// ============================================================================
// PHASE 2.5 — REAL-TIME SYNC & LIVE NOTIFICATIONS (additive, on top of the
// existing AuditLog tab — nothing here touches Bookings, BlockedSlots,
// BookingRequests, Students, Attendance, Enquiries, CafeSales, Backup,
// Import, or Reports).
//
// The Sheet has no push/websocket channel, so "real-time" here means:
// every real write already calls the client's logAudit() (admin.html did
// this before Phase 2.5 too, just with 3 columns). This section widens
// that same AuditLog tab into a full change-event feed — Module, RecordId,
// Role, Device, and a JSON snapshot of what changed — and adds ONE cheap
// read endpoint (syncEvents) that returns only the rows written since the
// caller's last-seen row number. admin.html polls that endpoint every
// 2-3s instead of re-reading whole tabs, which is what makes this fast
// AND quota-friendly at the same time.
// ============================================================================

// Adds any header in extraHeaders that the sheet doesn't already have, as
// new trailing columns. Never touches or reorders existing columns, so a
// pre-existing AuditLog tab (old 3-column shape) keeps every row it
// already has — old rows simply read back blank for the new columns.
function _ensureHeaders(sh, extraHeaders) {
  const headers = _headers(sh);
  const missing = extraHeaders.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    sh.getRange(1, headers.length + 1, 1, missing.length).setFontWeight('bold');
  }
}

const AUDIT_HEADERS = ['Timestamp', 'User', 'Role', 'Device', 'Action', 'Module', 'RecordId', 'Summary', 'PrevValue', 'NewValue'];
function _auditSheet() {
  const sh = _sheet(TABS.AUDIT, ['Timestamp', 'User', 'Action']); // unchanged for a brand-new tab
  _ensureHeaders(sh, AUDIT_HEADERS); // migrates an existing (old-shape) tab in place
  return sh;
}

// POST type=audit_log — same call site admin.html already used, just a
// richer payload now. Every field is optional/best-effort: a client still
// running the old 3-field logAudit() keeps working unchanged.
function handleAuditLog(payload) {
  const sh = _auditSheet();
  _writeRow(sh, null, {
    Timestamp: payload.timestamp || new Date().toISOString(),
    User: payload.user || '',
    Role: payload.role || '',
    Device: payload.device || '',
    Action: payload.action || '',
    Module: payload.module || '',
    RecordId: payload.recordId || '',
    Summary: payload.summary || payload.action || '',
    PrevValue: payload.prevValue !== undefined && payload.prevValue !== null ? JSON.stringify(payload.prevValue) : '',
    NewValue: payload.newValue !== undefined && payload.newValue !== null ? JSON.stringify(payload.newValue) : ''
  });
  return _ok({ message: 'Logged.' });
}

// GET action=syncEvents&sinceRow=N — returns every Activity Log row after
// sheet row N (1-indexed, header is row 1), plus maxRow so the caller
// knows what cursor to save for next time. Deliberately a plain ranged
// read (no full-sheet scan, no sort) so it stays cheap even polled every
// 2-3 seconds. sinceRow=0 (a device's first-ever poll) intentionally does
// NOT dump full history — it just bookmarks the current end of the log,
// exactly like "start watching from now", so a fresh device isn't hit
// with a wall of old notifications.
function handleSyncEvents(e) {
  const sh = _auditSheet();
  const lastRow = sh.getLastRow();
  const sinceRowRaw = parseInt(e.parameter.sinceRow, 10);
  const sinceRow = isNaN(sinceRowRaw) || sinceRowRaw <= 0 ? lastRow : sinceRowRaw;

  if (lastRow < 2 || sinceRow >= lastRow) {
    return _ok({ events: [], maxRow: Math.max(lastRow, 1), serverTime: new Date().toISOString() });
  }
  const startRow = Math.max(sinceRow + 1, 2);
  const numRows = lastRow - startRow + 1;
  const cappedRows = Math.min(numRows, 300); // safety cap per poll — a client this far behind will catch up over a few polls
  const headers = _headers(sh);
  const values = sh.getRange(startRow, 1, cappedRows, headers.length).getValues();
  const events = values.map(function (row, i) {
    const obj = {};
    headers.forEach(function (h, c) { obj[h] = row[c]; });
    return {
      row: startRow + i,
      timestamp: obj.Timestamp, user: obj.User, role: obj.Role, device: obj.Device,
      action: obj.Action, module: obj.Module, recordId: obj.RecordId, summary: obj.Summary,
      prevValue: _safeParseJSON(obj.PrevValue, null), newValue: _safeParseJSON(obj.NewValue, null)
    };
  });
  return _ok({ events: events, maxRow: startRow + values.length - 1, serverTime: new Date().toISOString() });
}

// ============================================================================
// PHASE 1 — ENTERPRISE BACKUP AUTOMATION, VERIFICATION & DISASTER RECOVERY
// ============================================================================
// Everything in this section is purely additive: new tab (BackupLog), new
// Drive folder, new trigger, new doGet/doPost actions. Nothing here changes
// any existing handler's behavior, endpoint, or return shape, and nothing
// ever deletes a live data row. A backup is a full server-side COPY of this
// spreadsheet (every tab, exactly as it stands), so it survives even if no
// browser or admin device is ever open — the one piece the existing
// localStorage-based backup layer in admin.html cannot do by itself.
// ----------------------------------------------------------------------------

const BACKUP_LOG_HEADERS = ['BackupId','Timestamp','DateLabel','FileId','FileUrl','TriggeredBy','Status','RecordCounts','Notes'];
function _backupLogSheet() { return _sheet(TABS.BACKUP_LOG, BACKUP_LOG_HEADERS); }

function _tz() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }

// Gets (or creates, once) the single Drive folder every backup copy lives in.
function _backupFolder() {
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(BACKUP_FOLDER_NAME);
}

function _genBackupId() { return 'BKS' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6).toUpperCase(); }

// Sheets that are bookkeeping/system tabs rather than operational data, so
// their row counts are never used to judge whether a backup is intact (see
// the long comment inside runBackupNow's verification loop for why
// BackupLog specifically always differs — ImportLog is the same story:
// Phase 2's Import Wizard appends to it independently of any backup run).
// Matched by normalized name (spaces/underscores/hyphens stripped,
// case-insensitive) so 'Backup Log', 'backup_log', etc. all match too —
// and so does any future 'Logs' or 'Metadata'/'Internal Config' tab
// without needing another code change.
const BACKUP_VERIFY_SKIP_PATTERN = /^(backuplog|importlog|logs?|metadata|internalconfig|systemconfig)$/i;

function _isSystemSheetForVerification(tabName) {
  const normalized = String(tabName || '').replace(/[\s_-]/g, '');
  return BACKUP_VERIFY_SKIP_PATTERN.test(normalized);
}

// Core backup routine, shared by the daily trigger and the "Backup Now"
// button. triggeredBy: 'scheduled_trigger' | 'manual_admin'.
//
// Naming matches the spec's example exactly for the automatic daily one
// ("Backup-2026-07-28"); manual/on-demand runs get a time suffix so they
// never collide with the day's automatic backup or with each other, and a
// second scheduled run on the same day (e.g. the trigger firing twice due
// to a Google infra hiccup) is detected and skipped rather than creating a
// duplicate — this is what "keep backup history, never overwrite previous
// backups, never create duplicates" means for the DAILY backup specifically
// (the trigger-duplication guard itself lives in installDailyBackupTrigger).
function runBackupNow(triggeredBy) {
  const now = new Date();
  const dateLabel = Utilities.formatDate(now, _tz(), 'yyyy-MM-dd');
  const logSh = _backupLogSheet();

  if (triggeredBy === 'scheduled_trigger') {
    const existing = _rowsAsObjects(logSh).find(function (r) {
      return r.DateLabel === dateLabel && r.TriggeredBy === 'scheduled_trigger' && r.Status !== 'Deleted';
    });
    if (existing) {
      return { id: existing.BackupId, name: 'Backup-' + dateLabel, fileId: existing.FileId, url: existing.FileUrl,
        status: existing.Status, recordCounts: _safeParseJSON(existing.RecordCounts, {}), skipped: true,
        notes: 'A daily backup for ' + dateLabel + ' already exists — skipped to avoid a duplicate.' };
    }
  }

  const name = triggeredBy === 'scheduled_trigger'
    ? ('Backup-' + dateLabel)
    : ('Backup-' + dateLabel + '-' + Utilities.formatDate(now, _tz(), 'HHmm'));

  const liveSs = _ss();
  const backupId = _genBackupId();
  let file, backupSs, status = 'Verified', notes = '';
  const recordCounts = {};

  try {
    backupSs = liveSs.copy(name);
    file = DriveApp.getFileById(backupSs.getId());
    const folder = _backupFolder();
    folder.addFile(file);
    // Removing from the account's default "My Drive" root keeps Drive tidy —
    // the file itself, and every tab in it, is completely unaffected.
    try { DriveApp.getRootFolder().removeFile(file); } catch (moveErr) {}

    // Verification: for EVERY tab that exists in the spreadsheet at backup
    // time (not a fixed list) — so a sheet added later (a new monthly
    // "Slot Bookings - ..." tab, a new coaching sport tab, etc.) is
    // automatically verified too, with no code change required here. The
    // fresh copy's row count and JSON-serializability must match the live
    // sheet's, taken at the same moment the copy was made — any mismatch
    // marks this backup Corrupted rather than silently trusting the copy.
    //
    // EXCEPTION — system/bookkeeping sheets (BackupLog itself, and any
    // future Logs/Metadata/internal-config tab): these are expected to
    // differ between the live sheet and the backup copy BY DESIGN. Every
    // single backup run appends its own new row to BackupLog right after
    // this verification runs, so at verification time the live sheet
    // already reflects earlier runs the copy predates — a live/backup
    // mismatch there is business as usual, not corruption, and must never
    // by itself flag an otherwise-good backup. Only operational data
    // (Bookings, BlockedSlots, Students, Attendance, coaching/fees,
    // BookingRequests, café sales, etc.) decides Verified vs Corrupted.
    liveSs.getSheets().forEach(function (liveSh) {
      const tabName = liveSh.getName();
      const backupSh = backupSs.getSheetByName(tabName);
      const liveCount = Math.max(0, liveSh.getLastRow() - 1);
      const backupCount = backupSh ? Math.max(0, backupSh.getLastRow() - 1) : 0;
      recordCounts[tabName] = backupCount;

      if (_isSystemSheetForVerification(tabName)) return;

      if (!backupSh) {
        status = 'Corrupted';
        notes += tabName + ': missing from backup copy entirely. ';
        return;
      }
      if (liveCount !== backupCount) {
        status = 'Corrupted';
        notes += tabName + ': expected ' + liveCount + ' rows, backup has ' + backupCount + '. ';
      }
      try { JSON.stringify(_rowsAsObjects(backupSh)); } catch (jsonErr) {
        status = 'Corrupted';
        notes += tabName + ': JSON integrity check failed. ';
      }
    });
  } catch (err) {
    status = 'Corrupted';
    notes = 'Backup creation failed: ' + err.message;
    Logger.log('runBackupNow(' + triggeredBy + ') failed: ' + err.message + '\n' + (err.stack || ''));
  }

  const fileUrl = file ? file.getUrl() : '';
  const fileId = backupSs ? backupSs.getId() : '';
  _writeRow(logSh, null, {
    BackupId: backupId, Timestamp: now.toISOString(), DateLabel: dateLabel, FileId: fileId, FileUrl: fileUrl,
    TriggeredBy: triggeredBy, Status: status, RecordCounts: JSON.stringify(recordCounts), Notes: notes
  });
  if (status === 'Corrupted') Logger.log('Backup ' + backupId + ' (' + name + ') flagged Corrupted: ' + notes);

  return { id: backupId, name: name, fileId: fileId, url: fileUrl, status: status, recordCounts: recordCounts, notes: notes };
}

function _safeParseJSON(str, fallback) { try { return JSON.parse(str); } catch (e) { return fallback; } }

// ----------------------------------------------------------------------------
// TRIGGER STATE — tracked WITHOUT calling ScriptApp.getProjectTriggers()
// from a web app request.
//
// ROOT CAUSE: ScriptApp.getProjectTriggers() (and, on some deployments,
// ScriptApp.newTrigger(...).create() / ScriptApp.deleteTrigger()) needs the
// script.scriptapp OAuth scope. That scope is only ever granted through an
// interactive authorization prompt — something Google can show you inside
// the Apps Script editor, but can never show to a request hitting the
// deployed /exec URL. Calling it from inside doGet/doPost is therefore
// exactly what produced "You do not have permission to call
// ScriptApp.getProjectTriggers".
//
// FIX: the web app never depends on live-querying triggers. "Is the daily
// trigger installed" is tracked as a plain Script Property flag instead,
// set the moment a trigger is actually created and cleared when removed.
// Reading/writing a Script Property needs no special authorization and
// behaves identically from doGet, doPost, the daily trigger itself, or the
// editor — which is what makes it reliable in a deployed web app.
const TRIGGER_FLAG_KEY = 'DAILY_BACKUP_TRIGGER_INSTALLED';
const TRIGGER_FLAG_AT_KEY = 'DAILY_BACKUP_TRIGGER_INSTALLED_AT';

function _triggerFlagGet() {
  return PropertiesService.getScriptProperties().getProperty(TRIGGER_FLAG_KEY) === 'true';
}
function _triggerFlagSet(installed) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(TRIGGER_FLAG_KEY, installed ? 'true' : 'false');
  if (installed) props.setProperty(TRIGGER_FLAG_AT_KEY, new Date().toISOString());
}

// Shared detector for an authorization/permission-flavored Apps Script
// error message — used to decide when it's safe to show a friendly
// "one-time setup" message instead of treating something as a real failure.
function _isPermissionError(err) {
  const msg = (err && err.message) || String(err);
  return /permission/i.test(msg) || /authoriz/i.test(msg);
}

// Turns a raw Apps Script authorization error into a message the Admin
// panel can show directly — the panel must NEVER surface the underlying
// "You do not have permission to call ScriptApp...." text.
function _friendlyTriggerError(err) {
  const msg = (err && err.message) || String(err);
  Logger.log('Trigger action needs manual setup: ' + msg);
  return 'Daily trigger setup needs one manual step: open Extensions \u2192 Apps Script, ' +
    'pick "setupDailyBackupTrigger" from the function dropdown next to Run, click Run, ' +
    'and approve the permission prompt. Then click "Refresh Status" here.';
}

// Same idea as _friendlyTriggerError, but for Drive access needed by
// Delete Backup (DriveApp.getFileById(...).setTrashed(true)). Kept as a
// separate message because the fix is a different one-time function.
function _friendlyDriveError(err) {
  const msg = (err && err.message) || String(err);
  Logger.log('Drive action needs manual authorization: ' + msg);
  return 'Drive access needs one manual step: open Extensions \u2192 Apps Script, pick ' +
    '"authorizeBackupDriveAccess" from the function dropdown next to Run, click Run, and ' +
    'approve the permission prompt (re-deploying via Deploy \u2192 Manage deployments \u2192 Edit \u2192 ' +
    'New version and accepting the permissions review works too). Then try Delete Backup again ' +
    '— nothing was deleted or lost.';
}

// General-purpose sanitizer for any backup action's outer catch (doPost).
// Recognizes an authorization/permission-flavored error and reuses the
// friendly trigger-setup message; anything else still gets logged in full
// server-side, but the Admin panel only ever sees a short, non-technical
// summary — never a raw Apps Script stack or permission string.
function _friendlyBackupError(err, type) {
  const msg = (err && err.message) || String(err);
  if (_isPermissionError(err) && /getProjectTriggers|newTrigger|deleteTrigger/i.test(msg)) {
    return _friendlyTriggerError(err);
  }
  if (_isPermissionError(err) && /drive|getFileById/i.test(msg)) {
    return _friendlyDriveError(err);
  }
  Logger.log('Backup action "' + type + '" failed: ' + msg + '\n' + ((err && err.stack) || ''));
  return 'Backup action failed. Check the Apps Script execution log (View \u2192 Executions) for details.';
}

// Shared by both resetCoachingModuleData() (manual, editor-run) and
// handleAdminResetCoaching() (the admin.html "Reset Coaching Module"
// button, below) — one single place that decides exactly which tabs get
// cleared, so the two entry points can never drift apart.
//
// Clears every DATA ROW (row 2 downward — the header row in row 1 is
// left untouched) from exactly the five Coaching-module tabs: Students,
// Attendance, Fees, DueAdjustments, CoachSettlements. Uses clearContent()
// rather than deleting rows, so tab structure/formatting is undisturbed.
//
// Deliberately does NOT touch: Bookings, BlockedSlots, BookingRequests,
// CafeSales, Enquiries, Coaches (the coach roster — only generated
// CoachSettlements documents are cleared, coach profiles stay intact),
// Users, SiteConfig, FinanceSummary, AuditLog, ImportLog, BackupLog, or
// EnrolmentRequests.
function _clearCoachingTabs() {
  const tabsToClear = [TABS.STUDENTS, TABS.ATTENDANCE, TABS.FEES, TABS.DUE_ADJUSTMENTS, TABS.COACH_SETTLEMENTS];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cleared = [];
  tabsToClear.forEach(function (tabName) {
    const sh = ss.getSheetByName(tabName);
    if (!sh) return; // tab doesn't exist yet — nothing to clear
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow > 1) {
      sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    }
    cleared.push(tabName);
  });
  return cleared;
}

// Manual fallback — run this from the Apps Script editor (Extensions ->
// Apps Script, pick "resetCoachingModuleData" from the function dropdown,
// Run) if you ever need to clear the Sheet side without going through
// admin.html. The normal path is now the "Reset Coaching Module" button
// in Settings (Super Admin), which calls handleAdminResetCoaching below
// over the deployed Web App URL instead.
function resetCoachingModuleData() {
  const cleared = _clearCoachingTabs();
  Logger.log('resetCoachingModuleData: cleared data rows from ' + cleared.join(', ') + '. Headers preserved. Bookings/Cafe/Finance/Coaches/Users untouched.');
  return { cleared: cleared };
}

// POST type='admin_reset_coaching' — the "Reset Coaching Module" button's
// actual server-side action. Reachable over the deployed Web App URL (so
// no manual Apps Script editor step is required), but gated by TWO
// independent checks stacked on top of each other, same "defense in
// depth" reasoning as handleStudentWrite's permanent_delete branch:
//   1. The shared-secret check every doPost request already goes through
//      (see the top of doPost) — stops anyone who doesn't know the token.
//   2. _requesterIsSuperAdmin(payload.requestedByEmail) — a genuine,
//      live lookup against the Users sheet, exactly like permanent_delete
//      uses. Even if admin.html's own client-side role gate were somehow
//      bypassed, this is the real enforcement: only a Users-sheet row
//      that is BOTH Active AND Role=superadmin right now can execute this.
// This is arguably the single most destructive action in the whole app
// (wipes five entire tabs' worth of data, not one row), so it gets both
// checks, not just one.
function handleAdminResetCoaching(payload) {
  if (!_requesterIsSuperAdmin(payload.requestedByEmail)) {
    return _fail('Only an active Super Admin can reset the Coaching module.');
  }
  const cleared = _clearCoachingTabs();
  Logger.log('handleAdminResetCoaching: cleared ' + cleared.join(', ') + ' — requested by ' + payload.requestedByEmail);
  return _ok({ message: 'Coaching module tabs cleared.', cleared: cleared });
}

// ONE-TIME AUTHORIZATION — run this manually from the Apps Script editor if
// Delete Backup ever reports a Drive permission message: open Extensions
// \u2192 Apps Script, select "authorizeBackupDriveAccess" from the function
// dropdown next to Run, click Run, and approve the permission prompt. Only
// reads (never modifies) anything, so it's harmless to re-run any time
// you're unsure whether Drive access is authorized.
function authorizeBackupDriveAccess() {
  const folder = _backupFolder();
  Logger.log('authorizeBackupDriveAccess: Drive access confirmed. Folder: ' + folder.getName());
  return { authorized: true, folder: folder.getName() };
}

// ONE-TIME SETUP — run this manually from the Apps Script editor, NOT from
// the web app: open Extensions \u2192 Apps Script, select
// "setupDailyBackupTrigger" from the function dropdown next to the Run
// button, click Run, and approve the authorization prompt that appears.
// This only needs to be done once per script project (a fresh deployment
// or a new spreadsheet copy). It's idempotent and safe to re-run any time
// you're unsure whether the trigger exists — it will not create a
// duplicate. This is the ONLY place ScriptApp.getProjectTriggers() is
// called, precisely because only a manual editor run can satisfy the
// authorization prompt that method needs.
function setupDailyBackupTrigger() {
  const already = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'dailyBackupJob'; });
  if (!already) {
    ScriptApp.newTrigger('dailyBackupJob').timeBased().atHour(23).nearMinute(55).everyDays(1).create();
    Logger.log('setupDailyBackupTrigger: created new daily trigger (23:55, ' + _tz() + ').');
  } else {
    Logger.log('setupDailyBackupTrigger: trigger already exists — no action taken.');
  }
  _triggerFlagSet(true);
  return { installed: true, alreadyExisted: already };
}

// Web-app entry point for the Admin panel's "Install Daily Trigger" button.
// Never calls ScriptApp.getProjectTriggers() — trusts the Script Property
// flag for the "already installed" check, since a web app request can't
// reliably read live trigger state. Creating the trigger is still
// attempted here too (on deployments where the scope already happens to be
// authorized this just works, no manual step needed), but ANY failure —
// permission-related or not — is caught and turned into a friendly
// instruction to run the one-time setup, never a raw Apps Script error.
function installDailyBackupTrigger() {
  if (_triggerFlagGet()) {
    Logger.log('installDailyBackupTrigger: flag already set — no action taken.');
    return { installed: true, alreadyExisted: true };
  }
  try {
    ScriptApp.newTrigger('dailyBackupJob').timeBased().atHour(23).nearMinute(55).everyDays(1).create();
    _triggerFlagSet(true);
    Logger.log('installDailyBackupTrigger: created new daily trigger (23:55, ' + _tz() + ') from a web app request.');
    return { installed: true, alreadyExisted: false };
  } catch (err) {
    return { installed: false, alreadyExisted: false, needsManualSetup: true, message: _friendlyTriggerError(err) };
  }
}

// Removes any dailyBackupJob trigger(s) — a troubleshooting/reset escape
// hatch, not exposed as a prominent button; existing backups are
// untouched. Wrapped the same way as install: a permission failure here is
// caught and reported as a friendly message rather than crashing the
// request or leaking a raw Apps Script error.
function removeDailyBackupTrigger() {
  try {
    const triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'dailyBackupJob'; });
    triggers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
    _triggerFlagSet(false);
    Logger.log('removeDailyBackupTrigger: removed ' + triggers.length + ' trigger(s).');
    return { removed: triggers.length };
  } catch (err) {
    return { removed: 0, needsManualSetup: true, message: _friendlyTriggerError(err) };
  }
}

// The actual function Google's clock calls every day — deliberately just a
// thin wrapper so the same tested logic runs whether it's the trigger or
// the "Backup Now" button that fires it.
function dailyBackupJob() { runBackupNow('scheduled_trigger'); }

// Trigger-install status now comes from the Script Property flag (see
// above), never from ScriptApp.getProjectTriggers() — that is what makes
// this reliable when called from a deployed web app request.
function getBackupStatus() {
  const installed = _triggerFlagGet();
  const rows = _rowsAsObjects(_backupLogSheet())
    .sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });
  const backups = rows.slice(0, 30).map(function (r) {
    return {
      id: r.BackupId, timestamp: r.Timestamp, dateLabel: r.DateLabel, fileId: r.FileId, fileUrl: r.FileUrl,
      triggeredBy: r.TriggeredBy, status: r.Status, recordCounts: _safeParseJSON(r.RecordCounts, {}), notes: r.Notes || ''
    };
  });
  const lastVerified = backups.find(function (b) { return b.status === 'Verified'; }) || null;
  return {
    installed: installed,
    scheduleLabel: 'Daily at 11:55 PM (' + _tz() + ')',
    totalBackups: rows.length,
    lastVerified: lastVerified,
    backups: backups
  };
}

// GET action=backupStatus
function handleBackupStatus(e) { return _ok(getBackupStatus()); }

// GET action=backupData&fileId=... — reads Bookings + BlockedSlots out of
// ONE specific backup copy (never an arbitrary spreadsheet — fileId must
// match a row already in BackupLog), in the exact shape admin.html's
// restore engine already knows how to preview and merge/replace with.
// Students/Attendance/Enquiries/etc. are still inside that same backup
// file — open it directly (fileUrl from backupStatus) to recover those.
function handleBackupData(e) {
  const fileId = e.parameter.fileId;
  if (!fileId) return _fail('fileId parameter is required.');
  const known = _rowsAsObjects(_backupLogSheet()).some(function (r) { return r.FileId === fileId; });
  if (!known) return _fail('Unknown backup file — it must be one listed in backupStatus.');
  let backupSs;
  try { backupSs = SpreadsheetApp.openById(fileId); } catch (err) { return _fail('Could not open that backup file: ' + err.message); }
  return _ok(_readBookingsAndBlocks(backupSs));
}

// GET action=importHistory — the Import Wizard's permanent, cross-user
// history (Phase 2 final polish). One row per completed import batch.
// Returns most-recent-first, capped at 500 rows so the payload stays
// small even after years of use — older rows are still in the sheet
// itself if ever needed, just not sent down by default.
function handleImportHistoryGet(e) {
  const sh = _sheet(TABS.IMPORT_LOG, ['ImportId','Timestamp','User','Module','FileName','Mode','Imported','Updated','Skipped','Errors','Duplicates','Device','RolledBack']);
  const rows = _rowsAsObjects(sh)
    .sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); })
    .slice(0, 500)
    .map(function (r) { return {
      importId: r.ImportId, timestamp: r.Timestamp, user: r.User, module: r.Module, fileName: r.FileName,
      mode: r.Mode, imported: r.Imported, updated: r.Updated, skipped: r.Skipped, errors: r.Errors,
      duplicates: r.Duplicates, device: r.Device, rolledBack: r.RolledBack === true || r.RolledBack === 'true'
    }; });
  return _ok({ history: rows, latestImportId: rows.length ? rows[0].importId : null });
}

// POST type=import_mark_rolled_back — flips RolledBack to true for one
// import batch after Undo completes client-side. Uses the same
// find-row-then-merge pattern as handleDeleteBackup, so a re-run or a
// not-found row never throws — it just reports what actually happened.
function handleImportMarkRolledBack(payload) {
  const importId = payload.importId;
  if (!importId) return _fail('importId is required.');
  const sh = _sheet(TABS.IMPORT_LOG, ['ImportId','Timestamp','User','Module','FileName','Mode','Imported','Updated','Skipped','Errors','Duplicates','Device','RolledBack']);
  const rowNum = _findRow(sh, 'ImportId', importId);
  if (rowNum === -1) return _fail('Unknown import batch.');
  _writeRow(sh, rowNum, { RolledBack: true });
  return _ok({ message: 'Marked rolled back.' });
}

// POST type=backup_now — the "Backup Now" button; always triggeredBy manual_admin.
function handleBackupNow(payload) {
  const result = runBackupNow('manual_admin');
  return _ok({ backup: result });
}

// POST type=install_backup_trigger
function handleInstallBackupTrigger(payload) { return _ok(installDailyBackupTrigger()); }

// POST type=remove_backup_trigger — troubleshooting/reset only.
function handleRemoveBackupTrigger(payload) { return _ok(removeDailyBackupTrigger()); }

// POST type=delete_backup — refuses to delete the most recent Verified
// backup ("never delete the last verified backup"), so there's always at
// least one good recovery point even if an admin cleans house.
function handleDeleteBackup(payload) {
  const fileId = payload.fileId;
  if (!fileId) return _fail('fileId is required.');
  const status = getBackupStatus();
  if (status.lastVerified && status.lastVerified.fileId === fileId) {
    return _fail('This is the most recent verified backup and cannot be deleted — make another backup first.');
  }
  const sh = _backupLogSheet();
  const rowNum = _findRow(sh, 'FileId', fileId);
  if (rowNum === -1) return _fail('Unknown backup.');

  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (err) {
    if (_isPermissionError(err)) {
      // Drive access isn't authorized for this execution context yet. The
      // file is almost certainly still sitting in Drive untouched, so the
      // log row must NOT be marked Deleted — that would make a perfectly
      // good backup look gone when it isn't. This also isn't a failure to
      // report as one; it's a one-time setup step.
      return _ok({ message: _friendlyDriveError(err), needsManualSetup: true, deleted: false });
    }
    // Not a permission issue — most likely the file is already gone (moved,
    // trashed by hand, etc). Safe to still mark this log row Deleted below.
  }
  _writeRow(sh, rowNum, { Status: 'Deleted' });
  return _ok({ message: 'Backup deleted.' });
}
