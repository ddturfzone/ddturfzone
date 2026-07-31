/**
 * DD Turf Zone – Firebase Realtime Database Service
 * Phase 4: Firebase Realtime Architecture
 * 
 * Single Firebase initialization point.
 * Exports: firebaseApp, realtimeDb, connectionStatus
 * 
 * No hardcoding in HTML files — credentials managed here only.
 */

// ========== FIREBASE CONFIGURATION ==========
// Single source of truth for all Firebase credentials.
// Update only this object to switch projects.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCnJzKvBOEW49MoIXi42uzPUdD1Rdc_vic",
  authDomain: "dd-turf-zone-6c11d.firebaseapp.com",
  databaseURL: "https://dd-turf-zone-6c11d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "dd-turf-zone-6c11d",
  storageBucket: "dd-turf-zone-6c11d.firebasestorage.app",
  messagingSenderId: "897362883706",
  appId: "1:897362883706:web:3e5b342a8097a8e15ab7c3"
};

// ========== FIREBASE INITIALIZATION ==========
let firebaseApp = null;
let realtimeDb = null;
let connectionStatus = 'unknown'; // 'connected' | 'disconnected' | 'unknown'

// EMERGENCY STABILITY FIX additions:
// - firebaseFullyReady: true only once init (app + database + the
//   anonymous-auth ATTEMPT, success or caught failure) has fully
//   settled. This is the ROOT CAUSE FIX for "Could not start approval:
//   Firebase not initialized" — call sites in admin.html were checking
//   `typeof window.claimEnrolmentForApproval === 'function'`, which is
//   true almost immediately once this file finishes loading/parsing
//   (long before initializeFirebase() has actually run to completion),
//   not whether Firebase is genuinely ready. A user clicking Approve
//   within roughly the first second after login could hit this exact
//   race: the function existed, but realtimeDb inside it was still
//   null. firebaseFullyReady is the correct thing to check instead.
// - lastFirebaseError / authState: so a real failure (wrong config,
//   Anonymous provider not enabled, network error) can be SHOWN to the
//   user instead of a generic "Connecting..." forever, per requirement
//   #15 of the emergency fix.
let firebaseFullyReady = false;
let lastFirebaseError = null;
let authState = 'pending'; // 'pending' | 'success' | 'failed' | 'skipped'

/**
 * Initialize Firebase and Realtime Database.
 * Called once at application startup.
 *
 * PHASE 4.1 addition: if the Firebase Auth SDK has been loaded on this
 * page (admin.html loads it; enroll.html deliberately does NOT), signs
 * in anonymously. This is NOT a user-facing feature — there is no login
 * step, no UI, nothing visible changes. It exists solely so the Firebase
 * Security Rules have something real to check: without ANY Firebase
 * Authentication at all, "auth != null" in a rule is never true for
 * anyone (admin.html's login is entirely Google-Sheets-based via
 * loginViaSheet() and has nothing to do with Firebase), which would make
 * the security rule silently block every admin write to an existing
 * record (claim/approve/reject) once actually enforced. Signing in
 * anonymously ONLY on admin.html (never on enroll.html) gives the rule a
 * real way to distinguish "loaded the admin panel" from "the public
 * enrolment form" — see PHASE_4_1_FINAL_VERIFICATION.md for the full
 * rationale and the exact rule this pairs with.
 */
