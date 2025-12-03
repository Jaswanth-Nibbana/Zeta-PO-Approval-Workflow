/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @description User Event Script for Insertion Order approval workflow
 */

define(['N/log', 'N/record', 'N/runtime', 'N/ui/serverWidget', 'N/search', './zeta_lib_io_utils'],
    function (log, record, runtime, serverWidget, search, ioUtils) {

        /**
         * Calculate order total from all IO line items (from newRecord, not search)
         * @param {Object} newRecord - The current record object in beforeSubmit
         * @returns {number} Total amount from all line items
         */
        function calculateOrderTotal(newRecord) {
            try {
                let totalAmount = 0;
                const lineCount = newRecord.getLineCount({ sublistId: 'recmachcustrecord_zeta_ioi_insertionorder' });
                for (let i = 0; i < lineCount; i++) {
                    totalAmount += parseFloat(newRecord.getSublistValue({
                        sublistId: 'recmachcustrecord_zeta_ioi_insertionorder',
                        fieldId: 'custrecord_zeta_ioi_amount',
                        line: i
                    }) || 0);
                }
                log.debug('calculateOrderTotal', `Calculated total: ${totalAmount} from ${lineCount} items`);
                return totalAmount;
            } catch (error) {
                log.error('calculateOrderTotal', `Error calculating order total: ${error.message}`);
                return 0;
            }
        }

        /**
         * Get status HTML for inline display
         * @param {string} status - Current approval status
         * @returns {string} HTML string for status display
         */
        function getStatusHTML(status) {
            const statusConfig = {
                '1': {
                    label: '📝 DRAFT',
                    bgColor: '#f8f9fa',
                    borderColor: '#6c757d',
                    textColor: '#6c757d'
                },
                '2': {
                    label: '⏳ SUBMITTED FOR REVIEW',
                    bgColor: '#fff3cd',
                    borderColor: '#ffc107',
                    textColor: '#856404'
                },
                '3': {
                    label: '👀 REVIEWED - PENDING APPROVAL',
                    bgColor: '#cce5ff',
                    borderColor: '#007bff',
                    textColor: '#004085'
                },
                '4': {
                    label: '✅ APPROVED',
                    bgColor: '#d4edda',
                    borderColor: '#28a745',
                    textColor: '#155724'
                },
                '5': {
                    label: '❌ REJECTED',
                    bgColor: '#f8d7da',
                    borderColor: '#dc3545',
                    textColor: '#721c24'
                }
            };

            const config = statusConfig[status] || {
                label: '❓ UNKNOWN STATUS',
                bgColor: '#e2e3e5',
                borderColor: '#6c757d',
                textColor: '#495057'
            };

            return `<div style="background-color:${config.bgColor}; border-left:4px solid ${config.borderColor}; padding:8px 12px; margin:4px 0; border-radius:3px; box-shadow:0 1px 3px rgba(0,0,0,0.1); max-width:400px; display:inline-block;">
            <span style="color:${config.textColor}; font-size:16px; font-weight:bold; text-transform:uppercase; letter-spacing:0.5px;">${config.label}</span>
        </div>`;
        }

        /**
         * Get the sum of total amounts for invoices linked to this IO
         * @param {number|string} ioId - Internal ID of the IO
         * @param {Object} search - N/search module
         * @returns {number} Sum of invoice totals
         */
        function getLinkedInvoicesTotal(ioId, search) {
            try {
                var invoiceSearch = search.create({
                    type: 'invoice',
                    filters: [
                        ['custbody_zeta_io_insertionorder', 'is', ioId],
                        'AND',
                        ['mainline', 'is', 'T']
                    ],
                    columns: [
                        search.createColumn({ name: 'total' })
                    ]
                });

                var invoiceResults = invoiceSearch.run().getRange({ start: 0, end: 100 });
                var invoiceTotalSum = 0;
                if (invoiceResults && invoiceResults.length > 0) {
                    for (var i = 0; i < invoiceResults.length; i++) {
                        invoiceTotalSum += parseFloat(invoiceResults[i].getValue({ name: 'total' }) || 0);
                    }
                }
                log.debug('getLinkedInvoicesTotal', `Total of linked Invoices: ${invoiceTotalSum}`);
                return invoiceTotalSum;
            } catch (error) {
                log.error('getLinkedInvoicesTotal', `Error calculating invoice total: ${error.message}`);
                return 0;
            }
        }

        /**
         * Before Load function
         * @param {Object} context
         */
        function beforeLoad(context) {
            try {
                const form = context.form;
                const newRecord = context.newRecord;
                const type = context.type;

                const recordId = newRecord.id;
                const currentUserId = ioUtils.getCurrentUserId();
                const currentUserRole = ioUtils.getCurrentUserRole();
                const currentStatus = newRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                // Remove Edit button for AR Manager
                if (currentUserRole === ioUtils.ROLES.AR_MANAGER) {
                    form.removeButton('edit');
                    log.debug('beforeLoad', 'Removed Edit button for AR Manager');
                }

                if (type === context.UserEventType.COPY) {
                    // Set default status to Draft on copy
                    newRecord.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.DRAFT);
                    newRecord.setValue('owner', ioUtils.getCurrentUserId());
                    newRecord.setValue(ioUtils.FIELDS.REVIEWED_BY, '');
                    newRecord.setValue(ioUtils.FIELDS.APPROVED_BY, '');
                    newRecord.setValue(ioUtils.FIELDS.REJECT_REASON, '');
                    newRecord.setValue(ioUtils.FIELDS.CLOSED, '');
                    newRecord.setValue(ioUtils.FIELDS.CLOSE_REASON, '');
                    newRecord.setValue(ioUtils.FIELDS.OVERRIDE_ACTIVE, false);
                    newRecord.setValue(ioUtils.FIELDS.OVERRIDE_AMOUNT, '');
                    newRecord.setValue(ioUtils.FIELDS.OVERRIDE_REASON, '');
                    newRecord.setValue(ioUtils.FIELDS.OVERRIDE_START_DATE, '');
                    newRecord.setValue(ioUtils.FIELDS.OVERRIDE_END_DATE, '');
                    newRecord.setValue(ioUtils.FIELDS.OVERRIDE_USER, '');
                    newRecord.setValue('custrecord_zeta_io_sfopportunitytotal', '');
                    newRecord.setValue('custrecord_zeta_io_ordertotal', '');
                    newRecord.setValue('custrecord_zeta_io_amountinvoiced', 0);
                    //newRecord.setValue('custrecord_zeta_io_editors', null);

                    if (currentUserRole === ioUtils.ROLES.AR_MANAGER ) {
                        throw new Error('AR Manager is not allowed to copy Insertion Orders.');
                    }
                }

                if (type === context.UserEventType.CREATE && currentUserRole === ioUtils.ROLES.AR_MANAGER) {
                    throw new Error('AR Manager is not allowed to create Insertion Orders.');
                }

                // Block direct edit access via UI or CSV for pending approval status
                if (type === context.UserEventType.EDIT) {
                    const currentStatus = newRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                    if (currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                        const executionContext = runtime.executionContext;

                        // Block UI and CSV edits, allow programmatic updates (client scripts, server scripts, workflows, etc.)
                        if (executionContext === runtime.ContextType.USER_INTERFACE ||
                            executionContext === runtime.ContextType.CSV_IMPORT) {
                            throw new Error('Direct editing not allowed when pending manager approval. Use Approve/Reject buttons.');
                        }
                    }

                    // AR Manager cannot edit IOs via UI or CSV
                    if (currentUserRole === ioUtils.ROLES.AR_MANAGER && (runtime.executionContext === runtime.ContextType.USER_INTERFACE || runtime.executionContext === runtime.ContextType.CSV_IMPORT)) {
                        if (type === context.UserEventType.EDIT) {
                            throw new Error('AR Manager is not allowed to edit Insertion Orders.');
                        }
                    }
                }

                // Only add functionality in view mode
                if (type !== context.UserEventType.VIEW) {
                    return;
                }

                // Add the button actions client script to the form so button functions are available
                form.clientScriptModulePath = './zeta_cl_io_buttonactions.js';

                log.debug('beforeLoad', `Adding functionality for status: ${currentStatus}, role: ${currentUserRole}, user: ${currentUserId}`);

                // Add status indicator at the top of the form
                const statusHTML = getStatusHTML(currentStatus);
                const statusField = form.addField({
                    id: 'custpage_status_indicator',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '  // Empty label to minimize space
                });
                statusField.defaultValue = statusHTML;

                statusField.updateLayoutType({
                    layoutType: serverWidget.FieldLayoutType.OUTSIDEABOVE
                });
                statusField.updateBreakType({
                    breakType: serverWidget.FieldBreakType.STARTROW
                });

                log.debug('beforeLoad', 'Added status indicator field at top of form');

                // Remove Edit button when status is "Reviewed - Pending Approval"
                if (currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                    form.removeButton('edit');
                    log.debug('beforeLoad', 'Removed Edit button - status is pending manager approval');
                }

                // Administrator has access to all buttons regardless of status
                if (currentUserRole === ioUtils.ROLES.ADMINISTRATOR) {
                    // Submit for Review button
                    if (currentStatus === ioUtils.APPROVAL_STATUS.DRAFT) {
                        form.addButton({
                            id: 'custpage_submit_for_review',
                            label: 'Submit for Review',
                            functionName: 'submitForReview'
                        });
                        log.debug('beforeLoad', 'Added Submit for Review button (Administrator)');
                    }

                    // Mark as Reviewed button
                    if (currentStatus === ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW) {
                        form.addButton({
                            id: 'custpage_mark_reviewed',
                            label: 'Mark as Reviewed',
                            functionName: 'markAsReviewed'
                        });
                        log.debug('beforeLoad', 'Added Mark as Reviewed button (Administrator)');
                    }

                    // Approve button
                    if (currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                        form.addButton({
                            id: 'custpage_approve_io',
                            label: 'Approve',
                            functionName: 'approveIO'
                        });
                        log.debug('beforeLoad', 'Added Approve button (Administrator)');
                    }

                    // Reject button
                    if (currentStatus === ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW ||
                        currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                        form.addButton({
                            id: 'custpage_reject_io',
                            label: 'Reject',
                            functionName: 'rejectIO'
                        });
                        log.debug('beforeLoad', 'Added Reject button (Administrator)');
                    }

                    // Resubmit button
                    if (currentStatus === ioUtils.APPROVAL_STATUS.REJECTED) {
                        form.addButton({
                            id: 'custpage_resubmit_io',
                            label: 'Resubmit',
                            functionName: 'resubmitIO'
                        });
                        log.debug('beforeLoad', 'Added Resubmit button (Administrator)');
                    }

                    // Override buttons for Administrator (same logic as AR Manager)
                    if (currentStatus === ioUtils.APPROVAL_STATUS.APPROVED) {
                        const overrideActive = newRecord.getValue(ioUtils.FIELDS.OVERRIDE_ACTIVE);
                        
                        if (!overrideActive) {
                            // Show Override button when no active override
                            form.addButton({
                                id: 'custpage_override_io',
                                label: 'Override',
                                functionName: 'overrideIO'
                            });
                            log.debug('beforeLoad', 'Added Override button (Administrator)');
                        } else {
                            // Show Revoke Override button when override is active
                            form.addButton({
                                id: 'custpage_revoke_override',
                                label: 'Revoke Override',
                                functionName: 'revokeOverride'
                            });
                            log.debug('beforeLoad', 'Added Revoke Override button (Administrator)');
                        }
                    }
                } else {
                    // Regular role-based button logic

                    // Submit for Review button (Draft -> Submitted)
                    if (currentStatus === ioUtils.APPROVAL_STATUS.DRAFT && currentUserRole === ioUtils.ROLES.AR_ANALYST) {
                        // Check if user is the creator (can submit their own IOs)
                        const createdBy = newRecord.getValue('owner');
                        form.addButton({
                            id: 'custpage_submit_for_review',
                            label: 'Submit for Review',
                            functionName: 'submitForReview'
                        });
                        log.debug('beforeLoad', 'Added Submit for Review button');
                    }

                    // Mark as Reviewed button (Submitted -> Reviewed)
                    if (currentStatus === ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW && currentUserRole === ioUtils.ROLES.AR_ANALYST) {
                        const editors = newRecord.getValue(ioUtils.FIELDS.EDITORS) || [];
                        const userId = ioUtils.getCurrentUserId();
                        let editorsArr = Array.isArray(editors)
                            ? editors.map(String)
                            : editors.toString().split(',').map(e => e.trim()).filter(e => e);

                        log.debug('beforeLoad', `Mark as Reviewed button check: userId=${userId}, editorsArr=${JSON.stringify(editorsArr)}`);

                        const creatorId = String(newRecord.getValue('owner'));
                        const userIsCreator = (creatorId == userId);
                        log.debug('beforeLoad', `Creator ID: ${creatorId}, Current User ID: ${userId}`);
                        log.debug('beforeLoad', `User is creator: ${userIsCreator}`);
                        // Only show Mark as Reviewed if current user is not the creator and not in editors list
                        if (!editorsArr.includes(String(userId)) && !userIsCreator) {
                            form.addButton({
                                id: 'custpage_mark_reviewed',
                                label: 'Mark as Reviewed',
                                functionName: 'markAsReviewed'
                            });
                            log.debug('beforeLoad', `Mark as Reviewed button added for userId=${userId}`);
                        } else {
                            log.debug('beforeLoad', `Mark as Reviewed button NOT added for userId=${userId} (user is an editor or creator)`);
                        }
                    }

                    // Approve button (Reviewed -> Approved)
                    if (currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL && currentUserRole === ioUtils.ROLES.AR_MANAGER) {
                        form.addButton({
                            id: 'custpage_approve_io',
                            label: 'Approve',
                            functionName: 'approveIO'
                        });
                        log.debug('beforeLoad', 'Added Approve button');
                    }

                    // Reject button (Submitted/Reviewed -> Rejected)
                    let canReject = false;

                    if (currentStatus === ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW && currentUserRole === ioUtils.ROLES.AR_ANALYST) {
                        // AR Analyst can reject submitted IOs they didn't create
                        canReject = ioUtils.canUserReview(recordId, currentUserId);
                    } else if (currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL && currentUserRole === ioUtils.ROLES.AR_MANAGER) {
                        // AR Manager can reject reviewed IOs
                        canReject = true;
                    }

                    if (canReject) {
                        form.addButton({
                            id: 'custpage_reject_io',
                            label: 'Reject',
                            functionName: 'rejectIO'
                        });
                        log.debug('beforeLoad', 'Added Reject button');
                    }

                    // Resubmit button (Rejected -> Submitted for Review)
                    if (currentStatus === ioUtils.APPROVAL_STATUS.REJECTED && currentUserRole === ioUtils.ROLES.AR_ANALYST) {
                        form.addButton({
                            id: 'custpage_resubmit_io',
                            label: 'Resubmit',
                            functionName: 'resubmitIO'
                        });
                        log.debug('beforeLoad', 'Added Resubmit button');
                    }

                    // Override buttons for AR Manager
                    if (currentStatus === ioUtils.APPROVAL_STATUS.APPROVED && currentUserRole === ioUtils.ROLES.AR_MANAGER) {
                        const overrideActive = newRecord.getValue(ioUtils.FIELDS.OVERRIDE_ACTIVE);
                        
                        if (!overrideActive) {
                            // Show Override button when no active override
                            form.addButton({
                                id: 'custpage_override_io',
                                label: 'Override',
                                functionName: 'overrideIO'
                            });
                            log.debug('beforeLoad', 'Added Override button (AR Manager)');
                        } else {
                            // Show Revoke Override button when override is active
                            form.addButton({
                                id: 'custpage_revoke_override',
                                label: 'Revoke Override',
                                functionName: 'revokeOverride'
                            });
                            log.debug('beforeLoad', 'Added Revoke Override button (AR Manager)');
                        }
                    }
                }

            } catch (error) {
                // Detect security-related errors and re-throw them to block access
                if (error.message && 
                    (
                        error.message.includes('Direct editing not allowed') ||
                        error.message.includes('AR Manager is not allowed to create Insertion Orders.') ||
                        error.message.includes('AR Manager is not allowed to edit Insertion Orders.') ||
                        error.message.includes('AR Manager is not allowed to copy Insertion Orders.')
                    )
                ) {
                    throw error; // Re-throw security errors to properly block the operation
                }

                // Log other errors but don't block execution
                log.error('beforeLoad', 'Error in beforeLoad: ' + error.message);
            }
        }

        /**
         * Before Submit function
         * @param {Object} context
         */
        function beforeSubmit(context) {
            try {
                const newRecord = context.newRecord;
                const oldRecord = context.oldRecord;
                const eventType = context.type;
                log.debug('beforeSubmit', `Event Type: ${eventType}`);

                // Only process on create and edit
                if (eventType !== context.UserEventType.CREATE && eventType !== context.UserEventType.EDIT) {
                    return;
                }
                log.debug('beforeSubmit', `Processing beforeSubmit for event type: ${eventType}`);
                const currentUserId = ioUtils.getCurrentUserId();
                const currentUserRole = ioUtils.getCurrentUserRole();

                // Calculate and set order total for both create and edit operations
                const recordId = newRecord.id;
                if (recordId) {
                    // For existing records, calculate total from line items
                    const orderTotal = calculateOrderTotal(newRecord);
                    newRecord.setValue('custrecord_zeta_io_ordertotal', orderTotal);
                    log.debug('beforeSubmit', `Set order total to ${orderTotal} for IO ${recordId}`);
                }

                var isPGMT = newRecord.getValue(ioUtils.FIELDS.IS_PGMT);
                if (isPGMT) {
                    var campaignName = newRecord.getValue(ioUtils.FIELDS.CAMPAIGN_NAME);
                    if (!campaignName) {
                        throw new Error('For PGMT Insertion Orders, Campaign Name is mandatory.');
                    }
                }

                // Io-Level duplicate check for Salesforce Opportunity ID
                const sfOppId = newRecord.getValue(ioUtils.FIELDS.SALESFORCE_OPPORTUNITY_ID);
                log.debug('beforeSubmit', `Salesforce Opportunity ID: ${sfOppId}`);
                let filters = [
                    [ioUtils.FIELDS.SALESFORCE_OPPORTUNITY_ID, 'is', sfOppId],
                    "AND",
                    [ioUtils.FIELDS.CLOSED, "is", "F"]
                ];

                if (eventType === context.UserEventType.EDIT && newRecord.id) {
                    filters.push('AND');
                    filters.push(['internalid', 'noneof', newRecord.id]);
                }

                if (sfOppId) {
                    const dupSearch = search.create({
                        type: ioUtils.RECORD_TYPE,
                        filters: filters,
                        columns: ['internalid']
                    });

                    const hasDuplicate = dupSearch.run().getRange({ start: 0, end: 1 }).length > 0;
                    log.debug('beforeSubmit', `Duplicate search for SF Opp ID ${sfOppId}: ${hasDuplicate}`);
                    if (hasDuplicate) {
                        throw new Error('Another Insertion Order already contains this Salesforce Opportunity ID. Please use a unique ID.');
                    }
                }

                // Line-level duplicate check for Salesforce Order Line ID
                const lineCount = newRecord.getLineCount({ sublistId: 'recmachcustrecord_zeta_ioi_insertionorder' });
                for (let i = 0; i < lineCount; i++) {
                    const sfOrderLineId = newRecord.getSublistValue({
                        sublistId: 'recmachcustrecord_zeta_ioi_insertionorder',
                        fieldId: 'custrecord_zeta_ioi_sforderlineid',
                        line: i
                    });

                    // Get current line's internal ID (if present)
                    const lineInternalId = newRecord.getSublistValue({
                        sublistId: 'recmachcustrecord_zeta_ioi_insertionorder',
                        fieldId: 'id',
                        line: i
                    });

                    if (sfOrderLineId) {
                        let lineFilters = [
                            ['custrecord_zeta_ioi_sforderlineid', 'is', sfOrderLineId]
                        ];

                        // On EDIT, exclude current IO's line items
                        if (eventType === context.UserEventType.EDIT && lineInternalId) {
                            lineFilters.push('AND');
                            lineFilters.push(['internalid', 'noneof', lineInternalId]);
                            lineFilters.push('AND');
                            lineFilters.push(['custrecord_zeta_ioi_insertionorder', 'noneof', newRecord.id]);
                        }

                        const lineDupSearch = search.create({
                            type: 'customrecord_zeta_insertionorderitems',
                            filters: lineFilters,
                            columns: ['internalid']
                        });

                        const hasLineDuplicate = lineDupSearch.run().getRange({ start: 0, end: 1 }).length > 0;
                        log.debug('beforeSubmit', `Duplicate search for SF Order Line ID ${sfOrderLineId}: ${hasLineDuplicate}`);
                        if (hasLineDuplicate) {
                            throw new Error(`Another IO line item already contains Salesforce Order Line ID "${sfOrderLineId}". Please use unique IDs for each IO.`);
                        }
                    }
                }

                const campaignStartDate = new Date(newRecord.getValue('custrecord_zeta_io_campaignstartdate'));
                const campaignEndDate = new Date(newRecord.getValue('custrecord_zeta_io_campaignenddate'));

                // Validate line item dates
                for (let i = 0; i < lineCount; i++) {
                    const startDate = newRecord.getSublistValue({
                        sublistId: 'recmachcustrecord_zeta_ioi_insertionorder',
                        fieldId: 'custrecord_zeta_ioi_revrecstartdate',
                        line: i
                    });
                    const endDate = newRecord.getSublistValue({
                        sublistId: 'recmachcustrecord_zeta_ioi_insertionorder',
                        fieldId: 'custrecord_zeta_ioi_revrecenddate',
                        line: i
                    });

                    // Rule 1: Start must be before End
                    if (new Date(startDate) > new Date(endDate)) {
                        throw new Error(`Line ${i + 1}: End Date cannot be earlier than Start Date.`);
                    }

                    // Rule 2: Start and End must be within Campaign Start and End
                    if (new Date(startDate) < campaignStartDate || new Date(endDate) > campaignEndDate) {
                        throw new Error(`Line ${i + 1}: Start and End dates must be within the campaign period (${campaignStartDate.toDateString()} – ${campaignEndDate.toDateString()}).`);
                    }

                }

                // Set default status for new records
                if (eventType === context.UserEventType.CREATE) {
                    const currentStatus = newRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);
                    if (!currentStatus) {
                        newRecord.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.DRAFT);
                        log.debug('beforeSubmit', 'Set default status to Draft for new IO');
                    }
                    return; // No further validation needed for new records
                }

                if (eventType === context.UserEventType.EDIT) {
                    let editors = newRecord.getValue(ioUtils.FIELDS.EDITORS) || '';
                    log.debug('beforeSubmit', `Current editors: ${editors}`);
                    const currentUserId = ioUtils.getCurrentUserId();

                    // Ensure editors is always an array of strings
                    let editorsArr = Array.isArray(editors)
                        ? editors.map(e => e.toString())
                        : editors.toString().split(',').map(e => e.trim()).filter(e => e);

                    if (!editorsArr.includes(currentUserId.toString()) && (runtime.executionContext === runtime.ContextType.USER_INTERFACE || runtime.executionContext === runtime.ContextType.CSV_IMPORT)) {
                        editorsArr.push(currentUserId.toString());
                        newRecord.setValue(ioUtils.FIELDS.EDITORS, editorsArr);
                    }

                    // --- Invoice Amount Restriction Logic ---
                    const ioTotal = parseFloat(newRecord.getValue('custrecord_zeta_io_ordertotal') || 0);
                    const overRideAmount = parseFloat(newRecord.getValue(ioUtils.FIELDS.OVERRIDE_AMOUNT) || 0);
                    // Use the new function to get sum of linked invoice totals
                    const invoiceTotalSum = getLinkedInvoicesTotal(recordId, search);
                    var ioTotalEffective = ioTotal + overRideAmount;
                    if (invoiceTotalSum > 0 && ioTotalEffective < invoiceTotalSum) {
                        throw new Error('IO Total cannot be less than the sum of linked Invoice Amounts (' + invoiceTotalSum + '). Please update the IO total.');
                    }
                }

                // Handle edit operations
                const newStatus = newRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);
                const oldStatus = oldRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                log.debug('beforeSubmit', `Status change: ${oldStatus} -> ${newStatus}, User Role: ${currentUserRole}`);

                // Check for approval retrigger on approved IOs
                if (oldStatus === ioUtils.APPROVAL_STATUS.APPROVED && newStatus === ioUtils.APPROVAL_STATUS.APPROVED) {
                    if (ioUtils.hasRetriggerFieldsChanged(newRecord, oldRecord)) {
                        log.debug('beforeSubmit', 'Retrigger fields changed on approved IO, setting status to Submitted for Review');
                        newRecord.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW);

                        // Clear override fields on retrigger
                        ioUtils.clearOverrideFields(newRecord);

                        // Clear approval fields
                        newRecord.setValue(ioUtils.FIELDS.REVIEWED_BY, '');
                        newRecord.setValue(ioUtils.FIELDS.APPROVED_BY, '');
                        newRecord.setValue(ioUtils.FIELDS.REJECT_REASON, '');

                        log.debug('beforeSubmit', 'Cleared approval fields due to retrigger');
                        return;
                    }
                }

                // Sublist-level retrigger fields check
                // If any retrigger fields in IO Items sublist changed, reset status to Submitted for Review
                // This applies if current status is Approved or Reviewed - Pending Approval
                if (newStatus === ioUtils.APPROVAL_STATUS.APPROVED || newStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                    log.debug('beforeSubmit', 'Checking IO Items sublist for retrigger fields changes');
                    const IO_ITEMS_SUBLIST_ID = 'recmachcustrecord_zeta_ioi_insertionorder';
                    const newLineCount = newRecord.getLineCount({ sublistId: IO_ITEMS_SUBLIST_ID });
                    const oldLineCount = oldRecord.getLineCount({ sublistId: IO_ITEMS_SUBLIST_ID });

                    let meaningfulChange = false;

                    // Check for added or removed lines
                    if (newLineCount !== oldLineCount) {
                        meaningfulChange = true;
                        log.debug('beforeSubmit', `IO Items line count changed: ${oldLineCount} → ${newLineCount}`);
                    } else {
                        // Check for changes in retrigger fields
                        for (let i = 0; i < newLineCount; i++) {
                            for (let j = 0; j < ioUtils.RETRIGGER_FIELDS_IOItems.length; j++) {
                                const fieldId = ioUtils.RETRIGGER_FIELDS_IOItems[j];
                                const newValue = newRecord.getSublistValue({
                                    sublistId: IO_ITEMS_SUBLIST_ID,
                                    fieldId: fieldId,
                                    line: i
                                });
                                const oldValue = oldRecord.getSublistValue({
                                    sublistId: IO_ITEMS_SUBLIST_ID,
                                    fieldId: fieldId,
                                    line: i
                                });
                                // Handle different data types appropriately
                                if (fieldId.includes('date')) {
                                    // For dates, compare as date objects to avoid timezone formatting issues
                                    const oldDate = oldValue ? new Date(oldValue).getTime() : null;
                                    const newDate = newValue ? new Date(newValue).getTime() : null;
                                    if (oldDate !== newDate) {
                                        log.debug('hasRetriggerFieldsChanged', `Date field ${fieldId} changed: ${oldValue} -> ${newValue}`);
                                        meaningfulChange = true;
                                        log.debug('beforeSubmit', `IO Item line ${i} field ${fieldId} changed: ${oldValue} → ${newValue}`);
                                        break;
                                    }
                                } else {
                                    // For other fields, direct comparison
                                    if (newValue !== oldValue) {
                                        log.debug('hasRetriggerFieldsChanged', `Field ${fieldId} changed: ${oldValue} -> ${newValue}`);
                                        meaningfulChange = true;
                                        log.debug('beforeSubmit', `IO Item line ${i} field ${fieldId} changed: ${oldValue} → ${newValue}`);
                                        break;
                                    }
                                }
                            }
                            if (meaningfulChange) break;
                        }
                    }

                    if (meaningfulChange) {
                        log.debug('beforeSubmit', 'Meaningful IO Item change detected, setting status to Submitted for Review');
                        newRecord.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW);
                        ioUtils.clearOverrideFields(newRecord);
                        newRecord.setValue(ioUtils.FIELDS.REVIEWED_BY, '');
                        newRecord.setValue(ioUtils.FIELDS.APPROVED_BY, '');
                        newRecord.setValue(ioUtils.FIELDS.REJECT_REASON, '');
                        log.debug('beforeSubmit', 'Cleared approval fields due to retrigger');
                        return;
                    } else {
                        log.debug('afterSubmit', `Parent IO status is ${newStatus}, no retrigger needed`);
                    }
                }

                // If status hasn't changed, no validation needed
                if (newStatus === oldStatus) {
                    return;
                }

                // Skip validation for Administrator role
                if (currentUserRole !== ioUtils.ROLES.ADMINISTRATOR) {
                    // Validate status transition
                    if (!ioUtils.isValidTransition(oldStatus, newStatus, currentUserRole)) {
                        const errorMsg = `Invalid status transition from ${ioUtils.getStatusDisplayName(oldStatus)} to ${ioUtils.getStatusDisplayName(newStatus)} for your role.`;
                        log.error('beforeSubmit', errorMsg);
                        throw new Error(errorMsg);
                    }

                    // Special validation for review transitions (reviewer cannot be creator)
                    if (oldStatus === ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW &&
                        (newStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL || newStatus === ioUtils.APPROVAL_STATUS.REJECTED)) {

                        const recordId = newRecord.id;
                        if (!ioUtils.canUserReview(recordId, currentUserId)) {
                            const errorMsg = 'You cannot review an Insertion Order that you created.';
                            log.error('beforeSubmit', errorMsg);
                            throw new Error(errorMsg);
                        }
                    }
                } else {
                    log.debug('beforeSubmit', 'Administrator role - bypassing role-based validations');
                }

                // Validate required fields for the new status
                const validation = ioUtils.validateRequiredFields(newRecord, newStatus);
                if (!validation.isValid) {
                    const errorMsg = validation.errors.join(' ');
                    log.error('beforeSubmit', errorMsg);
                    throw new Error(errorMsg);
                }

                log.debug('beforeSubmit', 'All validations passed');

            } catch (error) {
                log.error('beforeSubmit', 'Error in beforeSubmit: ' + error.message);
                throw error;
            }
        }

        /**
         * After Submit function
         * @param {Object} context
         */
        function afterSubmit(context) {
            try {
                const newRecord = context.newRecord;
                const oldRecord = context.oldRecord;
                const eventType = context.type;
                const recordId = newRecord.id;

                // Only process on create and edit
                if (eventType !== context.UserEventType.CREATE && eventType !== context.UserEventType.EDIT) {
                    return;
                }

                const currentUserId = ioUtils.getCurrentUserId();
                const newStatus = newRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                // For new records, no status tracking needed
                if (eventType === context.UserEventType.CREATE) {
                    const updateRecord = record.load({
                        type: ioUtils.RECORD_TYPE,
                        id: recordId
                    });

                    const orderTotal = calculateOrderTotal(updateRecord);
                    updateRecord.setValue('custrecord_zeta_io_ordertotal', orderTotal);

                    updateRecord.save({
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    });

                    log.debug('Ordertotal', `Set order total to ${orderTotal} for new IO ${recordId}`);
                    return;
                }

                const oldStatus = oldRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                // If status hasn't changed, no action needed
                if (newStatus === oldStatus) {
                    return;
                }

                log.debug('afterSubmit', `Processing status change: ${oldStatus} -> ${newStatus}`);

                // Update approval tracking fields based on new status
                
                const updateRecord = record.load({
                    type: ioUtils.RECORD_TYPE,
                    id: recordId
                });

                let needsUpdate = false;

                // Set Reviewed By when status changes to Reviewed - Pending Approval
                if (newStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                    updateRecord.setValue(ioUtils.FIELDS.REVIEWED_BY, currentUserId);
                    needsUpdate = true;
                    log.debug('afterSubmit', `Set Reviewed By to user ${currentUserId}`);
                }

                // Set Approved By when status changes to Approved
                if (newStatus === ioUtils.APPROVAL_STATUS.APPROVED) {
                    updateRecord.setValue(ioUtils.FIELDS.APPROVED_BY, currentUserId);
                    needsUpdate = true;
                    log.debug('afterSubmit', `Set Approved By to user ${currentUserId}`);
                }

                // Clear approval fields when rejected or returned to earlier status
                if (newStatus === ioUtils.APPROVAL_STATUS.REJECTED) {
                    // Keep reject reason, but clear other approval fields if coming from approved status
                    if (oldStatus === ioUtils.APPROVAL_STATUS.APPROVED) {
                        updateRecord.setValue(ioUtils.FIELDS.APPROVED_BY, '');
                        needsUpdate = true;
                    }
                }

                // Clear approval fields when status goes back to submitted (retrigger case)
                if (newStatus === ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW &&
                    (oldStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL || oldStatus === ioUtils.APPROVAL_STATUS.APPROVED)) {
                    updateRecord.setValue(ioUtils.FIELDS.REVIEWED_BY, '');
                    updateRecord.setValue(ioUtils.FIELDS.APPROVED_BY, '');
                    updateRecord.setValue(ioUtils.FIELDS.REJECT_REASON, '');
                    needsUpdate = true;
                    log.debug('afterSubmit', 'Cleared approval fields due to status rollback');
                }

                // Save the record if updates are needed
                if (needsUpdate) {
                    updateRecord.save({
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    });
                    log.debug('afterSubmit', 'Updated approval tracking fields');
                }

            } catch (error) {
                log.error('afterSubmit', 'Error in afterSubmit: ' + error.message);
                // Don't throw error in afterSubmit to avoid blocking the transaction
            }
        }

        return {
            beforeLoad: beforeLoad,
            beforeSubmit: beforeSubmit,
            afterSubmit: afterSubmit
        };
    });
