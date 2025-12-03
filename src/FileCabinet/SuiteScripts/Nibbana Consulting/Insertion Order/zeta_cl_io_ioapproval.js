/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @description Client Script for Insertion Order approval workflow UI - Entry Points Only
 */

define(['N/ui/message', 'N/search', './zeta_lib_io_utils'],
    function (message, search, ioUtils) {

        /**
         * Page Init function
         * @param {Object} context
         */
        function pageInit(context) {
            try {
                const record = context.currentRecord;
                var type = context.mode;

                if (type === 'copy') {
                    record.setValue({
                        fieldId: ioUtils.FIELDS.EDITORS,
                        value: []
                    });
                }

                // Show status-specific messages
                showStatusMessages(record);
                var isPgmt = record.getValue(ioUtils.FIELDS.IS_PGMT);
                if (isPgmt) {
                    record.getField({
                        fieldId: ioUtils.FIELDS.CAMPAIGN_NAME
                    }).isMandatory = true;
                } else {
                    record.getField({
                        fieldId: ioUtils.FIELDS.CAMPAIGN_NAME
                    }).isMandatory = false;
                }

            } catch (error) {
                console.error('Error in pageInit:', error);
            }
        }

        /**
         * Field Changed function
         * @param {Object} context
         */
        function fieldChanged(context) {
            try {
                const record = context.currentRecord;
                const fieldId = context.fieldId;

                // Handle approval status changes
                if (fieldId === ioUtils.FIELDS.APPROVAL_STATUS) {
                    handleStatusChange(record);
                }

                // Handle reject reason field
                if (fieldId === ioUtils.FIELDS.REJECT_REASON) {
                    validateRejectReason(record);
                }

                if( fieldId === ioUtils.FIELDS.IS_PGMT) {
                    var isPgmt = record.getValue(ioUtils.FIELDS.IS_PGMT);
                    if(isPgmt) {
                        record.getField({
                            fieldId: ioUtils.FIELDS.CAMPAIGN_NAME
                        }).isMandatory = true;
                    }else{
                        record.getField({
                            fieldId: ioUtils.FIELDS.CAMPAIGN_NAME
                        }).isMandatory = false;
                    }
                }

            } catch (error) {
                console.error('Error in fieldChanged:', error);
            }
        }

        function validateLine(context) {
            const sublistName = context.sublistId;
            log.debug('validateLine', `Sublist: ${sublistName}`);
            if (sublistName == 'recmachcustrecord_zeta_ioi_insertionorder') {
                const currentRecord = context.currentRecord;
                log.debug('validateLine', 'Validating line item dates');
                const startDate = currentRecord.getCurrentSublistValue({
                    sublistId: sublistName,
                    fieldId: 'custrecord_zeta_ioi_revrecstartdate'
                });

                const endDate = currentRecord.getCurrentSublistValue({
                    sublistId: sublistName,
                    fieldId: 'custrecord_zeta_ioi_revrecenddate'
                });

                if (startDate && endDate) {
                    const start = new Date(startDate);
                    const end = new Date(endDate);

                    if (end < start) {
                        alert('End Date cannot be earlier than Start Date.');
                        return false; // Cancel line submission
                    }
                }
            }

            return true; // Allow line submission
        }

        /**
         * Save Record function
         * @param {Object} context
         */
        function saveRecord(context) {
            try {
                const record = context.currentRecord;

                // Validate before saving
                return validateBeforeSave(record);

            } catch (error) {
                console.error('Error in saveRecord:', error);
                return false;
            }
        }

        /**
         * Show status-specific messages
         * @param {Record} record - Current record
         */
        function showStatusMessages(record) {
            try {
                const currentStatus = record.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                if (currentStatus === ioUtils.APPROVAL_STATUS.REJECTED) {
                    const rejectReason = record.getValue(ioUtils.FIELDS.REJECT_REASON);
                    if (rejectReason) {
                        message.create({
                            title: 'Insertion Order Rejected',
                            message: 'Reason: ' + rejectReason,
                            type: message.Type.WARNING
                        }).show();
                    }
                }

            } catch (error) {
                console.error('Error showing status messages:', error);
            }
        }

        /**
         * Handle status change events
         * @param {Record} record - Current record
         */
        function handleStatusChange(record) {
            try {
                const newStatus = record.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                // Clear reject reason when status is not rejected
                if (newStatus !== ioUtils.APPROVAL_STATUS.REJECTED) {
                    record.setValue(ioUtils.FIELDS.REJECT_REASON, '');
                }

            } catch (error) {
                console.error('Error handling status change:', error);
            }
        }

        /**
         * Validate reject reason field
         * @param {Record} record - Current record
         */
        function validateRejectReason(record) {
            try {
                const currentStatus = record.getValue(ioUtils.FIELDS.APPROVAL_STATUS);
                const rejectReason = record.getValue(ioUtils.FIELDS.REJECT_REASON);

                if (currentStatus === ioUtils.APPROVAL_STATUS.REJECTED) {
                    if (!rejectReason || rejectReason.trim() === '') {
                        message.create({
                            title: 'Validation Error',
                            message: 'Reject reason is mandatory when rejecting an Insertion Order.',
                            type: message.Type.ERROR
                        }).show();
                    } else if (rejectReason.trim().length < 5) {
                        message.create({
                            title: 'Validation Error',
                            message: 'Reject reason must be at least 5 characters long. Please provide a meaningful reason.',
                            type: message.Type.ERROR
                        }).show();
                    }
                }

            } catch (error) {
                console.error('Error validating reject reason:', error);
            }
        }

        /**
         * Check if Salesforce ID is 15-digit format
         * @param {string} salesforceId - Salesforce ID to validate
         * @returns {boolean} True if it's a 15-digit ID
         */
        function is15DigitSalesforceId(salesforceId) {
            if (!salesforceId || typeof salesforceId !== 'string') {
                return false;
            }

            // Check if it's exactly 15 characters and alphanumeric
            const trimmedId = salesforceId.trim();
            return trimmedId.length === 15 && /^[a-zA-Z0-9]{15}$/.test(trimmedId);
        }

        /**
         * Validate Salesforce Opportunity ID format
         * @param {Record} record - Current record
         * @returns {boolean} True if validation passes or user chooses to proceed
         */
        function validateSalesforceOpportunityId(record) {
            try {
                const salesforceOppId = record.getValue(ioUtils.FIELDS.SALESFORCE_OPPORTUNITY_ID);

                if (is15DigitSalesforceId(salesforceOppId)) {
                    const confirmMessage =
                        'Warning: Salesforce Opportunity ID Format\n\n' +
                        'The Salesforce Opportunity ID appears to be in 15-digit format:\n' +
                        salesforceOppId + '\n\n' +
                        'For better compatibility and data integrity, the 18-digit format is recommended.\n\n' +
                        'Choose an option:\n' +
                        '• Cancel - Stop saving and update to 18-digit format\n' +
                        '• OK - Continue saving with current 15-digit ID\n\n' +
                        'Do you want to proceed with saving?';

                    return confirm(confirmMessage);
                }

                return true; // No validation issues

            } catch (error) {
                console.error('Error validating Salesforce Opportunity ID:', error);
                return true; // Allow save if validation fails
            }
        }

        /**
         * Validate before saving
         * @param {Record} record - Current record
         * @returns {boolean} True if validation passes
         */
        function validateBeforeSave(record) {
            try {
                const currentStatus = record.getValue(ioUtils.FIELDS.APPROVAL_STATUS);

                // Validate reject reason for rejected status
                if (currentStatus === ioUtils.APPROVAL_STATUS.REJECTED) {
                    const rejectReason = record.getValue(ioUtils.FIELDS.REJECT_REASON);
                    if (!rejectReason || rejectReason.trim() === '') {
                        alert('Reject reason is mandatory when rejecting an Insertion Order. Please provide a reason for rejection.');
                        return false;
                    }

                    // Additional validation for minimum length
                    if (rejectReason.trim().length < 5) {
                        alert('Reject reason must be at least 5 characters long. Please provide a meaningful reason for rejection.');
                        return false;
                    }
                }

                // Validate Salesforce Opportunity ID format
                if (!validateSalesforceOpportunityId(record)) {
                    return false; // User chose to cancel the save
                }

                // Get campaign start/end from header
                var campaignStartDate = new Date(record.getValue('custrecord_zeta_io_campaignstartdate'));
                var campaignEndDate = new Date(record.getValue('custrecord_zeta_io_campaignenddate'));
                log.debug('Campaign Dates', `Start: ${campaignStartDate}, End: ${campaignEndDate}`);
              
                // Validate line item dates
                const lineCount = record.getLineCount({ sublistId: 'recmachcustrecord_zeta_ioi_insertionorder' });
                for (let i = 0; i < lineCount; i++) {
                    const startDate = record.getSublistValue({
                        sublistId: 'recmachcustrecord_zeta_ioi_insertionorder',
                        fieldId: 'custrecord_zeta_ioi_revrecstartdate',
                        line: i
                    });

                    const endDate = record.getSublistValue({
                        sublistId: 'recmachcustrecord_zeta_ioi_insertionorder',
                        fieldId: 'custrecord_zeta_ioi_revrecenddate',
                        line: i
                    });

                    if (startDate && endDate) {
                        const start = new Date(startDate);
                        const end = new Date(endDate);

                        log.debug(`Line ${i + 1} Dates`, `Start: ${start}, End: ${end}`);
                        // Rule 1: Start must be before End
                        if (end < start) {
                            alert(`Line ${i + 1}: End Date cannot be earlier than Start Date.`);
                            return false;
                        }

                        // Rule 2: Dates must be within campaign range
                        if (start < campaignStartDate || end > campaignEndDate) {
                            alert(`Line ${i + 1}: Dates must be within campaign period (${campaignStartDate.toISOString().split('T')[0]} - ${campaignEndDate.toISOString().split('T')[0]}).`);
                            return false;
                        }

                    }
                }

                return true;

            } catch (error) {
                console.error('Error in validation before save:', error);
                return false;
            }
        }

        return {
            pageInit: pageInit,
            fieldChanged: fieldChanged,
            validateLine: validateLine,
            saveRecord: saveRecord
        };
    });