window.initializeFirebase = async () => {
  console.log('[FB-DEBUG] Firebase initialization started'); // TEMP DEBUG LOG — remove after live verification
  try {
    if (firebaseApp) {
      console.warn('Firebase already initialized');
      return { success: true, app: firebaseApp, db: realtimeDb };
    }

    // Initialize Firebase App
    firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    console.log('✓ Firebase App initialized:', firebaseApp.name);

    // Get Realtime Database reference
    realtimeDb = firebase.database(firebaseApp);
    console.log('✓ Firebase Realtime Database initialized');
    console.log('[FB-DEBUG] Database connected'); // TEMP DEBUG LOG — remove after live verification

    // Setup connection state monitoring
    _setupConnectionMonitoring();

    // Anonymous sign-in — only runs if this page loaded firebase-auth.js
    // (admin.html does; enroll.html does not), so this is a no-op on the
    // public form. Never blocks the rest of initialization if it fails
    // (e.g. Anonymous provider not yet enabled in the Firebase Console) —
    // logs a clear warning AND records the real error (lastFirebaseError)
    // instead of a generic message, matching this file's existing
    // fail-soft pattern everywhere else.
    if (typeof firebase.auth === 'function') {
      console.log('[FB-DEBUG] Anonymous sign-in started'); // TEMP DEBUG LOG — remove after live verification
      try {
        await firebase.auth().signInAnonymously();
        authState = 'success';
        console.log('✓ Firebase anonymous auth established (admin-side only)');
        console.log('[FB-DEBUG] Anonymous sign-in successful'); // TEMP DEBUG LOG — remove after live verification
      } catch (authError) {
        authState = 'failed';
        lastFirebaseError = 'Authentication error: ' + authError.message;
        console.warn('⚠ Firebase anonymous auth failed — admin writes to existing records may be rejected by the security rule until this is resolved:', authError.message);
        _updateConnectionIndicator(); // surface the real error immediately, don't wait for the connection listener
      }
    } else {
      authState = 'skipped'; // this page never loaded firebase-auth.js (enroll.html) — expected, not an error
    }

    // Only NOW — after the database exists AND the auth attempt has
    // fully settled (success or caught failure) — is Firebase genuinely
    // ready for a write/listener to depend on it.
    firebaseFullyReady = true;
    console.log(`[FB-DEBUG] Firebase initialized — fullyReady=true, authState=${authState}`); // TEMP DEBUG LOG — remove after live verification

    return {
      success: true,
      app: firebaseApp,
      db: realtimeDb,
      message: 'Firebase initialized successfully'
    };
  } catch (error) {
    console.error('✗ Firebase initialization failed:', error);
    connectionStatus = 'disconnected';
    lastFirebaseError = 'Initialization error: ' + error.message;
    _updateConnectionIndicator();
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Monitor Firebase connection state.
 * Updates UI indicator when connection changes.
 */
function _setupConnectionMonitoring() {
  if (!realtimeDb) {
    console.warn('Realtime Database not available for connection monitoring');
    return;
  }

  // Firebase .info/connected path indicates connection state
  const connectedRef = firebase.database(firebaseApp).ref('.info/connected');

  // EMERGENCY STABILITY FIX: the previous version additionally called
  // `realtimeDb.ref().on('error', ...)` — 'error' is NOT a valid Firebase
  // .on() event type (valid types are value/child_added/child_changed/
  // child_removed/child_moved). Firebase's real error-handling mechanism
  // is the SECOND callback argument to .on('value', successFn, errorFn) —
  // that invalid call has been removed and replaced with a proper cancel
  // callback below, which is what actually fires on a permission-denied
  // or other subscription failure.
  connectedRef.on('value', (snapshot) => {
    if (snapshot.val() === true) {
      const wasDisconnected = connectionStatus === 'disconnected';
      connectionStatus = 'connected';
      lastFirebaseError = null;
      if (window._ddtzDiag) window._ddtzDiag.hasEverConnected = true; // TEMP SYSTEM HEALTH
      console.log('🟢 Firebase connected');
      // Distinguishing first-connect from reconnect matters for live
      // testing: during a Wi-Fi-off/on test the tester needs to actually
      // SEE that the socket came back, not just infer it.
      console.log(wasDisconnected
        ? '[FB-DEBUG] Connection restored (reconnected after a drop)'
        : '[FB-DEBUG] Connection established'); // TEMP DEBUG LOG — remove after live verification
      if (wasDisconnected) {
        // `.info/connected` flipping back to true is the AUTHORITATIVE
        // signal that Firebase itself reconnected — strictly more
        // reliable than the browser's 'online' event, which fires when
        // the OS thinks there's a network, often before Firebase's own
        // socket has actually re-established. Running the watchdog here
        // too means a listener that failed to start is recovered at the
        // first moment it genuinely can be. The watchdog is internally
        // guarded, so this never double-subscribes.
        window._firebaseReconnectWatchdog?.('firebase-reconnect');
      }
    } else {
      connectionStatus = 'disconnected';
      console.log('🔴 Firebase disconnected');
      console.log('[FB-DEBUG] Firebase disconnected'); // TEMP DEBUG LOG — remove after live verification
    }
    _updateConnectionIndicator();
  }, (error) => {
    // This is the correct place a permission-denied or similar
    // subscription failure actually surfaces — the previous code had no
    // equivalent for ANY listener in this file, so a failure here (or in
    // the enrolment/finance listeners below) would silently do nothing,
    // which is exactly what requirement #15 asked to stop happening.
    connectionStatus = 'disconnected';
    lastFirebaseError = 'Realtime Database error: ' + error.message;
    console.error('✗ Firebase connection monitor error:', error);
    _updateConnectionIndicator();
  });
}

/**
 * Update connection indicator in topbar.
 */
function _updateConnectionIndicator() {
  const indicator = document.getElementById('firebase-connection-indicator');
  if (!indicator) return;

  if (connectionStatus === 'connected') {
    indicator.textContent = '🟢 Firebase Connected';
    indicator.style.color = 'var(--green-light, #22c55e)';
  } else if (connectionStatus === 'disconnected') {
    // EMERGENCY STABILITY FIX (requirement #15): show the actual error
    // when one is known, instead of a generic "Offline" that gives no
    // clue what actually went wrong.
    indicator.textContent = lastFirebaseError ? `🔴 Firebase Error: ${lastFirebaseError}` : '🔴 Firebase Offline';
    indicator.style.color = 'var(--red, #ef4444)';
  } else {
    indicator.textContent = '⚪ Firebase Connecting...';
    indicator.style.color = 'var(--gray3, #94a3b8)';
  }
}

/**
 * Get current Firebase connection status.
 */
window.getFirebaseStatus = () => {
  return {
    status: connectionStatus,
    app: firebaseApp,
    db: realtimeDb,
    isConnected: connectionStatus === 'connected',
    // NOTE: isInitialized only ever meant "the app object was created,"
    // which happens synchronously very early — it does NOT mean the
    // anonymous-auth attempt has settled. Kept as-is for backward
    // compatibility with any existing caller; use fullyReady (below) for
    // "is it actually safe to perform a write/subscribe now."
    isInitialized: firebaseApp !== null,
    // EMERGENCY STABILITY FIX additions:
    fullyReady: firebaseFullyReady,
    authState: authState,
    lastError: lastFirebaseError
  };
};

/**
 * Verify Firebase connectivity and database access.
 * Call this after initialization to confirm working connection.
 */
window.verifyFirebaseConnection = async () => {
  return new Promise((resolve) => {
    if (!realtimeDb) {
      resolve({
        success: false,
        message: 'Realtime Database not initialized',
        status: getFirebaseStatus()
      });
      return;
    }

    // Test write + read to verify connectivity
    const testRef = realtimeDb.ref('.ddtz_test');
    const testData = {
      timestamp: new Date().toISOString(),
      test: true
    };

    testRef.set(testData).then(() => {
      console.log('✓ Firebase test write successful');
      
      // Read back to verify
      testRef.once('value', (snapshot) => {
        const data = snapshot.val();
        if (data && data.test === true) {
          console.log('✓ Firebase test read successful');
          
          // Clean up test data
          testRef.remove().then(() => {
            resolve({
              success: true,
              message: 'Firebase connection verified ✓',
              status: getFirebaseStatus()
            });
          });
        } else {
          resolve({
            success: false,
            message: 'Firebase read verification failed',
            status: getFirebaseStatus()
          });
        }
      });
    }).catch((error) => {
      console.error('✗ Firebase test write failed:', error);
      resolve({
        success: false,
        message: 'Firebase connection test failed: ' + error.message,
        status: getFirebaseStatus()
      });
    });
  });
};

/**
 * Export Firebase instances for use in modules.
 * Access via: window.getFirebaseService().db, etc.
 */
window.getFirebaseService = () => {
  return {
    app: firebaseApp,
    db: realtimeDb,
    config: FIREBASE_CONFIG,
    status: connectionStatus,
    isConnected: connectionStatus === 'connected',
    isInitialized: firebaseApp !== null
  };
};

console.log('Firebase Service Module Loaded');

// ========== PHASE 4.1: PENDING ENROLMENTS REALTIME SYNC ==========
//
// Design note: every enrolment request already has a stable, unique,
// Firebase-key-safe identifier — requestId (e.g. "ER1A2B3C4D5E6F"), which
// admin.html's local records also use AS their local `id` (see
// syncEnrolmentsFromSheet's merge: `local.id === remote.requestId`). Keying
// the Firebase node by requestId directly (instead of an auto-generated
// push() key) means there is only ONE identifier across Firebase, local
// storage, and the Google Sheet's RequestId column — no separate mapping
// table needed, and duplicate-approval prevention can key off the exact
// same id the UI already uses.

/**
 * Submit a new enrolment request to Firebase (PUBLIC - from enroll.html).
 * Keyed by requestId so retrying the same submission (e.g. from the
 * offline retry queue) overwrites the same node instead of creating a
 * second, duplicate record.
 */
window.submitPendingEnrolmentFirebase = async (enrolmentData) => {
  return new Promise((resolve) => {
    if (!realtimeDb) {
      resolve({ success: false, error: 'Firebase not initialized' });
      return;
    }
    if (!enrolmentData || !enrolmentData.requestId) {
      resolve({ success: false, error: 'Missing requestId — cannot submit to Firebase.' });
      return;
    }

    const requestId = enrolmentData.requestId;
    const ref = realtimeDb.ref('pending_enrolments/' + requestId);
    const newEnrolment = {
      ...enrolmentData,
      status: 'pending',
      createdAt: enrolmentData.createdAt || firebase.database.ServerValue.TIMESTAMP,
      syncStatus: 'pending',
      syncAttempts: 0
    };

    // set() is idempotent here: a retried submission with the same
    // requestId simply overwrites the same node with the same data,
    // rather than creating a duplicate (unlike the previous push()-based
    // design, where every retry minted a brand-new record).
    ref.set(newEnrolment).then(() => {
      console.log('✓ Enrolment submitted to Firebase:', requestId);
      resolve({
        success: true,
        firebaseKey: requestId,
        message: 'Your enrolment request has been received'
      });
    }).catch((error) => {
      console.error('✗ Failed to submit enrolment:', error);
      resolve({ success: false, error: error.message });
    });
  });
};

/**
 * Real-time listener for pending enrolments (ADMIN ONLY - admin.html).
 * firebaseKey is now always equal to requestId (see design note above).
 */
window.listenPendingEnrolments = (callback) => {
  if (!realtimeDb) {
    console.error('Firebase not initialized');
    return null;
  }

  const ref = realtimeDb.ref('pending_enrolments');
  const handler = (snapshot) => {
    console.log('[FB-DEBUG] Listener received update (pending_enrolments)'); // TEMP DEBUG LOG — remove after live verification
    const enrolments = [];
    snapshot.forEach((child) => {
      enrolments.push({ firebaseKey: child.key, ...child.val() });
    });
    callback(enrolments);
  };
  const errorHandler = (error) => {
    // EMERGENCY STABILITY FIX: previously this subscription had no error
    // callback at all — a permission-denied failure (e.g. from a rule
    // mismatch or a failed anonymous sign-in) would silently never call
    // `handler` again, which looks exactly like "not syncing" with zero
    // visible cause. Now it's surfaced through the same channel the
    // connection indicator already uses.
    console.error('✗ Pending Enrolments listener error:', error);
    window._onFirebaseListenerFailed?.('enrolments'); // LISTENER LIFECYCLE — re-enable the polling fallback
    lastFirebaseError = 'Pending Enrolments sync error: ' + error.message;
    connectionStatus = 'disconnected';
    _updateConnectionIndicator();
  };
  ref.on('value', handler, errorHandler);
  console.log('[FB-DEBUG] Listener attached (pending_enrolments)'); // TEMP DEBUG LOG — remove after live verification

  return () => ref.off('value', handler); // unsubscribe function
};

/**
 * PHASE 1 of approval: atomically claim the request so a second admin
 * device cannot start approving the same one concurrently. Does NOT mark
 * it "approved" yet — approval requires creating a Student record locally
 * first (business logic that lives in admin.html and can fail/take time),
 * so this only reserves the record ('approving') until finalizeEnrolmentApproval
 * or releaseEnrolmentClaim is called.
 *
 * Handles the case where no Firebase node exists yet at all (e.g. a
 * request that predates Phase 4.1 and only ever lived in Google Sheets) —
 * treated as freely claimable, since there is nothing to conflict with.
 */
window.claimEnrolmentForApproval = async (requestId, adminEmail) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    if (!navigator.onLine) {
      resolve({ success: false, error: 'You are offline. Reconnect before approving, to avoid a conflicting approval on another device.', offline: true });
      return;
    }

    const ref = realtimeDb.ref('pending_enrolments/' + requestId);
    ref.transaction((current) => {
      if (current === null) {
        // No Firebase record yet (legacy pre-Phase-4.1 request) — claim it now.
        return {
          requestId, status: 'approving', claimedBy: adminEmail,
          claimedAt: firebase.database.ServerValue.TIMESTAMP,
          syncStatus: 'pending', syncAttempts: 0
        };
      }
      if (current.status !== 'pending') {
        return; // abort — already approving/approved/rejected elsewhere
      }
      return {
        ...current,
        status: 'approving',
        claimedBy: adminEmail,
        claimedAt: firebase.database.ServerValue.TIMESTAMP
      };
    }).then((result) => {
      if (result.committed) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: 'This enrolment has already been processed by another user', conflict: true });
      }
    }).catch((error) => {
      console.error('✗ Claim transaction error:', error);
      resolve({ success: false, error: error.message });
    });
  });
};

