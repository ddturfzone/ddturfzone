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

    // Setup connection state monitoring
    _setupConnectionMonitoring();

    // Anonymous sign-in — only runs if this page loaded firebase-auth.js
    // (admin.html does; enroll.html does not), so this is a no-op on the
    // public form. Never blocks the rest of initialization if it fails
    // (e.g. Anonymous provider not yet enabled in the Firebase Console) —
    // logs a clear warning instead, matching this file's existing
    // fail-soft pattern everywhere else.
    if (typeof firebase.auth === 'function') {
      try {
        await firebase.auth().signInAnonymously();
        console.log('✓ Firebase anonymous auth established (admin-side only)');
      } catch (authError) {
        console.warn('⚠ Firebase anonymous auth failed — admin writes to existing records may be rejected by the security rule until this is resolved:', authError.message);
      }
    }

    return {
      success: true,
      app: firebaseApp,
      db: realtimeDb,
      message: 'Firebase initialized successfully'
    };
  } catch (error) {
    console.error('✗ Firebase initialization failed:', error);
    connectionStatus = 'disconnected';
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
  
  connectedRef.on('value', (snapshot) => {
    if (snapshot.val() === true) {
      connectionStatus = 'connected';
      console.log('🟢 Firebase connected');
    } else {
      connectionStatus = 'disconnected';
      console.log('🔴 Firebase disconnected');
    }
    _updateConnectionIndicator();
  });

  // Fallback: listen for explicit errors
  realtimeDb.ref().on('error', (error) => {
    console.error('Firebase Realtime Database error:', error);
    connectionStatus = 'disconnected';
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
    indicator.textContent = '🔴 Firebase Offline';
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
    isInitialized: firebaseApp !== null
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
    const enrolments = [];
    snapshot.forEach((child) => {
      enrolments.push({ firebaseKey: child.key, ...child.val() });
    });
    callback(enrolments);
  };
  ref.on('value', handler);

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

/**
 * Lock an enrolment to prevent concurrent edits
 */
window.lockEnrolmentFirebase = async (firebaseKey, adminEmail) => {
  return new Promise((resolve) => {
    if (!realtimeDb) {
      resolve({ success: false, error: 'Firebase not initialized' });
      return;
    }

    const ref = realtimeDb.ref(`pending_enrolments/${firebaseKey}`);
    ref.update({
      lockedBy: adminEmail,
      lockedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
      resolve({ success: true });
    }).catch((error) => {
      resolve({ success: false, error: error.message });
    });
  });
};

/**
 * Unlock an enrolment
 */
window.unlockEnrolmentFirebase = async (firebaseKey) => {
  return new Promise((resolve) => {
    if (!realtimeDb) {
      resolve({ success: false, error: 'Firebase not initialized' });
      return;
    }

    const ref = realtimeDb.ref(`pending_enrolments/${firebaseKey}`);
    ref.update({
      lockedBy: null,
      lockedAt: null
    }).then(() => {
      resolve({ success: true });
    }).catch((error) => {
      resolve({ success: false, error: error.message });
    });
  });
};

/**
 * Update sync status (called by Apps Script)
 */
window.updateSyncStatusFirebase = async (firebaseKey, syncStatus, syncAttempts, error = null) => {
  return new Promise((resolve) => {
    if (!realtimeDb) {
      resolve({ success: false, error: 'Firebase not initialized' });
      return;
    }

    const updateData = {
      syncStatus: syncStatus,
      syncAttempts: syncAttempts,
      lastSyncTime: firebase.database.ServerValue.TIMESTAMP
    };

    if (error) {
      updateData.lastSyncError = error;
    }

    const ref = realtimeDb.ref(`pending_enrolments/${firebaseKey}`);
    ref.update(updateData).then(() => {
      resolve({ success: true });
    }).catch((error) => {
      resolve({ success: false, error: error.message });
    });
  });
};

// ========== PHASE 4.1: VOICE NOTIFICATIONS ==========

// Voice notification settings
let voiceNotificationEnabled = localStorage.getItem('ddtz_voice_enabled') !== 'false';
let voiceVolume = parseFloat(localStorage.getItem('ddtz_voice_volume')) || 1.0;
let voicePitch = parseFloat(localStorage.getItem('ddtz_voice_pitch')) || 1.0;
let voiceRate = parseFloat(localStorage.getItem('ddtz_voice_rate')) || 1.0;
let lastAnnouncedEvents = {}; // Track last announcement time to prevent duplicates

/**
 * Play voice announcement (Browser SpeechSynthesis API)
 * Only plays on OTHER devices, not the current device
 * isCurrentDevice = true means don't announce (user just did the action)
 */
window.playVoiceAnnouncement = (message, isCurrentDevice = false) => {
  if (!voiceNotificationEnabled || isCurrentDevice) {
    return; // Don't announce on current device or if disabled
  }

  // Prevent duplicate announcements within 3 seconds
  const eventKey = message;
  const lastTime = lastAnnouncedEvents[eventKey] || 0;
  if (Date.now() - lastTime < 3000) {
    console.log('⏭ Skipping duplicate announcement:', message);
    return;
  }

  if (!('speechSynthesis' in window)) {
    console.warn('Speech Synthesis not supported');
    return;
  }

  try {
    // Cancel any pending speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = voiceRate;
    utterance.pitch = voicePitch;
    utterance.volume = voiceVolume;

    utterance.onstart = () => {
      console.log('🔊 Voice announcement started:', message);
    };

    utterance.onend = () => {
      console.log('✓ Voice announcement complete');
      lastAnnouncedEvents[eventKey] = Date.now();
    };

    utterance.onerror = (event) => {
      console.error('✗ Voice announcement error:', event.error);
    };

    window.speechSynthesis.speak(utterance);
  } catch (error) {
    console.error('✗ Error playing voice announcement:', error);
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
    const expenses = [];
    snapshot.forEach((child) => expenses.push({ firebaseKey: child.key, ...child.val() }));
    callback(expenses);
  };
  ref.on('value', handler);
  return () => ref.off('value', handler);
};

console.log('✓ Phase 4.2 Finance Realtime Sync Module Loaded');
