/**
 * DD Turf Zone - Fee Handling Functions (Updated for Firestore)
 * 
 * Copy these functions into your admin.html to replace old Google Sheets-based fee handling
 * Make sure firebase.js is loaded BEFORE these functions
 */

// ============================================================================
// FEE DATA MANAGEMENT (Firestore)
// ============================================================================

/**
 * Load all fees from Firestore on page init
 * Call this once when admin panel loads
 */
window.loadFeesData = async () => {
  try {
    console.log('📥 Loading fees from Firestore...');
    const result = await window.getAllFeesFromFirestore();
    
    if (result.ok) {
      window.DB.fees = result.fees || [];
      console.log(`✓ Loaded ${result.fees.length} fees from Firestore`);
      window._ddtzDiag?.recordEvent('fees', 'load_success');
      return result;
    } else {
      console.error('✗ Failed to load fees:', result.error);
      window._ddtzDiag?.recordEvent('fees', 'load_failed');
      showToast('Failed to load fees: ' + result.error, 'error');
      return result;
    }
  } catch (error) {
    console.error('✗ Load fees error:', error);
    showToast('Error loading fees: ' + error.message, 'error');
    return { ok: false, error: error.message };
  }
};

/**
 * Create a new fee in Firestore
 * Generates receipt number automatically
 */
window.createFee = async (feeData) => {
  try {
    // Generate receipt number if not provided
    const receiptNo = feeData.receiptNo || window.generateNextReceiptNumber?.();
    if (!receiptNo) {
      showToast('Failed to generate receipt number', 'error');
      return { ok: false, error: 'Receipt number generation failed' };
    }

    console.log(`💾 Saving new fee: ${receiptNo}`);
    
    const result = await window.saveFeeToFirestore(receiptNo, {
      ...feeData,
      receiptNo: receiptNo,
      createdAt: new Date().toISOString(),
      createdBy: window.currentUser?.name || 'System'
    });

    if (result.ok) {
      console.log('✓ Fee saved:', result.receiptNo);
      showToast(`Fee ${result.receiptNo} created ✓`, 'success');
      
      // Reload fees list
      await window.loadFeesData?.();
      
      // Log activity
      window._ddtzDiag?.recordEvent('fees', 'create_success');
      window._ddtzDiag?.recordModuleActivity('fees', `created ${result.receiptNo}`, window.currentUser?.name);
      
      return result;
    } else {
      console.error('✗ Failed to save fee:', result.error);
      showToast('Error saving fee: ' + result.error, 'error');
      window._ddtzDiag?.recordEvent('fees', 'create_failed');
      return result;
    }
  } catch (error) {
    console.error('✗ Create fee error:', error);
    showToast('Error: ' + error.message, 'error');
    return { ok: false, error: error.message };
  }
};

/**
 * Update an existing fee in Firestore
 */
window.updateFee = async (receiptNo, updateData) => {
  try {
    if (!receiptNo) {
      showToast('Receipt number is required', 'error');
      return { ok: false, error: 'Receipt number required' };
    }

    console.log(`🔄 Updating fee: ${receiptNo}`);
    
    const result = await window.updateFeeInFirestore(receiptNo, {
      ...updateData,
      updatedAt: new Date().toISOString()
    });

    if (result.ok) {
      console.log('✓ Fee updated:', result.receiptNo);
      showToast(`Fee ${result.receiptNo} updated ✓`, 'success');
      
      // Reload fees list
      await window.loadFeesData?.();
      
      // Log activity
      window._ddtzDiag?.recordEvent('fees', 'update_success');
      window._ddtzDiag?.recordModuleActivity('fees', `updated ${result.receiptNo}`, window.currentUser?.name);
      
      return result;
    } else {
      console.error('✗ Failed to update fee:', result.error);
      showToast('Error updating fee: ' + result.error, 'error');
      window._ddtzDiag?.recordEvent('fees', 'update_failed');
      return result;
    }
  } catch (error) {
    console.error('✗ Update fee error:', error);
    showToast('Error: ' + error.message, 'error');
    return { ok: false, error: error.message };
  }
};

/**
 * Record a fee payment (marks amount as received)
 */