/**
 * PHASE 2 of approval: called ONLY after the local Student record was
 * successfully created and the Google Sheets update already succeeded
 * (or was safely queued by the existing queuedSync/offline-queue system).
 * Plain update() is safe here — this device already holds the claim.
 */
window.finalizeEnrolmentApproval = async (requestId, studentId, adminEmail) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    realtimeDb.ref('pending_enrolments/' + requestId).update({
      status: 'approved',
      approvedBy: adminEmail,
      approvedAt: firebase.database.ServerValue.TIMESTAMP,
      studentId: studentId || '',
      claimedBy: null,
      claimedAt: null
    }).then(() => resolve({ success: true }))
      .catch((error) => resolve({ success: false, error: error.message }));
  });
};

/**
 * Releases a claim WITHOUT marking the request approved — used only if
 * the local business logic (student creation / sheet update) fails
 * AFTER a successful claim, so the request doesn't stay stuck in
 * 'approving' forever and can be retried.
 */
window.releaseEnrolmentClaim = async (requestId) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    realtimeDb.ref('pending_enrolments/' + requestId).update({
      status: 'pending',
      claimedBy: null,
      claimedAt: null
    }).then(() => resolve({ success: true }))
      .catch((error) => resolve({ success: false, error: error.message }));
  });
};

