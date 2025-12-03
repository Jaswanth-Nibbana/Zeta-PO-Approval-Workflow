/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @description User Event Script to calculate and display Amount Invoiced for Insertion Orders
 */

define(['N/log', 'N/search', 'N/record', './zeta_lib_io_utils'], 
function(log, search, record, ioUtils) {

    /**
     * Search for invoices matching the Salesforce Opportunity ID and sum their amounts
     * @param {string} salesforceOppId - Salesforce Opportunity ID from the Insertion Order
     * @returns {number} Total amount from matching invoices
     */
    function calculateInvoicedAmount(salesforceOppId) {
        try {
            if (!salesforceOppId) {
                log.debug('calculateInvoicedAmount', 'No Salesforce Opportunity ID provided');
                return 0;
            }

            log.debug('calculateInvoicedAmount', `Searching for invoices with Salesforce ID: ${salesforceOppId}`);

            // Create search for invoices with matching Salesforce ID
            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['custbody_celigo_sfnc_salesforce_id', 'is', salesforceOppId],
                    'AND',
                    ['mainline', 'is', 'T'] // Only get main line to avoid duplicates
                ],
                columns: [
                    'internalid',
                    'tranid',
                    'total',
                    'custbody_celigo_sfnc_salesforce_id'
                ]
            });

            let totalAmount = 0;
            let invoiceCount = 0;

            // Run the search and sum the amounts
            invoiceSearch.run().each(function(result) {
                const invoiceTotal = parseFloat(result.getValue('total')) || 0;
                const invoiceId = result.getValue('tranid');
                
                totalAmount += invoiceTotal;
                invoiceCount++;
                
                log.debug('calculateInvoicedAmount', `Found invoice ${invoiceId} with amount: ${invoiceTotal}`);
                return true; // Continue processing
            });

            log.debug('calculateInvoicedAmount', `Total invoiced amount: ${totalAmount} from ${invoiceCount} invoices`);
            return totalAmount;

        } catch (error) {
            log.error('calculateInvoicedAmount', `Error calculating invoiced amount: ${error.message}`);
            return 0;
        }
    }

    /**
     * Before Load function - Set the Amount Invoiced field value
     * @param {Object} context
     */
    function beforeLoad(context) {
        try {
            const form = context.form;
            const newRecord = context.newRecord;
            const type = context.type;

            // Only process in view and edit modes
            if (type !== context.UserEventType.VIEW && type !== context.UserEventType.EDIT) {
                return;
            }

            log.debug('beforeLoad', `Processing Insertion Order ID: ${newRecord.id} in ${type} mode`);

            // Get the Salesforce Opportunity ID from the current record
            const salesforceOppId = newRecord.getValue('custrecord_zeta_io_salesforceoppid');
            
            if (!salesforceOppId) {
                log.debug('beforeLoad', 'No Salesforce Opportunity ID found on this Insertion Order');
                return;
            }

            // Calculate the total invoiced amount
            const invoicedAmount = calculateInvoicedAmount(salesforceOppId);

            // Get the Amount Invoiced field and set its default value
            const amountInvoicedField = form.getField({
                id: 'custrecord_zeta_io_amountinvoiced'
            });

            if (amountInvoicedField) {
                // Format the amount for display
                const formattedAmount = invoicedAmount.toFixed(2);
                amountInvoicedField.defaultValue = formattedAmount;
                
                log.debug('beforeLoad', `Set Amount Invoiced field to: ${formattedAmount}`);
            } else {
                log.error('beforeLoad', 'Could not find Amount Invoiced field on the form');
            }

        } catch (error) {
            log.error('beforeLoad', `Error in beforeLoad: ${error.message}`);
            // Don't throw error to avoid blocking the form load
        }
    }

    return {
        beforeLoad: beforeLoad
    };
});