window.recordFeePayment = async (receiptNo, amountReceived, paymentMethod = 'Cash') => {
  try {
    if (!receiptNo) {
      showToast('Receipt number is required', 'error');
      return { ok: false };
    }

    console.log(`💰 Recording payment: ${receiptNo} - ${amountReceived}`);

    const result = await window.updateFeeInFirestore(receiptNo, {
      amountReceived: Number(amountReceived) || 0,
      paymentMethod: paymentMethod,
      status: 'paid',
      updatedAt: new Date().toISOString()
    });

    if (result.ok) {
      showToast(`Payment recorded for ${receiptNo} ✓`, 'success');
      await window.loadFeesData?.();
      window._ddtzDiag?.recordModuleActivity('fees', `payment received ${receiptNo}`, window.currentUser?.name);
      return result;
    } else {
      showToast('Error recording payment: ' + result.error, 'error');
      return result;
    }
  } catch (error) {
    console.error('✗ Record payment error:', error);
    showToast('Error: ' + error.message, 'error');
    return { ok: false, error: error.message };
  }
};

/**
 * Delete/soft-delete a fee from Firestore
 */
window.deleteFee = async (receiptNo) => {
  try {
    if (!receiptNo) {
      showToast('Receipt number is required', 'error');
      return { ok: false };
    }

    if (!confirm(`Delete fee ${receiptNo}? This cannot be undone.`)) {
      return { ok: false, error: 'Cancelled' };
    }

    console.log(`🗑️ Deleting fee: ${receiptNo}`);
    
    const result = await window.deleteFeeFromFirestore(receiptNo);

    if (result.ok) {
      console.log('✓ Fee deleted:', result.receiptNo);
      showToast(`Fee ${result.receiptNo} deleted ✓`, 'success');
      
      // Reload fees list
      await window.loadFeesData?.();
      
      // Log activity
      window._ddtzDiag?.recordEvent('fees', 'delete_success');
      window._ddtzDiag?.recordModuleActivity('fees', `deleted ${result.receiptNo}`, window.currentUser?.name);
      
      return result;
    } else {
      console.error('✗ Failed to delete fee:', result.error);
      showToast('Error deleting fee: ' + result.error, 'error');
      window._ddtzDiag?.recordEvent('fees', 'delete_failed');
      return result;
    }
  } catch (error) {
    console.error('✗ Delete fee error:', error);
    showToast('Error: ' + error.message, 'error');
    return { ok: false, error: error.message };
  }
};

// ============================================================================
// REAL-TIME SYNC (Optional - for live updates)
// ============================================================================

/**
 * Start listening to fees collection for real-time updates
 * Optional: Call this after loadFeesData() if you want live sync
 */
window.startRealTimeFeesSync = () => {
  try {
    console.log('🔄 Starting real-time fees sync...');
    
    const unsubscribe = window.listenToFeesRealtime(
      (fees) => {
        console.log(`✓ Real-time update: ${fees.length} active fees`);
        window.DB.fees = fees;
        window._ddtzDiag?.recordEvent('fees', 'realtime_update');
        
        // Optional: Re-render fee list UI
        // window.renderFeesList?.();
      },
      (error) => {
        console.error('✗ Real-time fees sync failed:', error);
        showToast('Real-time sync error: ' + error.message, 'warn');
        window._ddtzDiag?.recordEvent('fees', 'realtime_error');
        
        // Fall back to periodic reload
        console.log('⏰ Falling back to periodic reload (30s interval)');
        window._feesSyncInterval = setInterval(
          () => window.loadFeesData?.(),
          30000 // Reload every 30 seconds
        );
      }
    );

    window._feesUnsubscribe = unsubscribe;
    console.log('✓ Real-time sync started');
    return { ok: true };
  } catch (error) {
    console.error('✗ Start real-time sync error:', error);
    return { ok: false, error: error.message };
  }
};

/**
 * Stop listening to real-time updates (cleanup)
 */
window.stopRealTimeFeesSync = () => {
  try {
    if (window._feesUnsubscribe && typeof window._feesUnsubscribe === 'function') {
      window._feesUnsubscribe();
      console.log('✓ Real-time sync stopped');
    }
    if (window._feesSyncInterval) {
      clearInterval(window._feesSyncInterval);
      console.log('✓ Periodic sync stopped');
    }
  } catch (error) {
    console.error('✗ Stop sync error:', error);
  }
};

// ============================================================================
// BACKUP TO GOOGLE SHEETS (Optional)
// ============================================================================

/**
 * Backup all Firestore fees to Google Sheets
 * Useful for historical records and disaster recovery
 * 
 * Call this periodically or on-demand:
 * - On button click from admin panel
 * - On a schedule (e.g., daily at midnight)
 * - Before/after major changes
 */