/**
 * Reject an enrolment (ADMIN ONLY). Single-phase transaction is safe here
 * — unlike approve, rejecting has no follow-on business logic that can
 * fail in between, so claim-then-finalize isn't needed.
 */
window.rejectEnrolmentFirebase = async (requestId, adminEmail, reason) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    if (!navigator.onLine) {
      resolve({ success: false, error: 'You are offline. Reconnect before rejecting, to avoid a conflicting action on another device.', offline: true });
      return;
    }

    const ref = realtimeDb.ref('pending_enrolments/' + requestId);
    ref.transaction((current) => {
      if (current === null) {
        return {
          requestId, status: 'rejected', rejectedBy: adminEmail,
          rejectedAt: firebase.database.ServerValue.TIMESTAMP, rejectionReason: reason,
          syncStatus: 'pending', syncAttempts: 0
        };
      }
      if (current.status !== 'pending') {
        return; // already processed
      }
      return {
        ...current,
        status: 'rejected',
        rejectedBy: adminEmail,
        rejectedAt: firebase.database.ServerValue.TIMESTAMP,
        rejectionReason: reason
      };
    }).then((result) => {
      if (result.committed) {
        resolve({ success: true, newData: result.snapshot.val() });
      } else {
        resolve({ success: false, error: 'This enrolment has already been processed', conflict: true });
      }
    }).catch((error) => {
      console.error('✗ Reject transaction error:', error);
      resolve({ success: false, error: error.message });
    });
  });
};

// NOTE: three functions previously here (lockEnrolmentFirebase,
// unlockEnrolmentFirebase, updateSyncStatusFirebase) were removed during
// the Production Readiness Review — confirmed dead code, never called
// from anywhere in admin.html, enroll.html, or this file itself. Their
// intended purposes are already covered by other, actually-wired
// mechanisms: claimEnrolmentForApproval/releaseEnrolmentClaim handle
// concurrency locking for real, and sync status is tracked via
// PHASE_4_1_CODE_GS_ADDITIONS.gs writing directly to Firebase's REST API
// from Apps Script (a separate runtime that was never actually able to
// call this file's JS functions in the first place — that comment was
// aspirational, not accurate).

/**
 * Re-assert the connection indicator from Firebase's ACTUAL current
 * state, rather than the cached `connectionStatus` variable.
 *
 * Why this exists: `.info/connected` only fires when the state CHANGES.
 * If the indicator ever gets out of step with reality — it starts life
 * as 'unknown' ("⚪ Firebase Connecting...") and only leaves that state
 * when the first event arrives — there is otherwise no path back to a
 * correct display until the connection genuinely flips. That would leave
 * a permanently wrong "Connecting..." on screen while Firebase is in
 * fact connected and working, which is exactly the reported symptom.
 *
 * This does a single one-off read of `.info/connected` and syncs both
 * the variable and the indicator to it. Read-only, no writes.
 */
window.refreshFirebaseConnectionIndicator = () => {
  if (!realtimeDb) return;
  realtimeDb.ref('.info/connected').once('value').then(snap => {
    const reallyConnected = snap.val() === true;
    const previous = connectionStatus;
    connectionStatus = reallyConnected ? 'connected' : 'disconnected';
    if (previous !== connectionStatus) {
      console.log(`[FB-DEBUG] Indicator re-synced from live state: ${previous} → ${connectionStatus}`); // TEMP DEBUG LOG
    }
    _updateConnectionIndicator();
  }).catch(err => {
    console.warn('[FB-DEBUG] Could not re-read live connection state:', err);
  });
};

// ========== PHASE 4.1: VOICE NOTIFICATIONS ==========

// Voice notification settings
let voiceNotificationEnabled = localStorage.getItem('ddtz_voice_enabled') !== 'false';
let voiceVolume = parseFloat(localStorage.getItem('ddtz_voice_volume')) || 1.0;
let voicePitch = parseFloat(localStorage.getItem('ddtz_voice_pitch')) || 1.0;
let voiceRate = parseFloat(localStorage.getItem('ddtz_voice_rate')) || 1.0;
let lastAnnouncedEvents = {}; // Track last announcement time to prevent duplicates

// ============================================================================
// ROOT CAUSE FIX — Voice notifications never playing for ANY event.
// ----------------------------------------------------------------------------
// Cause #1 (primary): browsers (Chrome, Safari, and every mobile browser)
// block speechSynthesis.speak() until the page has received a genuine
// user activation — a real click/tap/keypress. Every voice call in this
// app is triggered by a BACKGROUND Firebase listener, never by a click,
// so speak() was being silently dropped: no sound, no error, onstart
// never firing. Nothing about the calling code was wrong; the browser
// was refusing before it ever got that far.
//
// The fix is to "prime" the speech engine once, from inside a real user
// gesture (the first click/tap anywhere in the app — in practice the
// login button), by speaking a zero-volume empty utterance. That single
// primed call satisfies the activation requirement for the rest of the
// page's lifetime, so later background-triggered announcements are
// allowed through.
//
// Cause #2: speechSynthesis.cancel() was called immediately before
// speak(). In Chrome these are processed asynchronously against the same
// internal queue, and a cancel() issued in the same tick frequently kills
// the utterance that was just queued behind it — a well-known Chrome
// race. Cancel is now only issued when something is genuinely still
// speaking, and speak() is deferred to the next tick so the queue has
// settled first.
// ============================================================================
let _voiceUnlocked = false;

function _primeSpeechSynthesis() {
  if (_voiceUnlocked || !('speechSynthesis' in window)) return;
  try {
    const primer = new SpeechSynthesisUtterance('');
    primer.volume = 0; // silent — the user never hears this
    window.speechSynthesis.speak(primer);
    _voiceUnlocked = true;
    console.log('[VOICE-DEBUG] Speech synthesis primed by user gesture — background announcements are now permitted');
  } catch (e) {
    console.warn('[VOICE-DEBUG] Speech priming failed:', e);
  }
}

// Prime on the first real user interaction, then stop listening. Uses
// capture + once so it fires for the very first click/tap/key anywhere,
// including the login button, without interfering with any existing
// handler on that element.
['click', 'touchstart', 'keydown'].forEach(evt => {
  window.addEventListener(evt, _primeSpeechSynthesis, { capture: true, once: true, passive: true });
});

/**
 * Play voice announcement (Browser SpeechSynthesis API)
 * Only plays on OTHER devices, not the current device
 * isCurrentDevice = true means don't announce (user just did the action)
 */
