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
    firestoreDb = firebase.firestore(firebaseApp);
    console.log('✓ Firebase Firestore initialized');

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
 */
function _updateConnectionIndicator() {
  const indicator = document.getElementById('connection-indicator');
  if (!indicator) return;

  if (connectionStatus === 'connected') {
    indicator.style.background = 'var(--green, #0F7A45)';
    indicator.title = 'Firebase connected';
  } else if (connectionStatus === 'disconnected') {
    indicator.style.background = 'var(--red, #ef4444)';
    indicator.title = lastFirebaseError || 'Firebase disconnected';
  } else {
    indicator.style.background = 'var(--yellow, #eab308)';
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
    return { ok: true, receiptNo: receiptNo, message: 'Fee saved successfully' };
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