window.backupFeesToSheets = async () => {
  try {
    if (!window.DB.fees || window.DB.fees.length === 0) {
      showToast('No fees to backup', 'info');
      return { ok: false, error: 'No fees' };
    }

    console.log('📊 Backing up fees to Google Sheets...');
    showToast('Backing up fees... please wait', 'info');

    const response = await fetch(PRODUCTION_APPS_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({
        type: 'backupFeesToSheets',
        action: 'backup',
        fees: window.DB.fees
      })
    });

    const result = await response.json();

    if (result.ok) {
      console.log(`✓ Backup successful: ${result.created} created, ${result.updated} updated`);
      showToast(
        `✓ Backed up ${result.total} fees (${result.created} new, ${result.updated} updated)`,
        'success'
      );
      window._ddtzDiag?.recordEvent('fees', 'backup_success');
      return result;
    } else {
      console.error('✗ Backup failed:', result.error);
      showToast('Backup failed: ' + result.error, 'error');
      window._ddtzDiag?.recordEvent('fees', 'backup_failed');
      return result;
    }
  } catch (error) {
    console.error('✗ Backup error:', error);
    showToast('Backup error: ' + error.message, 'error');
    window._ddtzDiag?.recordEvent('fees', 'backup_error');
    return { ok: false, error: error.message };
  }
};

/**
 * Schedule automatic backups (optional)
 * Run this on admin panel load to backup every X minutes
 */
window.scheduleAutoBackup = (intervalMinutes = 60) => {
  if (window._autoBackupInterval) {
    console.warn('Auto-backup already scheduled');
    return;
  }

  console.log(`⏰ Scheduling auto-backup every ${intervalMinutes} minutes`);
  
  window._autoBackupInterval = setInterval(
    () => {
      console.log('🔄 Running scheduled backup...');
      window.backupFeesToSheets?.();
    },
    intervalMinutes * 60 * 1000
  );

  // Also backup on page unload
  window.addEventListener('beforeunload', () => {
    window.backupFeesToSheets?.();
  });

  console.log('✓ Auto-backup scheduled');
};

/**
 * Stop automatic backups
 */
window.stopAutoBackup = () => {
  if (window._autoBackupInterval) {
    clearInterval(window._autoBackupInterval);
    window._autoBackupInterval = null;
    console.log('✓ Auto-backup stopped');
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get a specific fee by receipt number
 */
window.getFeeByReceiptNo = (receiptNo) => {
  return (window.DB.fees || []).find(f => f.receiptNo === receiptNo);
};

/**
 * Get all fees for a specific student
 */
window.getStudentFees = (studentId) => {
  return (window.DB.fees || []).filter(f => f.studentId === studentId);
};

/**
 * Get fees by status (active, paid, pending, deleted, etc)
 */
window.getFeesByStatus = (status) => {
  return (window.DB.fees || []).filter(f => f.status === status);
};

/**
 * Calculate total amount payable
 */
window.getTotalAmountPayable = () => {
  return (window.DB.fees || []).reduce((sum, f) => {
    if (f.status !== 'deleted') {
      sum += Number(f.amountPayable || 0);
    }
    return sum;
  }, 0);
};

/**
 * Calculate total amount received
 */
window.getTotalAmountReceived = () => {
  return (window.DB.fees || []).reduce((sum, f) => {
    if (f.status !== 'deleted') {
      sum += Number(f.amountReceived || 0);
    }
    return sum;
  }, 0);
};

/**
 * Calculate total pending amount
 */
window.getTotalPending = () => {
  return (window.DB.fees || []).reduce((sum, f) => {
    if (f.status !== 'deleted') {
      sum += Number(f.pending || 0);
    }
    return sum;
  }, 0);
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize fees module on admin panel load
 * Call this from your main admin page load function
 */
window.initializeFeesModule = async () => {
  try {
    console.log('🚀 Initializing Fees Module...');

    // 1. Load all fees from Firestore
    await window.loadFeesData?.();

    // 2. Optionally start real-time sync
    // Uncomment the line below if you want live updates
    // window.startRealTimeFeesSync?.();

    // 3. Optionally schedule auto-backup to Google Sheets
    // Uncomment the line below to backup every 60 minutes
    // window.scheduleAutoBackup?.(60);

    console.log('✓ Fees Module initialized');
    return { ok: true };
  } catch (error) {
    console.error('✗ Fees module initialization failed:', error);
    showToast('Failed to initialize fees: ' + error.message, 'error');
    return { ok: false, error: error.message };
  }
};

console.log('✓ Fee Handling Functions Loaded (Firestore Primary)');