window.playVoiceAnnouncement = (message, isCurrentDevice = false) => {
  console.log('[VOICE-DEBUG] Event received:', message);
  if (!voiceNotificationEnabled) {
    console.log('[VOICE-DEBUG] Skipped — voice notifications are turned off in settings');
    return;
  }
  if (isCurrentDevice) {
    console.log('[VOICE-DEBUG] Skipped — this device performed the action');
    return;
  }

  // Prevent duplicate announcements within 3 seconds
  const eventKey = message;
  const lastTime = lastAnnouncedEvents[eventKey] || 0;
  if (Date.now() - lastTime < 3000) {
    console.log('[VOICE-DEBUG] Skipped — duplicate within 3s:', message);
    return;
  }
  // Recorded up-front (not only in onend) so a second identical event
  // arriving while the first is still speaking is still deduplicated —
  // previously this was set only after speech COMPLETED, so overlapping
  // duplicates slipped through.
  lastAnnouncedEvents[eventKey] = Date.now();

  if (!('speechSynthesis' in window)) {
    console.warn('[VOICE-DEBUG] Speech Synthesis not supported by this browser — falling back to notification sound');
    window._rtPlayNotifySound?.();
    return;
  }

  if (!_voiceUnlocked) {
    // Genuinely cannot speak yet — the user hasn't interacted with the
    // page at all this session, so the browser will refuse. Say so
    // explicitly rather than failing silently, and still make a sound.
    console.warn('[VOICE-DEBUG] Speech blocked — no user interaction yet this session, so the browser will not allow speech. Falling back to notification sound. (Any click/tap in the app unlocks it for the rest of the session.)');
    window._rtPlayNotifySound?.();
    return;
  }

  try {
    // Only cancel if something is genuinely still speaking — see Cause #2
    // above. An unconditional cancel() here was killing the utterance
    // queued immediately after it.
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      console.log('[VOICE-DEBUG] Cancelling in-progress speech before new announcement');
      window.speechSynthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = voiceRate;
    utterance.pitch = voicePitch;
    utterance.volume = voiceVolume;

    utterance.onstart = () => {
      console.log('[VOICE-DEBUG] Speech started:', message);
      window._ddtzDiag?.recordNotification('voice'); // TEMP DIAGNOSTICS — recorded here specifically, not at the call site, so it only counts when speech genuinely starts (not when disabled or deduped)
    };

    utterance.onend = () => {
      console.log('[VOICE-DEBUG] Speech completed');
    };

    utterance.onerror = (event) => {
      // Never silently fail — log the exact reason AND still make a
      // sound, so the event is never missed entirely.
      console.error('[VOICE-DEBUG] Speech failed:', event.error, '— falling back to notification sound');
      window._rtPlayNotifySound?.();
    };

    // Deferred one tick so any cancel() above has fully settled before
    // this is queued — see Cause #2.
    setTimeout(() => {
      window.speechSynthesis.speak(utterance);
      console.log('[VOICE-DEBUG] Voice queued:', message);
    }, 0);
  } catch (error) {
    console.error('[VOICE-DEBUG] Error playing voice announcement:', error, '— falling back to notification sound');
    window._rtPlayNotifySound?.();
  }
};

/**
 * Set voice notification settings
 */
window.setVoiceNotificationSettings = (enabled, volume, pitch, rate) => {
  voiceNotificationEnabled = enabled;
  voiceVolume = Math.max(0, Math.min(1, volume || 1));
  voicePitch = Math.max(0.5, Math.min(2, pitch || 1));
  voiceRate = Math.max(0.5, Math.min(2, rate || 1));

  localStorage.setItem('ddtz_voice_enabled', voiceNotificationEnabled);
  localStorage.setItem('ddtz_voice_volume', voiceVolume);
  localStorage.setItem('ddtz_voice_pitch', voicePitch);
  localStorage.setItem('ddtz_voice_rate', voiceRate);

  console.log('✓ Voice settings updated:', { voiceNotificationEnabled, voiceVolume, voicePitch, voiceRate });
};

/**
 * Get current voice settings
 */
window.getVoiceNotificationSettings = () => {
  return {
    enabled: voiceNotificationEnabled,
    volume: voiceVolume,
    pitch: voicePitch,
    rate: voiceRate
  };
};

// ========== PHASE 4.1: OFFLINE QUEUE ==========

/**
 * Queue a failed sync operation for retry when online
 */
window.queueForRetry = (firebaseKey, operation, data) => {
  const queue = JSON.parse(localStorage.getItem('ddtz_retry_queue')) || [];
  queue.push({
    firebaseKey: firebaseKey,
    operation: operation,
    data: data,
    timestamp: Date.now(),
    attempts: 0
  });
  localStorage.setItem('ddtz_retry_queue', JSON.stringify(queue));
  console.log('📋 Queued for retry:', firebaseKey, operation);
};

/**
 * Get retry queue
 */
window.getRetryQueue = () => {
  return JSON.parse(localStorage.getItem('ddtz_retry_queue')) || [];
};

/**
 * Clear retry queue
 */
window.clearRetryQueue = () => {
  localStorage.removeItem('ddtz_retry_queue');
  console.log('✓ Retry queue cleared');
};

/**
 * Drain the retry queue: attempt each queued operation again.
 * Called automatically on 'online' event (below) and can also be called
 * manually. Currently supports operation type 'enrolment_submit' — the
 * only producer of queued items today (see enroll.html catch block).
 */
window.drainRetryQueue = async () => {
  const queue = window.getRetryQueue();
  if (!queue.length) return { processed: 0, remaining: 0 };

  console.log(`📋 Draining retry queue: ${queue.length} item(s)`);
  const stillFailed = [];

  for (const item of queue) {
    try {
      if (item.operation === 'enrolment_submit' && typeof window.submitPendingEnrolmentFirebase === 'function') {
        const result = await window.submitPendingEnrolmentFirebase(item.data);
        if (!result.success) throw new Error(result.error || 'retry failed');
        console.log('✓ Retry succeeded for', item.firebaseKey || item.data?.requestId);
      } else if (item.operation === 'booking_request_submit' && typeof window.submitBookingRequestFirebase === 'function') {
        // STAGE 1 — same retry mechanism, second producer (index.html's
        // reservation form, alongside enroll.html's enrolment form).
        const result = await window.submitBookingRequestFirebase(item.data);
        if (!result.success) throw new Error(result.error || 'retry failed');
        console.log('✓ Retry succeeded for', item.firebaseKey || item.data?.requestId);
      } else {
        // Unknown operation type — keep it queued rather than silently drop it.
        stillFailed.push(item);
      }
    } catch (error) {
      item.attempts = (item.attempts || 0) + 1;
      if (item.attempts < MAX_RETRY_QUEUE_ATTEMPTS) {
        stillFailed.push(item);
      } else {
        console.error('✗ Giving up on queued item after max attempts:', item, error);
      }
    }
  }

  localStorage.setItem('ddtz_retry_queue', JSON.stringify(stillFailed));
  return { processed: queue.length - stillFailed.length, remaining: stillFailed.length };
};

