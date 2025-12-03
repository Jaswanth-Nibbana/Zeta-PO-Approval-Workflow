/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @description Map/Reduce script for bulk Insertion Order approval processing
 */

define(['N/record', 'N/search', 'N/runtime', 'N/email', './zeta_lib_io_utils'], 
function(record, search, runtime, email, ioUtils) {

    /**
     * Get Input Data function
     * @returns {Array} Array of IO IDs to process
     */
    function getInputData() {
        try {
            const script = runtime.getCurrentScript();
            const backgroundProcessorId = script.getParameter({ name: 'custscript_io_bprid' });
            
            if (!backgroundProcessorId) {
                log.error('getInputData', 'No Background Processor ID provided');
                return [];
            }
            log.debug('getInputData - backgroundProcessorId', backgroundProcessorId);
            // Load the background processor record
            const backgroundProcessor = record.load({
                type: 'customrecord_zeta_io_backgroundprocessor',
                id: backgroundProcessorId
            });

            const ioIds = JSON.parse(backgroundProcessor.getValue('custrecord_zeta_io_data'));
            const action = backgroundProcessor.getValue('custrecord_zeta_io_action');
            
            log.debug('getInputData', `Processing action: ${action}, IOs: ${ioIds}`);
            
            if (!ioIds) {
                log.error('getInputData', 'No IO IDs provided');
                return [];
            }
            
            const inputData = [];
            
            // Create input data with context
            for (let ioId of ioIds) {
                if (ioId && ioId.trim()) {
                    inputData.push({
                        ioId: ioId.trim(),
                        action: action
                    });
                }
            }
            
            log.debug('getInputData', `Prepared ${inputData.length} records for processing`);
            
            // Update the status of the background processor record to "Processing"
            backgroundProcessor.setValue({
                fieldId: 'custrecord_zeta_io_status',
                value: ioUtils.BACKGROUND_PROCESSOR_STATUS.PROCESSING
            });
            backgroundProcessor.save();
            
            return inputData;
            
        } catch (error) {
            log.error('getInputData', 'Error in getInputData: ' + error.message);
            return [];
        }
    }

    /**
     * Map function
     * @param {Object} context
     */
    function map(context) {
        try {
            const inputData = JSON.parse(context.value);
            const ioId = inputData.ioId;
            const action = inputData.action;
            
            log.debug('map', `Processing IO ${ioId} for action: ${action}`);
            
            const script = runtime.getCurrentScript();
            const rejectReason = script.getParameter({ name: 'custscript_reject_reason' });
            const userId = script.getParameter({ name: 'custscript_user_id' });
            
            // Load the IO record
            const ioRecord = record.load({
                type: ioUtils.RECORD_TYPE,
                id: ioId
            });
            
            const currentStatus = ioRecord.getValue(ioUtils.FIELDS.APPROVAL_STATUS);
            let newStatus = currentStatus;
            let success = false;
            let errorMessage = '';
            
            // Get additional meaningful data from IO record
            const ioName = ioRecord.getValue('name') || `IO-${ioId}`;
            const customerName = ioRecord.getText('custrecord_zeta_io_customer') || 'Unknown Customer';
            const opportunityTotal = ioRecord.getValue('custrecord_zeta_io_sfopportunitytotal') || 0;
            
            try {
                // Determine new status based on action
                switch (action) {
                    case 'submit':
                        if (currentStatus === ioUtils.APPROVAL_STATUS.DRAFT) {
                            newStatus = ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW;
                        } else {
                            throw new Error(`Cannot submit IO with status: ${ioUtils.getStatusDisplayName(currentStatus)}`);
                        }
                        break;
                        
                    case 'review':
                        if (currentStatus === ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW) {
                            // Check if user can review (not the creator)
                            const createdBy = ioRecord.getValue('owner');
                            if (createdBy == userId) {
                                throw new Error('Cannot review IO that you created');
                            }
                            newStatus = ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL;
                        } else {
                            throw new Error(`Cannot review IO with status: ${ioUtils.getStatusDisplayName(currentStatus)}`);
                        }
                        break;
                        
                    case 'approve':
                        if (currentStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                            newStatus = ioUtils.APPROVAL_STATUS.APPROVED;
                        } else {
                            throw new Error(`Cannot approve IO with status: ${ioUtils.getStatusDisplayName(currentStatus)}`);
                        }
                        break;
                        
                        
                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
                
                // Update status and save
                ioRecord.setValue(ioUtils.FIELDS.APPROVAL_STATUS, newStatus);
                
                // Set approval tracking fields
                if (newStatus === ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL) {
                    ioRecord.setValue(ioUtils.FIELDS.REVIEWED_BY, userId);
                } else if (newStatus === ioUtils.APPROVAL_STATUS.APPROVED) {
                    ioRecord.setValue(ioUtils.FIELDS.APPROVED_BY, userId);
                }
                
                ioRecord.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });
                
                success = true;
                log.debug('map', `Successfully processed IO ${ioId}: ${ioUtils.getStatusDisplayName(currentStatus)} -> ${ioUtils.getStatusDisplayName(newStatus)}`);
                
            } catch (processingError) {
                errorMessage = processingError.message;
                log.error('map', `Error processing IO ${ioId}: ${errorMessage}`);
            }
            
            // Write result for summarize phase
            context.write({
                key: 'result',
                value: {
                    ioId: ioId,
                    ioName: ioName,
                    customerName: customerName,
                    opportunityTotal: opportunityTotal,
                    success: success,
                    errorMessage: errorMessage,
                    action: action,
                    oldStatus: ioUtils.getStatusDisplayName(currentStatus),
                    newStatus: ioUtils.getStatusDisplayName(newStatus)
                }
            });
            
        } catch (error) {
            log.error('map', `Error in map phase for ${context.value}: ${error.message}`);
            
            // Write error result
            context.write({
                key: 'result',
                value: {
                    ioId: ioId,
                    success: false,
                    errorMessage: error.message,
                    action: action,
                    oldStatus: 'unknown',
                    newStatus: 'unknown'
                }
            });
        }
    }

    /**
     * Summarize function
     * @param {Object} context
     */
    function summarize(context) {
        try {
            log.debug('summarize', 'Starting summarize phase');
            
            let totalSuccess = 0;
            let totalErrors = 0;
            let allErrors = [];
            let action = '';
            
            // Process map results directly (no reduce phase)
            context.output.iterator().each(function(key, value) {
                const result = JSON.parse(value);
                action = result.action;
                
                if (result.success) {
                    totalSuccess++;
                } else {
                    totalErrors++;
                    allErrors.push(`IO ${result.ioId}: ${result.errorMessage}`);
                }
                return true;
            });
            
            // Log map errors
            if (context.mapSummary.errors && context.mapSummary.errors.length > 0) {
                log.error('summarize', 'Map phase errors: ' + JSON.stringify(context.mapSummary.errors));
                // Add map errors to the error list
                context.mapSummary.errors.forEach(error => {
                    allErrors.push(`Map Error: ${error}`);
                    totalErrors++;
                });
            }
            
            // Create summary message
            let summaryMessage = `Bulk ${action} operation completed:\n`;
            summaryMessage += `- Successfully processed: ${totalSuccess} records\n`;
            summaryMessage += `- Errors: ${totalErrors} records\n`;
            
            if (allErrors.length > 0) {
                summaryMessage += '\nErrors:\n';
                allErrors.forEach(error => {
                    summaryMessage += `- ${error}\n`;
                });
            }
            
            log.audit('summarize', summaryMessage);
            
            // Update background processor record with final status
            const script = runtime.getCurrentScript();
            const backgroundProcessorId = script.getParameter({ name: 'custscript_io_bprid' });
            
            if (backgroundProcessorId) {
                try {
                    const backgroundProcessor = record.load({
                        type: 'customrecord_zeta_io_backgroundprocessor',
                        id: backgroundProcessorId
                    });
                    
                    // Set final status based on results
                    const finalStatus = totalErrors > 0 ? 
                        ioUtils.BACKGROUND_PROCESSOR_STATUS.FAILURE : 
                        ioUtils.BACKGROUND_PROCESSOR_STATUS.SUCCESS;
                    
                    backgroundProcessor.setValue({
                        fieldId: 'custrecord_zeta_io_status',
                        value: finalStatus
                    });
                    
                    // Set failure reason if there were errors
                    if (totalErrors > 0) {
                        const failureReason = allErrors.join('\n');
                        backgroundProcessor.setValue({
                            fieldId: 'custrecord_zeta_io_failurereason',
                            value: failureReason
                        });
                    }
                    
                    backgroundProcessor.save();
                    log.debug('summarize', `Updated background processor ${backgroundProcessorId} with final status: ${finalStatus}`);
                    
                } catch (updateError) {
                    log.error('summarize', `Error updating background processor record: ${updateError.message}`);
                }
            }
            
            // Send notification email to the requestor from the background processor
            if (backgroundProcessorId) {
                try {
                    const backgroundProcessor = record.load({
                        type: 'customrecord_zeta_io_backgroundprocessor',
                        id: backgroundProcessorId
                    });
                    
                    const requestorId = backgroundProcessor.getValue('custrecord_zeta_io_requestor');
                    
                    if (requestorId) {
                        email.send({
                            author: ioUtils.EMAIL_SENDER_ID,
                            recipients: [requestorId],
                            subject: `Bulk IO ${action} Operation Complete`,
                            body: summaryMessage
                        });
                        
                        log.debug('summarize', 'Notification email sent to requestor: ' + requestorId);
                    } else {
                        log.error('summarize', 'No requestor found in background processor record');
                    }
                } catch (emailError) {
                    log.error('summarize', 'Error sending notification email: ' + emailError.message);
                }
            }
            
        } catch (error) {
            log.error('summarize', 'Error in summarize phase: ' + error.message);
            
            // Try to update background processor with failure status
            try {
                const script = runtime.getCurrentScript();
                const backgroundProcessorId = script.getParameter({ name: 'custscript_io_bprid' });
                
                if (backgroundProcessorId) {
                    const backgroundProcessor = record.load({
                        type: 'customrecord_zeta_io_backgroundprocessor',
                        id: backgroundProcessorId
                    });
                    
                    backgroundProcessor.setValue({
                        fieldId: 'custrecord_zeta_io_status',
                        value: ioUtils.BACKGROUND_PROCESSOR_STATUS.FAILURE
                    });
                    
                    backgroundProcessor.setValue({
                        fieldId: 'custrecord_zeta_io_failurereason',
                        value: `Summarize phase error: ${error.message}`
                    });
                    
                    backgroundProcessor.save();
                }
            } catch (finalUpdateError) {
                log.error('summarize', `Error in final background processor update: ${finalUpdateError.message}`);
            }
        }
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});
