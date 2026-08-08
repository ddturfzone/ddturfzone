/**
 * DD TURF ZONE — CAFÉ FIREBASE ADDITION
 * =====================================================================
 * DO NOT USE THIS FILE AS A REPLACEMENT FOR firebase.js.
 *
 * This is a small, self-contained block of NEW functions only. Open your
 * REAL, LIVE firebase.js and PASTE this entire block into it — for
 * example just above the "FACTORY RESET" section near the bottom of the
 * file. Do not delete, rename, reorder, or otherwise touch anything else
 * already in firebase.js. Every existing function (Firestore Fees,
 * listenLiveAvailability, publishAvailabilityRecord, the factory-reset
 * functions, initializeFirebase, connection monitoring, diagnostics,
 * every listener admin.html already relies on) must remain exactly as it
 * is today.
 *
 * WHAT THIS ADDS
 * ---------------------------------------------------------------------
 * Five new functions, mirroring the exact same Realtime Database
 * read/write pattern this file already uses for Live Availability
 * (realtimeDb.ref(...).set()/.remove()/.on('value', ...)), so there is
 * nothing structurally new here — same guards, same error handling,
 * same return shape used by admin.html's existing Firebase-first saves
 * (e.g. window.syncCoachFirebase / window.deleteCoachFirebase):
 *
 *   window.listenCafeItems(callback, onError)     — realtime listener
 *   window.saveCafeItemFirebase(id, data)         — create/update one item
 *   window.deleteCafeItemFirebase(id)             — remove one item
 *   window.listenCafeSales(callback, onError)     — realtime listener
 *   window.saveCafeSaleFirebase(id, data)         — create one sale line
 *
 * Realtime Database paths used (both brand-new nodes — nothing existing
 * lives under these paths today, confirmed against the current
 * firebase.js, so there is no collision with any existing data):
 *
 *   cafeItems/{id}
 *   cafeSales/{id}
 *
 * There is intentionally no deleteCafeSaleFirebase — Café Sales are
 * append-only everywhere else in this app (no deleteCafeSale function
 * exists in admin.html either), so none was added here.
 * =====================================================================
 */

// ============================================================================
// CAFÉ — REAL-TIME DATABASE (new — Café Items + Café Sales)
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