const MAX_RETRY_QUEUE_ATTEMPTS = 5;

// Automatically drain the queue when the browser regains connectivity.
// This is the missing piece that made queueForRetry/getRetryQueue dead
// code in the previous version — nothing ever called them together.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('🟢 Back online — draining Firebase retry queue');
    window.drainRetryQueue?.();
  });
}

console.log('✓ Phase 4.1 Pending Enrolments Module Loaded');

// ============================================================================
// PHASE 4.2 — FINANCE REALTIME SYNC (Super Admin only, by convention —
// see the architecture note in admin.html's Finance module for exactly
// what this can and cannot enforce at the Firebase level.)
//
// Same connection (realtimeDb), same anonymous-auth pattern, same
// requestId-style "key by the local id" approach as Pending Enrolments —
// no new Firebase mechanism, just a new sibling node. Requires the
// Firebase Rules to be extended with a matching entry for
// /finance_expenses (see DEPLOY_PHASE_4_2.md) — without that, these
// calls will fail with permission-denied, exactly like any other
// unlisted path in a locked-down Realtime Database.
// ============================================================================

/**
 * Push/overwrite a finance expense record to Firebase, keyed by its own
 * local id (same "one identifier everywhere" pattern as enrolments).
 * Called only from admin.html's Finance module, which itself only ever
 * runs for a Super Admin session.
 */
window.syncFinanceExpenseFirebase = async (record) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    if (!record || !record.id) { resolve({ success: false, error: 'Missing record id' }); return; }
    realtimeDb.ref('finance_expenses/' + record.id).set({
      ...record,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => resolve({ success: true }))
      .catch((error) => {
        console.error('✗ Finance expense Firebase sync failed:', error);
        resolve({ success: false, error: error.message });
      });
  });
};

/**
 * Remove a finance expense record from Firebase (mirrors a local delete).
 */
window.deleteFinanceExpenseFirebase = async (id) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    realtimeDb.ref('finance_expenses/' + id).remove()
      .then(() => resolve({ success: true }))
      .catch((error) => resolve({ success: false, error: error.message }));
  });
};

/**
 * Real-time listener for finance expenses. admin.html only calls this
 * when _finCanAccess() (Super Admin) is true — never for Manager/Staff —
 * this is the primary defense, since Firebase Rules alone cannot
 * distinguish roles within admin.html (see architecture note above).
 */
window.listenFinanceExpenses = (callback) => {
  if (!realtimeDb) {
    console.error('Firebase not initialized');
    return null;
  }
  const ref = realtimeDb.ref('finance_expenses');
  const handler = (snapshot) => {
    console.log('[FB-DEBUG] Listener received update (finance_expenses)'); // TEMP DEBUG LOG — remove after live verification
    const expenses = [];
    snapshot.forEach((child) => expenses.push({ firebaseKey: child.key, ...child.val() }));
    callback(expenses);
  };
  const errorHandler = (error) => {
    // EMERGENCY STABILITY FIX: same reasoning as the Pending Enrolments
    // listener above — no error callback previously existed here either.
    console.error('✗ Finance Expenses listener error:', error);
    window._onFirebaseListenerFailed?.('finance'); // LISTENER LIFECYCLE — re-enable the polling fallback
    lastFirebaseError = 'Finance sync error: ' + error.message;
    connectionStatus = 'disconnected';
    _updateConnectionIndicator();
  };
  ref.on('value', handler, errorHandler);
  console.log('[FB-DEBUG] Listener attached (finance_expenses)'); // TEMP DEBUG LOG — remove after live verification
  return () => ref.off('value', handler);
};

console.log('✓ Phase 4.2 Finance Realtime Sync Module Loaded');

// ============================================================================
// PHASE 4.3.1 — COACHES REALTIME SYNC
// ----------------------------------------------------------------------------
// Same pattern as Finance/Enrolments: keyed by the module's own existing id
// (coachId), same connection, same admin-only Firebase Rule shape. Requires
// a matching Rules entry for /coaches — see DEPLOY_PHASE_4_3_1.md.
// ============================================================================

/**
 * Create or update a coach in Firebase, keyed by coachId (same id the
 * app already uses locally and in Sheets — no separate mapping needed).
 */
window.syncCoachFirebase = async (record) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    const coachId = record.coachId || record.id;
    if (!coachId) { resolve({ success: false, error: 'Missing coachId' }); return; }
    realtimeDb.ref('coaches/' + coachId).set({
      ...record,
      coachId,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => resolve({ success: true }))
      .catch((error) => {
        console.error('✗ Coach Firebase sync failed:', error);
        resolve({ success: false, error: error.message });
      });
  });
};

/**
 * Remove a coach from Firebase (mirrors a local delete).
 */
window.deleteCoachFirebase = async (coachId) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    realtimeDb.ref('coaches/' + coachId).remove()
      .then(() => resolve({ success: true }))
      .catch((error) => resolve({ success: false, error: error.message }));
  });
};

/**
 * Real-time listener for coaches. Includes a proper error/cancel
 * callback (the emergency-fix lesson from Phase 4.2 — every listener in
 * this file gets one now, not just the ones added after that fix).
 */
window.listenCoaches = (callback) => {
  if (!realtimeDb) {
    console.error('Firebase not initialized');
    return null;
  }
  const ref = realtimeDb.ref('coaches');
  const handler = (snapshot) => {
    console.log('[FB-DEBUG] Listener received update (coaches)'); // TEMP DEBUG LOG — remove after live verification, same convention as Phase 4.2's emergency fix
    const coaches = [];
    snapshot.forEach((child) => coaches.push({ firebaseKey: child.key, ...child.val() }));
    callback(coaches);
  };
  const errorHandler = (error) => {
    console.error('✗ Coaches listener error:', error);
    window._onFirebaseListenerFailed?.('coaches'); // LISTENER LIFECYCLE — re-enable the polling fallback
    lastFirebaseError = 'Coaches sync error: ' + error.message;
    connectionStatus = 'disconnected';
    _updateConnectionIndicator();
  };
  ref.on('value', handler, errorHandler);
  console.log('[FB-DEBUG] Listener attached (coaches)'); // TEMP DEBUG LOG — remove after live verification
  return () => ref.off('value', handler);
};

