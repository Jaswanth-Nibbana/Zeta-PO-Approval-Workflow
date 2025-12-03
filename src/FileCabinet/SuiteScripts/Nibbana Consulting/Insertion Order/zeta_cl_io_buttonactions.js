/**
 * @NApiVersion 2.1
 * @description Button action functions for Insertion Order approval workflow
 */

define(['N/currentRecord', 'N/record', 'N/ui/dialog', './zeta_lib_io_utils'], 
function(currentRecord, record, dialog, ioUtils) {

    /**
     * Submit for Review button handler
     */
    function submitForReview() {
        try {
            const currentRec = currentRecord.get();
            const recordId = currentRec.id;
            
            const rec = record.load({
                type: ioUtils.RECORD_TYPE,
                id: recordId
            });

            // Get IO total and SF total
            const ioTotal = rec.getValue('custrecord_zeta_io_ordertotal');
            const sfTotal = rec.getValue('custrecord_zeta_io_sfopportunitytotal');

            // Compare totals
            if (ioTotal !== sfTotal) {
                dialog.alert({
                    title: 'Totals Mismatch',
                    message: 'IO Total and SalesForce Total must be equal to proceed with review.'
                });
            }else{
                rec.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW);
                rec.save();
                window.location.reload();
            }
            
        } catch (error) {
            console.error('Error in submitForReview:', error);
            dialog.alert({
                title: 'Error',
                message: 'An error occurred while submitting for review: ' + error.message
            });
        }
    }

    /**
     * Mark as Reviewed button handler
     */
    function markAsReviewed() {
        try {
            const currentRec = currentRecord.get();
            const recordId = currentRec.id;
            
            const rec = record.load({
                type: ioUtils.RECORD_TYPE,
                id: recordId
            });

            // Get IO total and SF total
            const ioTotal = rec.getValue(ioUtils.FIELDS.IO_TOTAL);
            const sfTotal = rec.getValue(ioUtils.FIELDS.SALESFORCE_OPPORTUNITY_TOTAL);

            // Compare totals
            if (ioTotal !== sfTotal) {
                dialog.alert({
                    title: 'Totals Mismatch',
                    message: 'IO Total and SalesForce Total must be equal to proceed with review.'
                });
            }else{
                rec.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL);
                rec.save();
                window.location.reload();
            }
            
        } catch (error) {
            console.error('Error in markAsReviewed:', error);
            dialog.alert({
                title: 'Error',
                message: 'An error occurred while marking as reviewed: ' + error.message
            });
        }
    }

    /**
     * Approve IO button handler
     */
    function approveIO() {
        try {
            const currentRec = currentRecord.get();
            const recordId = currentRec.id;
            
            const rec = record.load({
                type: ioUtils.RECORD_TYPE,
                id: recordId
            });

            // Get IO total and SF total
            const ioTotal = rec.getValue('custrecord_zeta_io_ordertotal');
            const sfTotal = rec.getValue('custrecord_zeta_io_sfopportunitytotal');

            // Compare totals
            if (ioTotal !== sfTotal) {
                dialog.alert({
                    title: 'Totals Mismatch',
                    message: 'IO Total and SalesForce Total must be equal to proceed with review.'
                });
            }else{
                rec.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.APPROVED);
                rec.save();
                window.location.reload();
            }
            
        } catch (error) {
            console.error('Error in approveIO:', error);
            dialog.alert({
                title: 'Error',
                message: 'An error occurred while approving: ' + error.message
            });
        }
    }

    /**
     * Reject IO button handler
     */
    function rejectIO() {
        try {
            const currentRec = currentRecord.get();
            const recordId = currentRec.id;
            
            // Function to prompt for reject reason with validation loop
            function getRejectReason() {
                let rejectReason = null;
                let attempts = 0;
                const maxAttempts = 3;
                
                while (attempts < maxAttempts) {
                    rejectReason = prompt('Please enter the reason for rejection (required):');
                    
                    // User cancelled
                    if (rejectReason === null) {
                        return null;
                    }
                    
                    // Validate the reason
                    if (rejectReason && rejectReason.trim() !== '') {
                        const trimmedReason = rejectReason.trim();
                        // Check minimum length
                        if (trimmedReason.length >= 5) {
                            return trimmedReason;
                        } else {
                            alert('Reject reason must be at least 5 characters long. Please provide a meaningful reason for rejection.');
                            continue; // Continue the loop to ask again
                        }
                    }
                    
                    attempts++;
                    
                    // Show different messages based on attempt
                    if (attempts < maxAttempts) {
                        alert('Reject reason is mandatory. Please provide a valid reason for rejection.');
                    } else {
                        alert('Reject reason is required. Rejection cancelled after ' + maxAttempts + ' attempts.');
                        return null;
                    }
                }
                
                return null;
            }
            
            // Get reject reason with validation
            const rejectReason = getRejectReason();
            
            // If user provided a valid reason, proceed with rejection
            if (rejectReason) {
                const rec = record.load({
                    type: ioUtils.RECORD_TYPE,
                    id: recordId
                });
                
                rec.setValue(ioUtils.FIELDS.REJECT_REASON, rejectReason);
                rec.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.REJECTED);
                rec.save();
                window.location.reload();
            }
            // If rejectReason is null, user cancelled or failed validation - do nothing
            
        } catch (error) {
            console.error('Error in rejectIO:', error);
            dialog.alert({
                title: 'Error',
                message: 'An error occurred while rejecting: ' + error.message
            });
        }
    }

    /**
     * Resubmit IO button handler
     */
    function resubmitIO() {
        try {
            const currentRec = currentRecord.get();
            const recordId = currentRec.id;
            
            const rec = record.load({
                type: ioUtils.RECORD_TYPE,
                id: recordId
            });
            
            // Clear reject reason and set status back to submitted for review
            rec.setValue(ioUtils.FIELDS.REJECT_REASON, '');
            rec.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW);
            rec.save();
            window.location.reload();
            
        } catch (error) {
            console.error('Error in resubmitIO:', error);
            dialog.alert({
                title: 'Error',
                message: 'An error occurred while resubmitting: ' + error.message
            });
        }
    }

    /**
     * Override IO budget button handler
     */
    function overrideIO() {
        try {
            const currentRec = currentRecord.get();
            const recordId = currentRec.id;
            
            // Function to get override details with validation
            function getOverrideDetails() {
                let overrideAmount = null;
                let overrideReason = null;
                let attempts = 0;
                const maxAttempts = 3;
                
                // Get override amount
                while (attempts < maxAttempts) {
                    const amountInput = prompt('Enter override amount (additional budget):');
                    
                    // User cancelled
                    if (amountInput === null) {
                        return null;
                    }
                    
                    // Validate amount
                    const amount = parseFloat(amountInput);
                    if (!isNaN(amount) && amount > 0) {
                        overrideAmount = amount;
                        break;
                    }
                    
                    attempts++;
                    if (attempts < maxAttempts) {
                        alert('Please enter a valid positive amount.');
                    } else {
                        alert('Invalid amount entered. Override cancelled.');
                        return null;
                    }
                }
                
                // Reset attempts for reason validation
                attempts = 0;
                
                // Get override reason
                while (attempts < maxAttempts) {
                    overrideReason = prompt('Enter reason for override (required):');
                    
                    // User cancelled
                    if (overrideReason === null) {
                        return null;
                    }
                    
                    // Validate reason
                    if (overrideReason && overrideReason.trim() !== '') {
                        const trimmedReason = overrideReason.trim();
                        if (trimmedReason.length >= 5) {
                            return {
                                amount: overrideAmount,
                                reason: trimmedReason
                            };
                        } else {
                            alert('Override reason must be at least 5 characters long.');
                            attempts++;
                            continue;
                        }
                    }
                    
                    attempts++;
                    if (attempts < maxAttempts) {
                        alert('Override reason is mandatory.');
                    } else {
                        alert('Override reason is required. Override cancelled.');
                        return null;
                    }
                }
                
                return null;
            }
            
            // Get override details
            const overrideDetails = getOverrideDetails();
            
            if (overrideDetails) {
                const rec = record.load({
                    type: ioUtils.RECORD_TYPE,
                    id: recordId
                });
                
                // Set override fields
                rec.setValue(ioUtils.FIELDS.OVERRIDE_ACTIVE, true);
                rec.setValue(ioUtils.FIELDS.OVERRIDE_AMOUNT, overrideDetails.amount);
                rec.setValue(ioUtils.FIELDS.OVERRIDE_REASON, overrideDetails.reason);
                rec.setValue(ioUtils.FIELDS.OVERRIDE_START_DATE, new Date());
                rec.setValue(ioUtils.FIELDS.OVERRIDE_END_DATE, ''); // Clear end date
                rec.setValue(ioUtils.FIELDS.OVERRIDE_USER, ioUtils.getCurrentUserId());
                
                rec.save();
                
                dialog.alert({
                    title: 'Override Activated',
                    message: 'Budget override of $' + overrideDetails.amount + ' has been activated successfully.'
                }).then(function() {
                    window.location.reload();
                });
            }
            
        } catch (error) {
            console.error('Error in overrideIO:', error);
            dialog.alert({
                title: 'Error',
                message: 'An error occurred while activating override: ' + error.message
            });
        }
    }

    /**
     * Revoke Override button handler
     */
    function revokeOverride() {
        try {
            const currentRec = currentRecord.get();
            const recordId = currentRec.id;
            
            // Confirm revocation
            dialog.confirm({
                title: 'Revoke Override',
                message: 'Are you sure you want to revoke the active budget override?'
            }).then(function(result) {
                if (result) {
                    const rec = record.load({
                        type: ioUtils.RECORD_TYPE,
                        id: recordId
                    });
                    
                    // Clear override fields
                    rec.setValue(ioUtils.FIELDS.OVERRIDE_ACTIVE, false);
                    rec.setValue(ioUtils.FIELDS.OVERRIDE_AMOUNT, '');
                    rec.setValue(ioUtils.FIELDS.OVERRIDE_REASON, '');
                    rec.setValue(ioUtils.FIELDS.OVERRIDE_END_DATE, new Date());
                    rec.setValue(ioUtils.FIELDS.OVERRIDE_USER, ioUtils.getCurrentUserId());
                    
                    rec.save();
                    
                    dialog.alert({
                        title: 'Override Revoked',
                        message: 'Budget override has been revoked successfully.'
                    }).then(function() {
                        window.location.reload();
                    });
                }
            }).catch(function(error) {
                console.error('Error in confirmation dialog:', error);
            });
            
        } catch (error) {
            console.error('Error in revokeOverride:', error);
            dialog.alert({
                title: 'Error',
                message: 'An error occurred while revoking override: ' + error.message
            });
        }
    }

    // Make functions globally accessible for button clicks (NetSuite requirement)
    if (typeof window !== 'undefined') {
        window.submitForReview = submitForReview;
        window.markAsReviewed = markAsReviewed;
        window.approveIO = approveIO;
        window.rejectIO = rejectIO;
        window.resubmitIO = resubmitIO;
        window.overrideIO = overrideIO;
        window.revokeOverride = revokeOverride;
    }

    return {
        submitForReview: submitForReview,
        markAsReviewed: markAsReviewed,
        approveIO: approveIO,
        rejectIO: rejectIO,
        resubmitIO: resubmitIO,
        overrideIO: overrideIO,
        revokeOverride: revokeOverride
    };
});
