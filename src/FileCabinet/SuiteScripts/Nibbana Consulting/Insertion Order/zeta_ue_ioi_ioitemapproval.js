/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @description User Event Script for Insertion Order Items - triggers approval retrigger on parent IO
 */

define(['N/log', 'N/record', 'N/search', './zeta_lib_io_utils', 'N/runtime'],
    function (log, record, search, ioUtils, runtime) {

        // Constants for Insertion Order Items record
        const IOI_RECORD_TYPE = 'customrecord_zeta_insertionorderitems';
        const IOI_PARENT_FIELD = 'custrecord_zeta_ioi_insertionorder';

        /**
         * Update parent IO order total by calculating sum of all line items
         * @param {string} parentIOId - Parent Insertion Order internal ID
         */
        function updateParentOrderTotal(parentIOId) {
            try {
                if (!parentIOId) {
                    log.debug('updateParentOrderTotal', 'No parent IO ID provided');
                    return;
                }

                // Calculate total from all IO items
                const searchObj = search.create({
                    type: IOI_RECORD_TYPE,
                    filters: [
                        [IOI_PARENT_FIELD, 'anyof', parentIOId]
                    ],
                    columns: [
                        'custrecord_zeta_ioi_amount'
                    ]
                });

                let totalAmount = 0;
                let itemCount = 0;

                searchObj.run().each(function (result) {
                    const amount = parseFloat(result.getValue('custrecord_zeta_ioi_amount') || 0);
                    totalAmount += amount;
                    itemCount++;
                    return true;
                });

                log.debug('updateParentOrderTotal', `Calculated total: ${totalAmount} from ${itemCount} items for IO ${parentIOId}`);

                // Update the parent IO record
                const parentIO = record.load({
                    type: ioUtils.RECORD_TYPE,
                    id: parentIOId
                });

                parentIO.setValue('custrecord_zeta_io_ordertotal', totalAmount);

                parentIO.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.debug('updateParentOrderTotal', `Updated parent IO ${parentIOId} order total to ${totalAmount}`);

            } catch (error) {
                log.error('updateParentOrderTotal', `Error updating parent order total for IO ${parentIOId}: ${error.message}`);
                // Don't throw error to avoid blocking the transaction
            }
        }

        /**
         * Before Load function
         * @param {Object} context
         */
        function beforeLoad(context) {
            const form = context.form;
            const type = context.type;

            const currentUserRole = ioUtils.getCurrentUserRole();

            // AR Manager cannot edit/create/copy IOs via UI or CSV
            if (currentUserRole === ioUtils.ROLES.AR_MANAGER) {
                form.removeButton('edit');
                log.debug('beforeLoad', 'Removed Edit button for AR Manager');

                if (type === context.UserEventType.EDIT && (runtime.executionContext === runtime.ContextType.USER_INTERFACE || runtime.executionContext === runtime.ContextType.CSV_IMPORT)) {
                    throw new Error('AR Manager is not allowed to edit Insertion Orders.');
                }

                if (type === context.UserEventType.CREATE) {
                    throw new Error('AR Manager is not allowed to create Insertion Orders.');
                }

                if (type === context.UserEventType.COPY) {
                    throw new Error('AR Manager is not allowed to copy Insertion Orders.');
                }
            }
        }

        /**
             * Before Submit function
             * @param {Object} context
             */
        function beforeSubmit(context) {
            // need to check whther start and end dates are within campaign period from Io
            try {
                const newRecord = context.newRecord;
                const eventType = context.type;

                if (eventType === context.UserEventType.CREATE || eventType === context.UserEventType.EDIT) {
                    const parentIOId = newRecord.getValue(IOI_PARENT_FIELD);
                    if (parentIOId) {
                        const parentIO = record.load({
                            type: ioUtils.RECORD_TYPE,
                            id: parentIOId
                        });

                        const campaignStart = parentIO.getValue('custrecord_zeta_io_campaignstartdate');
                        const campaignEnd = parentIO.getValue('custrecord_zeta_io_campaignenddate');

                        const itemStart = newRecord.getValue('custrecord_zeta_ioi_revrecstartdate');
                        const itemEnd = newRecord.getValue('custrecord_zeta_ioi_revrecenddate');

                        // Rule 1: Start must be before End
                        if (new Date(itemStart) > new Date(itemEnd)) {
                            throw new Error(`End Date cannot be earlier than Start Date.`);
                        }

                        // Rule 2: Start and End must be within Campaign Start and End
                        if (itemStart && itemEnd && campaignStart && campaignEnd) {
                            if (itemStart < campaignStart || itemEnd > campaignEnd) {
                                throw new Error('Item start and end dates must be within the campaign period of the parent Insertion Order.');
                            }
                        }
                    }
                }
            } catch (error) {
                log.error('beforeSubmit', `Error in IOI beforeSubmit: ${error.message}`);
                throw error; // Throw error to block the transaction
            }
        }

        /**
         * After Submit function - triggers when items are created, edited, or deleted
         * @param {Object} context
         */
        function afterSubmit(context) {
            try {
                const newRecord = context.newRecord;
                const oldRecord = context.oldRecord;
                const eventType = context.type;

                log.debug('afterSubmit', `IOI Event Type: ${eventType}`);

                let parentIOId = null;
                let shouldRetrigger = false;
                let shouldUpdateTotal = false;
                let editorsUpdate = false;

                // Determine parent IO ID and what actions to take
                if (eventType === context.UserEventType.CREATE) {
                    parentIOId = newRecord.getValue(IOI_PARENT_FIELD);
                    shouldRetrigger = true;
                    shouldUpdateTotal = true;
                    editorsUpdate = true;
                    log.debug('afterSubmit', `New item created. Parent IO ID: ${parentIOId}`);
                } else if (eventType === context.UserEventType.DELETE) {
                    parentIOId = oldRecord.getValue(IOI_PARENT_FIELD);
                    shouldRetrigger = true;
                    shouldUpdateTotal = true;
                    editorsUpdate = true;
                    log.debug('afterSubmit', `Item deleted. Parent IO ID: ${parentIOId}`);
                } else if (eventType === context.UserEventType.EDIT) {
                    parentIOId = newRecord.getValue(IOI_PARENT_FIELD);
                    shouldRetrigger = ioUtils.hasMeaningfulChangesIOItems(newRecord, oldRecord);

                    // Check if amount field changed to determine if total needs updating
                    const oldAmount = parseFloat(oldRecord.getValue('custrecord_zeta_ioi_amount') || 0);
                    const newAmount = parseFloat(newRecord.getValue('custrecord_zeta_ioi_amount') || 0);
                    shouldUpdateTotal = (oldAmount !== newAmount) || shouldRetrigger;
                    editorsUpdate = true;

                    log.debug('afterSubmit', `Item edited. Parent IO ID: ${parentIOId}, Meaningful changes: ${shouldRetrigger}, Amount changed: ${oldAmount !== newAmount}`);
                }

                // If no parent IO found, exit
                if (!parentIOId) {
                    log.debug('afterSubmit', 'No parent Insertion Order found, exiting');
                    return;
                }

                // Update parent order total if needed
                if (shouldUpdateTotal) {
                    updateParentOrderTotal(parentIOId);
                }

                // update editors field to include current user if editorsUpdate is true and shouldRetrigger is false
                if (editorsUpdate) {
                    const parentIO = record.load({
                        type: ioUtils.RECORD_TYPE,
                        id: parentIOId
                    });

                    const currentUserId = runtime.getCurrentUser().id;
                    // get editors list and the push current user if not already present
                    let editors = parentIO.getValue(ioUtils.FIELDS.EDITORS) || [];
                    if (!Array.isArray(editors)) {
                        editors = [editors];
                    }
                    if (!editors.includes(currentUserId.toString())) {
                        editors.push(currentUserId.toString());
                        parentIO.setValue(ioUtils.FIELDS.EDITORS, editors);
                        log.debug('afterSubmit', `Added user ${currentUserId} to editors`);
                    }

                    // Save the parent record
                    parentIO.save({
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    });
                }

                // If no meaningful changes detected for approval retrigger, exit early
                if (!shouldRetrigger) {
                    log.debug('afterSubmit', 'No meaningful changes detected for approval retrigger');
                    return;
                }

                // Load the parent Insertion Order for approval retrigger
                const parentIO = record.load({
                    type: ioUtils.RECORD_TYPE,
                    id: parentIOId
                });

                const currentStatus = parentIO.getValue(ioUtils.FIELDS.APPROVAL_STATUS);
                log.debug('afterSubmit', `Current parent IO status: ${currentStatus}`);

                // Retrigger approval if IO is approved or reviewed
                if (currentStatus === ioUtils.APPROVAL_STATUS.APPROVED ||
                    currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {

                    log.debug('afterSubmit', `Parent IO is ${currentStatus}, retriggering approval process`);

                    // Set status back to Submitted for Review
                    parentIO.setValue(ioUtils.FIELDS.APPROVAL_STATUS, ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW);

                    // Clear approval tracking fields
                    parentIO.setValue(ioUtils.FIELDS.REVIEWED_BY, '');
                    parentIO.setValue(ioUtils.FIELDS.APPROVED_BY, '');
                    parentIO.setValue(ioUtils.FIELDS.REJECT_REASON, '');

                    if (editorsUpdate) {
                        // Update editors field to include current user
                        const currentUserId = runtime.getCurrentUser().id;
                        // get editors list and the push current user if not already present
                        let editors = parentIO.getValue(ioUtils.FIELDS.EDITORS) || [];
                        if (!Array.isArray(editors)) {
                            editors = [editors];
                        }
                        if (!editors.includes(currentUserId.toString())) {
                            editors.push(currentUserId.toString());
                            parentIO.setValue(ioUtils.FIELDS.EDITORS, editors);
                            log.debug('afterSubmit', `Added user ${currentUserId} to editors`);
                        }
                    }

                    // Clear override fields if they exist
                    ioUtils.clearOverrideFields(parentIO);

                    // Save the parent record
                    parentIO.save({
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    });

                    log.audit('afterSubmit', `Retriggered approval for IO ${parentIOId} due to item changes - status was ${currentStatus}`);
                } else {
                    log.debug('afterSubmit', `Parent IO status is ${currentStatus}, no retrigger needed`);
                }

            } catch (error) {
                log.error('afterSubmit', `Error in IOI afterSubmit: ${error.message}`);
                // Don't throw error to avoid blocking the transaction
            }
        }

        return {
          beforeLoad: beforeLoad,
            beforeSubmit: beforeSubmit,
            afterSubmit: afterSubmit
        };
    });