console.log('✓ Phase 4.3.1 Coaches Realtime Sync Module Loaded');

// ============================================================================
// PHASE 5 — COACH SETTLEMENT REALTIME SYNC (Super Admin only, same
// convention as Finance above — page/action gates live in admin.html,
// this is just the transport). Requires a matching Firebase Rules entry
// for /coach_settlements — see the Coach Settlement deploy notes.
// ============================================================================

/**
 * Push/overwrite a coach settlement record to Firebase, keyed by its own
 * settlementId (same "one identifier everywhere" pattern as Finance/
 * Coaches — the same id is used locally, in Firebase, and in Sheets).
 */
window.syncCoachSettlementFirebase = async (record) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    if (!record || !record.settlementId) { resolve({ success: false, error: 'Missing settlementId' }); return; }
    realtimeDb.ref('coach_settlements/' + record.settlementId).set({
      ...record,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => resolve({ success: true }))
      .catch((error) => {
        console.error('✗ Coach Settlement Firebase sync failed:', error);
        resolve({ success: false, error: error.message });
      });
  });
};

/**
 * Real-time listener for coach settlements. admin.html only calls this
 * when _finCanAccess() (Super Admin) is true, same hard gate as Finance.
 */
window.listenCoachSettlements = (callback) => {
  if (!realtimeDb) {
    console.error('Firebase not initialized');
    return null;
  }
  const ref = realtimeDb.ref('coach_settlements');
  const handler = (snapshot) => {
    console.log('[FB-DEBUG] Listener received update (coach_settlements)'); // TEMP DEBUG LOG — remove after live verification
    const settlements = [];
    snapshot.forEach((child) => settlements.push({ firebaseKey: child.key, ...child.val() }));
    callback(settlements);
  };
  const errorHandler = (error) => {
    console.error('✗ Coach Settlements listener error:', error);
    window._onFirebaseListenerFailed?.('coachSettlements'); // LISTENER LIFECYCLE — re-enable the polling fallback
    lastFirebaseError = 'Coach Settlements sync error: ' + error.message;
    connectionStatus = 'disconnected';
    _updateConnectionIndicator();
  };
  ref.on('value', handler, errorHandler);
  console.log('[FB-DEBUG] Listener attached (coach_settlements)'); // TEMP DEBUG LOG — remove after live verification
  return () => ref.off('value', handler);
};

console.log('✓ Phase 5 Coach Settlement Realtime Sync Module Loaded');

// ============================================================================
// STAGE 1 — Reservation Requests Realtime Sync
// ----------------------------------------------------------------------------
// Firebase's role here is STRICTLY the realtime transport layer — instant
// delivery of new/updated booking_request records to every logged-in
// admin device. It does NOT reimplement any business logic: duplicate
// prevention, overlap detection, autoRejectConflictingRequests, and the
// Sheets-authoritative conflict check all remain exactly where they
// already are, in admin.html's existing confirm/reject functions,
// completely unchanged. This file only carries data — it never decides
// whether a reservation is valid.
// ============================================================================

/**
 * Called from index.html (the PUBLIC site) when a customer submits a
 * reservation request. Additive to the existing local-save + Sheets-POST
 * — never replaces either. Keyed by requestId (a .set(), not .push()),
 * so a retried submission overwrites the same node instead of creating
 * a duplicate — identical reasoning to submitPendingEnrolmentFirebase.
 */
window.submitBookingRequestFirebase = async (payload) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    if (!payload || !payload.requestId) { resolve({ success: false, error: 'Missing requestId — cannot submit to Firebase.' }); return; }
    const ref = realtimeDb.ref('booking_requests/' + payload.requestId);
    ref.set({
      ...payload,
      createdAt: payload.createdAt || firebase.database.ServerValue.TIMESTAMP,
      _fbUpdatedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
      console.log('✓ Reservation request submitted to Firebase:', payload.requestId);
      resolve({ success: true, firebaseKey: payload.requestId });
    }).catch((error) => {
      console.error('✗ Failed to submit reservation request to Firebase:', error);
      resolve({ success: false, error: error.message });
    });
  });
};

/**
 * Called from admin.html AFTER the existing confirm/reject flow has
 * already done its own thing (local conflict checks, Sheets-authoritative
 * write, autoRejectConflictingRequests) — this call only broadcasts the
 * resulting status to other devices. It never runs before, or instead
 * of, any of that existing logic.
 */
