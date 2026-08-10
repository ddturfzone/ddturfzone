/**
 * DD Turf Zone – Firebase Realtime Database + Firestore Service
 * Phase 5: Firebase Firestore for Fees (Primary), Realtime DB for Availability
 * 
 * FEES now use Firestore (reliable, scalable)
 * Google Sheets only for backup
 */

// ========== FIREBASE CONFIGURATION ==========
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
let firestoreDb = null;
let connectionStatus = 'unknown'; // 'connected' | 'disconnected' | 'unknown'

let firebaseFullyReady = false;
let lastFirebaseError = null;
let authState = 'pending'; // 'pending' | 'success' | 'failed' | 'skipped'

/**
 * Initialize Firebase (Realtime DB + Firestore)
 */
window.initializeFirebase = async () => {
  console.log('[FB-DEBUG] Firebase initialization started');
  try {
    if (firebaseApp) {
      console.warn('Firebase already initialized');
      return { success: true, app: firebaseApp, db: realtimeDb, firestore: firestoreDb };
    }

    // Initialize Firebase App
    firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    console.log('✓ Firebase App initialized:', firebaseApp.name);

    // Get Realtime Database reference
    realtimeDb = firebase.database(firebaseApp);
    console.log('✓ Firebase Realtime Database initialized');

    // Get Firestore reference
    // BUGFIX: this used to be unguarded, so if firebase.firestore was ever
    // undefined (e.g. the firebase-firestore-compat.js script tag was
    // missing from admin.html, as it was until now) this line threw and
    // was caught by the OUTER try/catch below — which aborted the entire
    // function before firebaseFullyReady was ever set. That took Realtime
    // DB and Auth down with it, even though both had already succeeded
    // above, and left every login stuck on "Connecting..." indefinitely.
    // Isolating Firestore's own init means a Firestore-specific problem
    // (e.g. a CDN hiccup) degrades gracefully — Fees will show a Firestore
    // error, but Bookings/Students/Attendance/etc. via Realtime DB keep
    // working, and the connection indicator reflects reality instead of
    // freezing.
    try {
      firestoreDb = firebase.firestore(firebaseApp);
      console.log('✓ Firebase Firestore initialized');
    } catch (firestoreError) {
      firestoreDb = null;
      lastFirebaseError = 'Firestore init error: ' + firestoreError.message;
      console.error('✗ Firebase Firestore initialization failed (Fees will be unavailable):', firestoreError.message);
    }

    // Setup connection state monitoring
    _setupConnectionMonitoring();

    // Anonymous sign-in
    if (typeof firebase.auth === 'function') {
      console.log('[FB-DEBUG] Anonymous sign-in started');
      try {
        await firebase.auth().signInAnonymously();
        authState = 'success';
        console.log('✓ Firebase anonymous auth established');
      } catch (authError) {
        authState = 'failed';
        lastFirebaseError = 'Authentication error: ' + authError.message;
        console.warn('⚠ Firebase anonymous auth failed:', authError.message);
        _updateConnectionIndicator();
      }
    } else {
      authState = 'skipped';
    }

    firebaseFullyReady = true;
    console.log(`[FB-DEBUG] Firebase initialized — fullyReady=true, authState=${authState}`);

    return {
      success: true,
      app: firebaseApp,
      db: realtimeDb,
      firestore: firestoreDb,
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
 * Monitor Firebase connection state
 */
function _setupConnectionMonitoring() {
  if (!realtimeDb) {
    console.warn('Realtime Database not available for connection monitoring');
    return;
  }

  const connectedRef = firebase.database(firebaseApp).ref('.info/connected');
  connectedRef.on('value', (snapshot) => {
    if (snapshot.val() === true) {
      connectionStatus = 'connected';
      lastFirebaseError = null;
      console.log('✓ Firebase connected');
    } else {
      connectionStatus = 'disconnected';
      lastFirebaseError = 'Firebase connection lost';
      console.warn('⚠ Firebase disconnected');
    }
    _updateConnectionIndicator();
  }, (error) => {
    connectionStatus = 'disconnected';
    lastFirebaseError = 'Connection monitoring failed: ' + error.message;
    console.error('✗ Connection monitoring error:', error);
    _updateConnectionIndicator();
  });
}

/**
 * Update connection indicator in UI
 * BUGFIX: this used to look up 'connection-indicator', but the actual
 * element in admin.html is id="firebase-connection-indicator". That
 * mismatch meant getElementById() always returned null and this function
 * silently no-op'd on every state change — so the badge stayed frozen on
 * its default "⚪ Firebase Connecting..." text forever, even once Firebase
 * connected successfully behind the scenes. Also updated to actually set
 * the badge's text (it's a text badge, not a colored dot, so setting only
 * .style.background/.title previously had no visible effect at all).
 */
function _updateConnectionIndicator() {
  const indicator = document.getElementById('firebase-connection-indicator');
  if (!indicator) return;

  if (connectionStatus === 'connected') {
    indicator.textContent = '🟢 Firebase Connected';
    indicator.style.color = 'var(--green, #0F7A45)';
    indicator.title = 'Firebase connected';
  } else if (connectionStatus === 'disconnected') {
    indicator.textContent = '🔴 Firebase Disconnected';
    indicator.style.color = 'var(--red, #ef4444)';
    indicator.title = lastFirebaseError || 'Firebase disconnected';
  } else {
    indicator.textContent = '⚪ Firebase Connecting...';
    indicator.style.color = 'var(--gray3)';
    indicator.title = 'Connecting...';
  }
}

// ============================================================================
// FIRESTORE FEES COLLECTION (PRIMARY DATABASE)
// ============================================================================

/**
 * GET all fees from Firestore
 * Returns: { ok: true, fees: [...] } or { ok: false, error: '...' }
 */
window.getAllFeesFromFirestore = async () => {
  try {
    if (!firestoreDb) {
      return { ok: false, error: 'Firestore not initialized' };
    }

    const snapshot = await firestoreDb.collection('fees').get();
    const fees = [];
    
    snapshot.forEach(doc => {
      fees.push({
        receiptNo: doc.id,
        ...doc.data()
      });
    });

    console.log(`✓ Loaded ${fees.length} fees from Firestore`);
    return { ok: true, fees: fees };
  } catch (error) {
    console.error('✗ Failed to load fees from Firestore:', error);
    return { ok: false, error: error.message };
  }
};

/**
 * SAVE a single fee to Firestore
 * receiptNo: string (DDTZ-YYYYMM-00001 format)
 * feeData: { studentId, studentName, sport, batch, coach, feeType, dueMonth, year, amountPayable, amountReceived, pending, paymentMethod, paymentType, status, receiptDate, notes, includesJoiningFee, createdBy }
 */
window.saveFeeToFirestore = async (receiptNo, feeData) => {
  try {
    if (!firestoreDb) {
      return { ok: false, error: 'Firestore not initialized' };
    }

    const timestamp = new Date().toISOString();
    const docData = {
      ...feeData,
      updatedAt: timestamp,
      _fbUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    // If creating new, add createdAt
    if (!feeData.createdAt) {
      docData.createdAt = timestamp;
    }

    await firestoreDb.collection('fees').doc(receiptNo).set(docData, { merge: true });

    console.log(`✓ Fee ${receiptNo} saved to Firestore`);
    // BUG FIX — updatedAt is now included in the return value (previously
    // generated here but never handed back to the caller), so a caller
    // that just wrote this record can stamp its own local copy with the
    // exact same timestamp Firestore now has, instead of only finding out
    // via the next realtime listener snapshot. Purely additive — every
    // existing caller that only read .ok/.receiptNo/.message is unaffected.
    return { ok: true, receiptNo: receiptNo, updatedAt: timestamp, message: 'Fee saved successfully' };
  } catch (error) {
    console.error('✗ Failed to save fee to Firestore:', error);
    return { ok: false, error: error.message };
  }
};

/**
 * UPDATE a single fee in Firestore
 */
window.updateFeeInFirestore = async (receiptNo, updateData) => {
  try {
    if (!firestoreDb) {
      return { ok: false, error: 'Firestore not initialized' };
    }

    const timestamp = new Date().toISOString();
    const docData = {
      ...updateData,
      updatedAt: timestamp,
      _fbUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    await firestoreDb.collection('fees').doc(receiptNo).update(docData);
    
    console.log(`✓ Fee ${receiptNo} updated in Firestore`);
    return { ok: true, receiptNo: receiptNo, message: 'Fee updated successfully' };
  } catch (error) {
    console.error('✗ Failed to update fee in Firestore:', error);
    return { ok: false, error: error.message };
  }
};

/**
 * DELETE a fee from Firestore (soft delete - mark as deleted)
 */
window.deleteFeeFromFirestore = async (receiptNo) => {
  try {
    if (!firestoreDb) {
      return { ok: false, error: 'Firestore not initialized' };
    }

    const timestamp = new Date().toISOString();
    await firestoreDb.collection('fees').doc(receiptNo).update({
      status: 'deleted',
      updatedAt: timestamp,
      _fbUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✓ Fee ${receiptNo} marked as deleted in Firestore`);
    return { ok: true, receiptNo: receiptNo, message: 'Fee deleted successfully' };
  } catch (error) {
    console.error('✗ Failed to delete fee from Firestore:', error);
    return { ok: false, error: error.message };
  }
};

/**
 * LISTEN to fees collection in real-time
 * Calls callback whenever fees change
 */
window.listenToFeesRealtime = (callback, onError) => {
  try {
    if (!firestoreDb) {
      onError?.(new Error('Firestore not initialized'));
      return null;
    }

    const unsubscribe = firestoreDb.collection('fees')
      .where('status', '!=', 'deleted') // Only active fees
      .onSnapshot(
        (snapshot) => {
          const fees = [];
          snapshot.forEach(doc => {
            fees.push({
              receiptNo: doc.id,
              ...doc.data()
            });
          });
          console.log(`✓ Real-time fees update: ${fees.length} active fees`);
          callback(fees);
        },
        (error) => {
          console.error('✗ Real-time fees listener error:', error);
          onError?.(error);
        }
      );

    return unsubscribe; // Return unsubscribe function
  } catch (error) {
    console.error('✗ Failed to set up real-time fees listener:', error);
    onError?.(error);
    return null;
  }
};

/**
 * Generate next receipt number (client-side - for UX optimization)
 * Should be validated/regenerated server-side to ensure uniqueness
 */
window.generateNextReceiptNumber = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `DDTZ-${year}${month}-`;
  
  // Random 5-digit number - server will validate uniqueness
  const seq = String(Math.floor(Math.random() * 99999)).padStart(5, '0');
  return `${prefix}${seq}`;
};

// ============================================================================
// FEES — BRIDGE FUNCTIONS (new)
// ----------------------------------------------------------------------------
// admin.html's Fee Collection flow (_saveFeeImpl, deleteFee) and its
// realtime listener (initFeesFirebaseListener) were already fully built
// to call window.syncFeeFirebase / window.deleteFeeFirebase /
// window.listenFees (via optional chaining, so it degraded gracefully
// while these were missing) — but this file only ever defined the lower-
// level Firestore primitives above (saveFeeToFirestore/
// updateFeeInFirestore/deleteFeeFromFirestore/listenToFeesRealtime) under
// different names, so the two sides never actually connected and Fees
// had no working Firebase sync at all.
//
// These three functions are pure bridges to the EXISTING Firestore
// primitives above — nothing here talks to Firestore directly, and none
// of the primitives above are modified, renamed, or replaced. This keeps
// "Fees = Firestore, primary; Sheets = backup" (this file's own opening
// comment) exactly as originally designed, just actually wired up.
// ============================================================================

/**
 * Create or update one fee (Firestore doc id = receiptNo). Bridges to the
 * existing saveFeeToFirestore, which already safely handles both create
 * and update via set({merge:true}). Returns { success: true } or
 * { success: false, error }, matching every other module's Firebase
 * wrapper shape (syncStudentFirebase, syncCoachFirebase, etc.).
 */
window.syncFeeFirebase = async (data) => {
  try {
    const receiptNo = data && data.receiptNo;
    if (!receiptNo) return { success: false, error: 'Missing receiptNo' };
    const result = await window.saveFeeToFirestore(receiptNo, data);
    if (!result || !result.ok) return { success: false, error: (result && result.error) || 'Unknown Firestore error' };
    // BUG FIX — pass the timestamp saveFeeToFirestore just used back to
    // the caller, so it can stamp its own local record's _fbUpdatedAt
    // immediately instead of waiting for the realtime listener's own
    // echo to arrive (which, if a logout happens first, might not have
    // landed and been persisted to localStorage yet).
    return { success: true, updatedAt: result.updatedAt };
  } catch (err) {
    console.error('✗ [SYNC] syncFeeFirebase failed:', data && data.receiptNo, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Delete one fee. Bridges to the existing deleteFeeFromFirestore (a soft
 * delete — marks status:'deleted', which listenToFeesRealtime's own query
 * already excludes). Returns { success: true } or { success: false, error }.
 */
window.deleteFeeFirebase = async (receiptNo) => {
  try {
    if (!receiptNo) return { success: false, error: 'Missing receiptNo' };
    const result = await window.deleteFeeFromFirestore(receiptNo);
    if (!result || !result.ok) return { success: false, error: (result && result.error) || 'Unknown Firestore error' };
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] deleteFeeFirebase failed:', receiptNo, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all active fees. Pure alias for the existing
 * listenToFeesRealtime — same signature, same behavior, just under the
 * name admin.html's initFeesFirebaseListener already calls.
 */
window.listenFees = (callback, onError) => window.listenToFeesRealtime(callback, onError);

// ============================================================================
// REAL-TIME DATABASE (for availability - existing code)
// ============================================================================

/**
 * Publish availability record to Realtime DB
 */
window.publishAvailabilityRecord = (kind, id, data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return;

    const ref = realtimeDb.ref(`live_availability/${kind}/${id}`);
    
    if (!data) {
      ref.remove().catch((err) => console.error('✗ [SYNC] Availability remove failed:', kind, id, err));
      return;
    }
    ref.set({ ...data, _fbUpdatedAt: firebase.database.ServerValue.TIMESTAMP })
      .catch((err) => console.error('✗ [SYNC] Availability publish failed:', kind, id, err));
  } catch (err) {
    console.error('✗ [SYNC] publishAvailabilityRecord error:', err);
  }
};

/**
 * Listen to live availability
 */
window.listenLiveAvailability = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('live_availability');
  const handler = (snapshot) => {
    const bookings = [];
    const blocks = [];
    snapshot.forEach((kindSnap) => {
      kindSnap.forEach((child) => {
        const rec = { id: child.key, ...child.val() };
        if (kindSnap.key === 'bookings') bookings.push(rec);
        else if (kindSnap.key === 'blocks') blocks.push(rec);
      });
    });
    console.log('[SYNC] Live availability snapshot:', bookings.length, 'booking(s),', blocks.length, 'block(s)');
    callback({ bookings, blocks });
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Live availability listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// CAFÉ — REAL-TIME DATABASE (new — Café Items + Café Sales)
// ----------------------------------------------------------------------------
// Self-contained addition. Does not modify, remove, or rename anything else
// in this file. Mirrors the existing publishAvailabilityRecord/
// listenLiveAvailability read/write pattern above (same realtimeDb ref/.on/
// .set/.remove calls, same guard checks) and the existing Fees Firestore
// functions' success/error return shape (syncCoachFirebase-style
// { success, error } object), so admin.html's café functions can await
// these exactly like it already awaits window.syncCoachFirebase.
//
// Paths used (both brand-new nodes — nothing existing lives under these
// paths, confirmed against this file before this addition, so there is no
// collision with any existing data):
//   cafeItems/{id}   — one node per café menu item
//   cafeSales/{id}   — one node per café sale line (one per cart line saved)
//
// There is intentionally no deleteCafeSaleFirebase — Café Sales are
// append-only everywhere else in this app (no deleteCafeSale function
// exists in admin.html either), so none was added here.
// ============================================================================

/**
 * Create or update one café menu item.
 * Returns { success: true } or { success: false, error }.
 */
window.saveCafeItemFirebase = async (id, data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const ref = realtimeDb.ref(`cafeItems/${id}`);
    await ref.set({ ...data, id, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] saveCafeItemFirebase failed:', id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Delete one café menu item.
 * Returns { success: true } or { success: false, error }.
 */
window.deleteCafeItemFirebase = async (id) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    await realtimeDb.ref(`cafeItems/${id}`).remove();
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] deleteCafeItemFirebase failed:', id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for the full café menu. callback receives an array
 * of item records (each with .id). Returns an unsubscribe function, or
 * null if Firebase isn't initialized yet (onError is called in that case).
 */
window.listenCafeItems = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('cafeItems');
  const handler = (snapshot) => {
    const items = [];
    snapshot.forEach((child) => { items.push({ id: child.key, ...child.val() }); });
    callback(items);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Café items listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

/**
 * Create one café sale line (one call per cart line — matches the
 * existing "every cart line is its own Cafe Log Sale row" model already
 * used for the Google Sheets/local copy).
 * Returns { success: true } or { success: false, error }.
 */
window.saveCafeSaleFirebase = async (id, data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const ref = realtimeDb.ref(`cafeSales/${id}`);
    await ref.set({ ...data, id, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] saveCafeSaleFirebase failed:', id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all café sales. callback receives an array of
 * sale records (each with .id). Returns an unsubscribe function, or null
 * if Firebase isn't initialized yet (onError is called in that case).
 */
window.listenCafeSales = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('cafeSales');
  const handler = (snapshot) => {
    const sales = [];
    snapshot.forEach((child) => { sales.push({ id: child.key, ...child.val() }); });
    callback(sales);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Café sales listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// COACHES — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// admin.html already calls window.syncCoachFirebase / window.listenCoaches /
// window.deleteCoachFirebase (via optional chaining, so it degraded
// gracefully while these were missing — see this file's own gap note in
// the FACTORY RESET comment below). This defines them for real, following
// the exact same pattern as the Café addition directly above: mirrors
// publishAvailabilityRecord/listenLiveAvailability's realtimeDb.ref/.on/
// .set/.remove calls, same guard checks, same { success, error } shape.
//
// Path used: coaches/{coachId} — keyed by the coach's own coachId field,
// already this app's identifier for a coach everywhere else (Coach
// Settlement, Student assignment, etc.), so no new ID scheme is introduced.
// ============================================================================

/**
 * Create or update one coach. Returns { success: true } or
 * { success: false, error }.
 */
window.syncCoachFirebase = async (data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const coachId = data && data.coachId;
    if (!coachId) return { success: false, error: 'Missing coachId' };
    const ref = realtimeDb.ref(`coaches/${coachId}`);
    await ref.set({ ...data, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncCoachFirebase failed:', data && data.coachId, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Delete one coach. Returns { success: true } or { success: false, error }.
 */
window.deleteCoachFirebase = async (coachId) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    await realtimeDb.ref(`coaches/${coachId}`).remove();
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] deleteCoachFirebase failed:', coachId, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all coaches. callback receives an array of coach
 * records (each with .coachId). Returns an unsubscribe function, or null
 * if Firebase isn't initialized yet (onError is called in that case).
 */
window.listenCoaches = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('coaches');
  const handler = (snapshot) => {
    const coaches = [];
    snapshot.forEach((child) => { coaches.push({ coachId: child.key, ...child.val() }); });
    callback(coaches);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Coaches listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// ATTENDANCE — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// Same pattern as the Café and Coaches additions above. An attendance mark
// has no id of its own that's stable across devices — its true identity is
// studentId+date (see saveOneAttendance/syncAttendanceFromSheet in
// admin.html, which already upsert/merge on that composite key, never on
// a record's local id) — so unlike Café/Coaches, this is keyed by a
// deterministic "studentId_date" path rather than a generated id. That
// makes a concurrent mark for the same student+date from two devices a
// plain last-write-wins overwrite at the same path, with no possibility
// of a duplicate record.
//
// There is no deleteAttendanceFirebase — the existing Attendance system
// has no delete function at all (Present/Absent is always an update of
// the same studentId+date row), so none was added here.
// ============================================================================

function _attendanceFirebaseKey(studentId, date) {
  // Firebase RTDB keys can't contain '.', '#', '$', '[', ']', '/'.
  return `${studentId}_${date}`.replace(/[.#$\[\]/]/g, '-');
}

/**
 * Create or update one attendance mark (studentId+date is the identity).
 * Returns { success: true } or { success: false, error }.
 */
window.syncAttendanceFirebase = async (rec) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    if (!rec || !rec.studentId || !rec.date) return { success: false, error: 'Missing studentId/date' };
    const key = _attendanceFirebaseKey(rec.studentId, rec.date);
    const ref = realtimeDb.ref(`attendance/${key}`);
    await ref.set({
      id: rec.id || '',
      studentId: rec.studentId,
      studentName: rec.studentName || '',
      sport: rec.sport || '',
      coach: rec.coach || '',
      date: rec.date,
      // Matches the format already used for Sheets-sourced attendance rows
      // (see admin.html's autoSyncAttendance/syncAttendanceFromSheet) so a
      // record arriving here reads the same way as one merged from Sheets.
      status: rec.status === 'P' ? 'Present' : (rec.status === 'A' ? 'Absent' : rec.status),
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncAttendanceFirebase failed:', rec && rec.studentId, rec && rec.date, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all attendance marks. callback receives an array
 * of records (each with .studentId/.date). Returns an unsubscribe
 * function, or null if Firebase isn't initialized yet (onError is called
 * in that case).
 */
window.listenAttendance = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('attendance');
  const handler = (snapshot) => {
    const records = [];
    snapshot.forEach((child) => { records.push(child.val()); });
    callback(records);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Attendance listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// ENQUIRIES — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// Same pattern as the Café/Coaches/Attendance additions above. Keyed by
// the enquiry's own id (the same identity syncEnquiriesFromSheet already
// merges on), since — unlike Attendance — an enquiry's local id already
// is its stable identity everywhere else in the app.
// ============================================================================

/**
 * Create or update one enquiry. Returns { success: true } or
 * { success: false, error }.
 */
window.syncEnquiryFirebase = async (data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const id = data && data.id;
    if (!id) return { success: false, error: 'Missing id' };
    const ref = realtimeDb.ref(`enquiries/${id}`);
    await ref.set({ ...data, id, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncEnquiryFirebase failed:', data && data.id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Delete one enquiry. Returns { success: true } or { success: false, error }.
 */
window.deleteEnquiryFirebase = async (id) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    await realtimeDb.ref(`enquiries/${id}`).remove();
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] deleteEnquiryFirebase failed:', id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all enquiries. callback receives an array of
 * enquiry records (each with .id). Returns an unsubscribe function, or
 * null if Firebase isn't initialized yet (onError is called in that case).
 */
window.listenEnquiries = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('enquiries');
  const handler = (snapshot) => {
    const enquiries = [];
    snapshot.forEach((child) => { enquiries.push({ id: child.key, ...child.val() }); });
    callback(enquiries);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Enquiries listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// STUDENTS — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// admin.html already calls window.syncStudentFirebase / window.listenStudents
// / window.deleteStudentFirebase (via optional chaining, so it degraded
// gracefully while these were missing — see this file's own gap note in
// the FACTORY RESET comment below) from a fully-built Students realtime
// listener (initStudentsFirebaseListener), saveStudent, archiveStudent/
// restoreStudent, and bulkDeleteStudents. This defines them for real,
// following the exact same pattern as the Café/Coaches/Enquiries
// additions above.
//
// Path used: students/{studentId} — keyed by the student's own studentId
// field, already this app's identifier for a student everywhere else
// (Attendance, Fees, Birthday, Coach assignment), so no new ID scheme is
// introduced and no existing relationship is affected.
// ============================================================================

/**
 * Create or update one student. Returns { success: true } or
 * { success: false, error }.
 */
window.syncStudentFirebase = async (data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const studentId = data && data.studentId;
    if (!studentId) return { success: false, error: 'Missing studentId' };
    const ref = realtimeDb.ref(`students/${studentId}`);
    await ref.set({ ...data, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncStudentFirebase failed:', data && data.studentId, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Permanently delete one student. Returns { success: true } or
 * { success: false, error }.
 */
window.deleteStudentFirebase = async (studentId) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    await realtimeDb.ref(`students/${studentId}`).remove();
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] deleteStudentFirebase failed:', studentId, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all students. callback receives an array of
 * student records (each with .studentId). Returns an unsubscribe
 * function, or null if Firebase isn't initialized yet (onError is called
 * in that case).
 */
window.listenStudents = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('students');
  const handler = (snapshot) => {
    const students = [];
    snapshot.forEach((child) => { students.push({ studentId: child.key, ...child.val() }); });
    callback(students);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Students listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// DUE ADJUSTMENTS — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// admin.html's saveDueAdjustment and its realtime listener
// (initDueAdjustmentsFirebaseListener) were already fully built to call
// window.syncDueAdjustmentFirebase / window.listenDueAdjustments (via
// optional chaining, so it degraded gracefully while these were missing —
// see this file's own gap note in the FACTORY RESET comment below). This
// defines them for real, following the exact same pattern as the Café/
// Coaches/Students/Enquiries additions above.
//
// Due Adjustments are append-only everywhere else in this app (a manual
// correction entry is created and never edited or deleted — confirmed:
// no deleteDueAdjustment function exists anywhere in admin.html), and the
// existing listener already reflects that (ADD-only, no update/remove
// branches) — so there is no deleteDueAdjustmentFirebase here, matching
// that same design; adding one would be inventing a feature that doesn't
// exist.
//
// Path used: dueAdjustments/{id} — keyed by the adjustment's own existing
// id (already generated in saveDueAdjustment as 'ADJ'+timestamp — no new
// ID scheme is introduced here).
// ============================================================================

/**
 * Create one due adjustment (append-only — never updated or deleted).
 * Returns { success: true } or { success: false, error }.
 */
window.syncDueAdjustmentFirebase = async (record) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const id = record && record.id;
    if (!id) return { success: false, error: 'Missing id' };
    const ref = realtimeDb.ref(`dueAdjustments/${id}`);
    await ref.set({ ...record, id, _fbUpdatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncDueAdjustmentFirebase failed:', record && record.id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all due adjustments. callback receives an array
 * of records (each with .id). Returns an unsubscribe function, or null if
 * Firebase isn't initialized yet (onError is called in that case).
 */
window.listenDueAdjustments = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('dueAdjustments');
  const handler = (snapshot) => {
    const adjustments = [];
    snapshot.forEach((child) => { adjustments.push({ id: child.key, ...child.val() }); });
    callback(adjustments);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Due Adjustments listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// BOOKING REQUESTS — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// admin.html's confirmBookingRequest / rejectBookingRequest /
// autoRejectConflictingRequests and the realtime listener
// (initBookingRequestsFirebaseListener) were already fully built to call
// window.syncBookingRequestFirebase / window.listenBookingRequests (via
// optional chaining, so it degraded gracefully while these were missing —
// see this file's own gap note in the FACTORY RESET comment below). This
// defines them for real, following the exact same pattern as the Café/
// Coaches/Students/Enquiries/Due Adjustments additions above.
//
// This is STRICTLY the realtime-notification layer, additive to the
// existing Sheets sync (syncBookingRequestUpdate) which remains the
// actual write-of-record — admin.html already calls this fire-and-forget,
// after the Sheets call, never blocking on it (see the "STAGE 1 —
// realtime transport only" comments at each call site). Nothing about
// that ordering or the underlying booking/conflict logic is touched here.
//
// There is no deleteBookingRequestFirebase — a booking request is never
// deleted, only status-transitioned PENDING -> CONFIRMED/REJECTED
// (confirmed: no delete function exists anywhere in admin.html for this
// module, and the existing listener already reflects that — add+update
// only, no removal branch) — so none was added here.
//
// Path used: bookingRequests/{requestId} — keyed by the request's own
// existing requestId field, already this app's identifier for a booking
// request everywhere else. No new ID scheme is introduced.
// ============================================================================

/**
 * Create or update one booking request. Returns { success: true } or
 * { success: false, error }.
 */
window.syncBookingRequestFirebase = async (data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const requestId = data && (data.requestId || data.id);
    if (!requestId) return { success: false, error: 'Missing requestId' };
    const ref = realtimeDb.ref(`bookingRequests/${requestId}`);
    await ref.set({ ...data, requestId, _fbUpdatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncBookingRequestFirebase failed:', data && (data.requestId || data.id), err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all booking requests. callback receives an array
 * of request records (each with .requestId). Returns an unsubscribe
 * function, or null if Firebase isn't initialized yet (onError is called
 * in that case).
 */
window.listenBookingRequests = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('bookingRequests');
  const handler = (snapshot) => {
    const requests = [];
    snapshot.forEach((child) => { requests.push({ requestId: child.key, ...child.val() }); });
    callback(requests);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Booking Requests listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// FINANCE EXPENSES — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// admin.html's saveFinanceExpense / deleteFinanceExpense /
// markFinanceExpensePaid and its realtime listener
// (initFinanceFirebaseListener, already Super-Admin-gated via
// _finCanAccess() inside admin.html itself — nothing about that gate is
// duplicated or changed here) were already fully built to call
// window.syncFinanceExpenseFirebase / window.deleteFinanceExpenseFirebase
// / window.listenFinanceExpenses (via optional chaining, so it degraded
// gracefully while these were missing — see this file's own gap note in
// the FACTORY RESET comment below). This defines them for real, following
// the exact same pattern as the Café/Coaches/Students/Enquiries/Due
// Adjustments/Booking Requests additions above.
//
// Path used: financeExpenses/{id} — keyed by the expense's own existing
// local id (LS.add/LS.update's id), already this app's identifier for a
// finance expense everywhere else. No new ID scheme is introduced.
// ============================================================================

/**
 * Create or update one finance expense. Returns { success: true } or
 * { success: false, error }.
 */
window.syncFinanceExpenseFirebase = async (data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const id = data && data.id;
    if (!id) return { success: false, error: 'Missing id' };
    const ref = realtimeDb.ref(`financeExpenses/${id}`);
    await ref.set({ ...data, id, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncFinanceExpenseFirebase failed:', data && data.id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Delete one finance expense. Returns { success: true } or
 * { success: false, error }.
 */
window.deleteFinanceExpenseFirebase = async (id) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    await realtimeDb.ref(`financeExpenses/${id}`).remove();
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] deleteFinanceExpenseFirebase failed:', id, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all finance expenses. callback receives an array
 * of expense records (each with .id). Returns an unsubscribe function, or
 * null if Firebase isn't initialized yet (onError is called in that case).
 */
window.listenFinanceExpenses = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('financeExpenses');
  const handler = (snapshot) => {
    const expenses = [];
    snapshot.forEach((child) => { expenses.push({ id: child.key, ...child.val() }); });
    callback(expenses);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Finance Expenses listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// COACH SETTLEMENTS — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// admin.html's _csSyncFirebaseAndSheets (called by both csGenerateSettlement
// and csRecordPayment) and its realtime listener
// (initCoachSettlementFirebaseListener, already Super-Admin-gated via
// _csCanAccess() inside admin.html itself — nothing about that gate is
// duplicated or changed here) were already fully built to call
// window.syncCoachSettlementFirebase / window.listenCoachSettlements (via
// optional chaining, so it degraded gracefully while these were missing —
// see this file's own gap note in the FACTORY RESET comment below). This
// defines them for real, following the exact same pattern as the Finance/
// Café/Coaches/Students/Enquiries additions above.
//
// There is no deleteCoachSettlementFirebase — confirmed by inspecting
// admin.html that no delete function exists anywhere for this module
// (csGenerateSettlement creates, csRecordPayment appends a payment and
// updates status — a settlement is never removed), so none was added here.
//
// Path used: coachSettlements/{settlementId} — keyed by the settlement's
// own existing settlementId field (already this app's identifier for a
// settlement everywhere else). No new ID scheme is introduced.
// ============================================================================

/**
 * Create or update one coach settlement. Returns { success: true } or
 * { success: false, error }.
 */
window.syncCoachSettlementFirebase = async (data) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const settlementId = data && data.settlementId;
    if (!settlementId) return { success: false, error: 'Missing settlementId' };
    const ref = realtimeDb.ref(`coachSettlements/${settlementId}`);
    await ref.set({ ...data, settlementId, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true };
  } catch (err) {
    console.error('✗ [SYNC] syncCoachSettlementFirebase failed:', data && data.settlementId, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all coach settlements. callback receives an array
 * of settlement records (each with .settlementId). Returns an unsubscribe
 * function, or null if Firebase isn't initialized yet (onError is called
 * in that case).
 */
window.listenCoachSettlements = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('coachSettlements');
  const handler = (snapshot) => {
    const settlements = [];
    snapshot.forEach((child) => { settlements.push({ settlementId: child.key, ...child.val() }); });
    callback(settlements);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Coach Settlements listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// PENDING ENROLMENTS — REAL-TIME DATABASE (new)
// ----------------------------------------------------------------------------
// Two independent call sites already existed for this, both missing their
// Firebase functions (degrading gracefully — enroll.html guards with a
// typeof check, admin.html's initPendingEnrolmentsListener guards the
// same way), which is the actual root cause of "a new public enrolment
// doesn't appear until logout/login": the admin-side realtime listener
// never had anything to listen to, because nothing was writing new
// enrolments into Firebase in the first place — the Google Sheets
// submission (POST to ENROL_SHEET_URL in enroll.html) remains the
// unchanged, authoritative write; this file only adds the realtime
// transport layer on top of it, exactly as already designed:
//
//   enroll.html's _submitEnrolment() -> submitPendingEnrolmentFirebase()
//   admin.html's initPendingEnrolmentsListener() -> listenPendingEnrolments()
//
// enroll.html is a public, unauthenticated page — it can write here
// because initializeFirebase() (called on page load by enroll.html itself,
// unchanged) already performs an anonymous Firebase Auth sign-in as part
// of its existing init chain (see above), so no Firebase Rule change is
// needed for this to work under an auth-required rule.
//
// Path used: pending_enrolments/{requestId} — keyed by the request's own
// existing requestId (already generated client-side in enroll.html and
// used as the row identity in Google Sheets/admin.html everywhere else).
// No new ID scheme is introduced.
//
// BUG FIX — this was originally written as pendingEnrolments (camelCase),
// a path the live Security Rules don't specifically recognize, so an
// unauthenticated write from enroll.html fell back to the default
// auth-required rule and was rejected (confirmed live: "FIREBASE WARNING:
// set at /pendingEnrolments/... failed: permission_denied"). The correct,
// already-existing path is pending_enrolments (snake_case, with its own
// rule carve-out allowing the public form to write without logging in) —
// see admin.html's own PHASE 4.2 comment: "The Firebase Security Rule for
// /finance_expenses (same shape as /pending_enrolments)". No Rules change
// needed — the rule for this path already existed; only the path name
// used here was wrong.
//
// Deliberately NOT added here (out of scope for this specific bug —
// admin.html's approveEnrolment/confirmRejectEnrolment already guard
// these behind `window.getFirebaseStatus?.().fullyReady === true`, and
// getFirebaseStatus itself is also missing, so that condition is always
// false today and Approve/Reject already safely fall back to their
// original, working, non-Firebase behavior — adding these would touch a
// shared status function used by every other module's diagnostics/
// reconnect-watchdog, well beyond a Pending-Enrolment-only fix):
//   getFirebaseStatus, claimEnrolmentForApproval, releaseEnrolmentClaim,
//   finalizeEnrolmentApproval, rejectEnrolmentFirebase
// ============================================================================

/**
 * Submit one new pending enrolment (called from the public enroll.html,
 * anonymously authenticated). Returns { success: true, firebaseKey } or
 * { success: false, error } — enroll.html already treats failure here as
 * non-fatal (the Sheets POST right after this remains the real submission).
 */
window.submitPendingEnrolmentFirebase = async (payload) => {
  try {
    if (!realtimeDb || !firebaseFullyReady) return { success: false, error: 'Firebase not initialized' };
    const requestId = payload && payload.requestId;
    if (!requestId) return { success: false, error: 'Missing requestId' };
    const ref = realtimeDb.ref(`pending_enrolments/${requestId}`);
    await ref.set({ ...payload, status: 'pending', updatedAt: firebase.database.ServerValue.TIMESTAMP });
    return { success: true, firebaseKey: requestId };
  } catch (err) {
    console.error('✗ [SYNC] submitPendingEnrolmentFirebase failed:', payload && payload.requestId, err);
    return { success: false, error: err.message || String(err) };
  }
};

/**
 * Realtime listener for all pending enrolments. callback receives an
 * array of enrolment records (each with .requestId). Returns an
 * unsubscribe function, or null if Firebase isn't initialized yet
 * (onError is called in that case).
 */
window.listenPendingEnrolments = (callback, onError) => {
  if (!realtimeDb) { onError?.(new Error('Firebase not initialized')); return null; }
  const ref = realtimeDb.ref('pending_enrolments');
  const handler = (snapshot) => {
    const enrolments = [];
    snapshot.forEach((child) => { enrolments.push({ requestId: child.key, ...child.val() }); });
    callback(enrolments);
  };
  const errorHandler = (error) => {
    console.error('✗ [SYNC] Pending Enrolments listener error:', error);
    onError?.(error);
  };
  ref.on('value', handler, errorHandler);
  return () => ref.off('value', handler);
};

// ============================================================================
// FACTORY RESET (used by Settings → Danger Zone → Reset All Data)
// ============================================================================

/**
 * Wipes EVERY top-level node under the Realtime Database root.
 *
 * Deliberately schema-agnostic (reads whatever keys actually exist at
 * root and deletes each one) rather than hardcoding a list of node names
 * like 'students'/'fees'/'coaches'/'bookingRequests' — this file doesn't
 * define every listener admin.html calls (e.g. listenStudents, listenFees,
 * listenCoaches, listenDueAdjustments, listenBookingRequests,
 * listenFinanceExpenses, listenCoachSettlements all reference RTDB paths
 * that live in a fuller version of this file than what's here), so a
 * generic root wipe is the only way to guarantee this actually clears
 * everything regardless of the exact path names those listeners use.
 *
 * Returns which top-level keys were found and cleared, so the caller can
 * show the admin exactly what happened.
 */
window.factoryResetRealtimeDatabase = async () => {
  try {
    if (!realtimeDb) return { ok: false, error: 'Realtime Database not initialized' };

    const rootSnap = await realtimeDb.ref('/').once('value');
    const topLevelKeys = [];
    rootSnap.forEach((child) => { topLevelKeys.push(child.key); return false; });

    if (topLevelKeys.length === 0) {
      console.log('✓ Realtime Database factory reset — nothing to clear, already empty');
      return { ok: true, cleared: [] };
    }

    // A single multi-path update (each path set to null) removes every
    // node in one round trip instead of N separate .remove() calls.
    const updates = {};
    topLevelKeys.forEach((key) => { updates['/' + key] = null; });
    await realtimeDb.ref('/').update(updates);

    console.log('✓ Realtime Database factory reset — cleared:', topLevelKeys.join(', '));
    return { ok: true, cleared: topLevelKeys };
  } catch (error) {
    console.error('✗ Realtime Database factory reset failed:', error);
    return { ok: false, error: error.message };
  }
};

/**
 * Deletes every document in each given Firestore collection.
 * Defaults to just ['fees'] — the only Firestore collection this file
 * knows about. If the real app has migrated more collections to
 * Firestore since this snapshot of firebase.js, pass their names too,
 * e.g. window.factoryResetFirestore(['fees', 'students']).
 *
 * Batches deletes in groups of 400 to stay comfortably under Firestore's
 * 500-operation-per-batch limit.
 */
window.factoryResetFirestore = async (collections) => {
  collections = collections || ['fees'];
  if (!firestoreDb) return { ok: false, error: 'Firestore not initialized' };

  const results = {};
  for (const colName of collections) {
    try {
      const snap = await firestoreDb.collection(colName).get();
      const BATCH_SIZE = 400;
      let deleted = 0;
      let batch = firestoreDb.batch();
      let opsInBatch = 0;

      for (const doc of snap.docs) {
        batch.delete(doc.ref);
        opsInBatch++;
        deleted++;
        if (opsInBatch >= BATCH_SIZE) {
          await batch.commit();
          batch = firestoreDb.batch();
          opsInBatch = 0;
        }
      }
      if (opsInBatch > 0) await batch.commit();

      results[colName] = { ok: true, deleted };
      console.log(`✓ Firestore collection "${colName}" factory reset — ${deleted} document(s) deleted`);
    } catch (error) {
      results[colName] = { ok: false, error: error.message };
      console.error(`✗ Firestore collection "${colName}" factory reset failed:`, error);
    }
  }

  return { ok: Object.values(results).every((r) => r.ok), results };
};

// ============================================================================
// DIAGNOSTICS (same as before)
// ============================================================================
window._ddtzDiag = {
  events: [],
  notifications: { toastCount: 0, voiceCount: 0, bellCount: 0, lastToast: null, lastVoice: null, lastBell: null },
  writeLatencies: [],
  backgroundSync: {},
  reads: 0,
  writes: 0,
  sheetsWrites: 0,
  sheetsFailures: 0,
  sheetsLatencies: [],
  duplicatePreventions: 0,
  errors: [],
  warnings: [],
  moduleActivity: {},
  lastQueueLength: 0,
  hasEverConnected: false,
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
    this.lastQueueLength = 0;
    this.notifications = { toastCount: 0, voiceCount: 0, bellCount: 0, lastToast: null, lastVoice: null, lastBell: null };
  }
};

(function _diagWrapConsole() {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args) => { window._ddtzDiag.recordConsole('error', args); originalError(...args); };
  console.warn = (...args) => { window._ddtzDiag.recordConsole('warning', args); originalWarn(...args); };
})();

console.log('✓ Firebase Module (Realtime DB + Firestore) Loaded');