window.syncBookingRequestFirebase = async (record) => {
  return new Promise((resolve) => {
    if (!realtimeDb) { resolve({ success: false, error: 'Firebase not initialized' }); return; }
    const requestId = record.requestId || record.id;
    if (!requestId) { resolve({ success: false, error: 'Missing requestId' }); return; }
    realtimeDb.ref('booking_requests/' + requestId).set({
      ...record,
      requestId,
      _fbUpdatedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => resolve({ success: true }))
      .catch((error) => {
        console.error('✗ Booking request Firebase sync failed:', error);
        resolve({ success: false, error: error.message });
      });
  });
};

/**
 * Real-time listener for booking requests (ADMIN ONLY — admin.html).
 * Same error/cancel-callback discipline as every listener added since
 * the Phase 4.2 emergency fix.
 */
window.listenBookingRequests = (callback) => {
  if (!realtimeDb) {
    console.error('Firebase not initialized');
    return null;
  }
  const ref = realtimeDb.ref('booking_requests');
  const handler = (snapshot) => {
    console.log('[FB-DEBUG] Listener received update (booking_requests)'); // TEMP DEBUG LOG — remove after live verification
    const requests = [];
    snapshot.forEach((child) => requests.push({ firebaseKey: child.key, ...child.val() }));
    callback(requests);
  };
  const errorHandler = (error) => {
    console.error('✗ Booking requests listener error:', error);
    window._onFirebaseListenerFailed?.('bookingRequests'); // LISTENER LIFECYCLE — re-enable the polling fallback
    lastFirebaseError = 'Booking requests sync error: ' + error.message;
    connectionStatus = 'disconnected';
    _updateConnectionIndicator();
  };
  ref.on('value', handler, errorHandler);
  console.log('[FB-DEBUG] Listener attached (booking_requests)'); // TEMP DEBUG LOG — remove after live verification
  return () => ref.off('value', handler);
};

console.log('✓ Stage 1 Reservation Requests Realtime Sync Module Loaded');

// ============================================================================
// TEMP DIAGNOSTICS PANEL — Phase 4.x migration debugging only.
// ----------------------------------------------------------------------------
// Everything below is purely additive instrumentation: it records what
// already happened into a plain object for the diagnostics page to read.
// Nothing here changes any write, any listener's actual behavior, or any
// business logic — deleting this entire block later has zero effect on
// production functionality.
//
// Safe removal: delete this block, delete the one-line
// `window._ddtzDiag.recordLatency(...)` calls added inside each write
// function below, delete the `window._ddtzDiag.recordEvent(...)` calls
// added inside admin.html's three listener merge functions, and delete
// the diagnostics page/permission/nav-item/renderDiagnostics in admin.html.
// ============================================================================
window._ddtzDiag = {
  events: [],           // {module, timestamp, eventType} — most recent first, capped
  notifications: { toastCount: 0, voiceCount: 0, bellCount: 0, lastToast: null, lastVoice: null, lastBell: null },
  writeLatencies: [],   // {module, ms, timestamp} — most recent first, capped
  backgroundSync: {},   // { [module]: { firebaseOk, sheetsOk, timestamp } }
  // ---- TEMP DIAGNOSTICS additions (System Health Dashboard expansion) ----
  reads: 0,             // count of listener snapshots received (proxy for "Firebase Reads" — there is no client-accessible exact read-count API)
  writes: 0,            // count of Firebase writes attempted (via the existing wrapper below)
  sheetsWrites: 0, sheetsFailures: 0,
  sheetsLatencies: [],  // {ms, timestamp} — most recent first, capped
  duplicatePreventions: 0, // count of "already processed by another user" conflicts caught
  errors: [], warnings: [], // {timestamp, module, message} — most recent first, capped at 20
  moduleActivity: {},   // { [module]: {action, user, timestamp} } — most recent action per module, THIS SESSION ONLY (not full history)
  // ---- TEMP SYSTEM HEALTH additions ----
  lastQueueLength: 0,     // previous sync-queue length, for detecting "increasing" trend
  hasEverConnected: false, // true once Firebase has connected at least once, to distinguish "still starting up" from "reconnecting after being connected"
  recordEvent(module, eventType) {
    this.events.unshift({ module, eventType, timestamp: new Date().toISOString() });
    if (this.events.length > 20) this.events.length = 20;
    this.reads++;
  },
  recordLatency(module, ms) {
    this.writeLatencies.unshift({ module, ms, timestamp: new Date().toISOString() });
    if (this.writeLatencies.length > 20) this.writeLatencies.length = 20;
    this.writes++;
  },
  recordSheetsLatency(ms, ok) {
    this.sheetsLatencies.unshift({ ms, timestamp: new Date().toISOString() });
    if (this.sheetsLatencies.length > 20) this.sheetsLatencies.length = 20;
    if (ok) this.sheetsWrites++; else this.sheetsFailures++;
  },
  recordBackgroundSync(module, firebaseOk, sheetsOk) {
    this.backgroundSync[module] = { firebaseOk, sheetsOk, timestamp: new Date().toISOString() };
  },
  recordNotification(kind) {
    if (kind === 'toast') { this.notifications.toastCount++; this.notifications.lastToast = new Date().toISOString(); }
    if (kind === 'voice') { this.notifications.voiceCount++; this.notifications.lastVoice = new Date().toISOString(); }
    if (kind === 'bell')  { this.notifications.bellCount++;  this.notifications.lastBell  = new Date().toISOString(); }
  },
  recordDuplicatePrevention() { this.duplicatePreventions++; },
  recordConsole(level, args) {
    const message = args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch(e) { return String(a); } }).join(' ').slice(0, 300);
    const list = level === 'error' ? this.errors : this.warnings;
    list.unshift({ timestamp: new Date().toISOString(), message });
    if (list.length > 20) list.length = 20;
  },
  recordModuleActivity(module, action, user) {
    this.moduleActivity[module] = { action, user, timestamp: new Date().toISOString() };
  },
  clear() {
    this.events = []; this.writeLatencies = []; this.sheetsLatencies = []; this.backgroundSync = {};
    this.errors = []; this.warnings = []; this.moduleActivity = {};
    this.reads = 0; this.writes = 0; this.sheetsWrites = 0; this.sheetsFailures = 0; this.duplicatePreventions = 0;
    this.lastQueueLength = 0; // TEMP SYSTEM HEALTH — reset trend baseline too
    this.notifications = { toastCount: 0, voiceCount: 0, bellCount: 0, lastToast: null, lastVoice: null, lastBell: null };
  }
};

// TEMP DIAGNOSTICS — capture console.error/console.warn into the panel's
// Error Monitor. Purely additive: the original console methods still run
// exactly as before (this calls them via .apply after recording), so
// nothing about actual logging behavior changes.
(function _diagWrapConsole() {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args) => { window._ddtzDiag.recordConsole('error', args); originalError(...args); };
  console.warn = (...args) => { window._ddtzDiag.recordConsole('warning', args); originalWarn(...args); };
})();

/**
 * Wraps a Firebase write function to also record its round-trip latency
 * — timing a write the app was ALREADY going to make for real business
 * reasons, not a new diagnostic-only ping. No new database writes are
 * introduced by this panel.
 */
function _diagTimeWrite(moduleName, promiseFn) {
  const start = performance.now();
  return promiseFn().then((result) => {
    window._ddtzDiag.recordLatency(moduleName, Math.round(performance.now() - start));
    return result;
  });
}

// Wrap the existing write functions to also time them — the functions
// themselves are completely untouched; this only wraps their external
// reference. Delete this block to fully remove timing instrumentation
// with zero effect on the wrapped functions' actual behavior.
['syncCoachFirebase', 'claimEnrolmentForApproval', 'finalizeEnrolmentApproval', 'rejectEnrolmentFirebase', 'syncFinanceExpenseFirebase', 'syncCoachSettlementFirebase'].forEach((name) => {
  const original = window[name];
  if (typeof original === 'function') {
    window[name] = (...args) => _diagTimeWrite(name, () => original(...args));
  }
});
