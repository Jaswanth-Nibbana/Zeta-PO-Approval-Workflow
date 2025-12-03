/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @description User Event script to restrict invoice actions unless IO is approved and validate budget constraints
 */

define(['N/record', 'N/search', 'N/log', './zeta_lib_io_utils'], function(record, search, log, ioUtils) {
    
    // Invoice fields that link to IO
    const INVOICE_FIELDS = {
        SALESFORCE_OPPORTUNITY_ID: 'custbody_celigo_sfnc_salesforce_id', // Header field
        SALESFORCE_LINE_ID: 'custcol_zeta_sfdc_opplineid' // Line field
    };

    /**
     * Function to validate IO approval status and budget before invoice creation/edit
     * @param {Object} context - Script context
     */
    function beforeSubmit(context) {
        try {
            log.debug('beforeSubmit', 'Starting IO approval and budget validation for invoice');
            
            // Only validate on create and edit operations
            if (context.type !== context.UserEventType.CREATE && 
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            const newRecord = context.newRecord;
            const recordType = newRecord.type;
            
            // Only process invoices
            if (recordType !== record.Type.INVOICE) {
                return;
            }

            // Get Salesforce Opportunity ID from invoice header
            const salesforceOppId = newRecord.getValue(INVOICE_FIELDS.SALESFORCE_OPPORTUNITY_ID);
            
            if (!salesforceOppId) {
                throw new Error('Opportunity / Line ID missing – cannot map to IO.');
            }

            // Find and validate the IO
            const ioRecord = findIOBySalesforceOppId(salesforceOppId);
            
            if (!ioRecord) {
                throw new Error(`No Insertion Order found for Salesforce Opportunity ID: ${salesforceOppId}`);
            }

            // Check if IO is approved
            const approvalStatus = ioRecord.approvalStatus;
            if (approvalStatus !== ioUtils.APPROVAL_STATUS.APPROVED) {
                const statusName = ioUtils.getStatusDisplayName(approvalStatus);
                throw new Error(`Invoice cannot be created. Insertion Order (${ioRecord.name}) status is "${statusName}". Only approved Insertion Orders can be invoiced.`);
            }

            // Check if IO is closed
            if (ioRecord.closed) {
                throw new Error(`Invoice cannot be created. Insertion Order (${ioRecord.name}) is closed.`);
            }

            // Validate customer and currency match
            validateCustomerAndCurrency(newRecord, ioRecord);

            // Validate line items and budget
            validateInvoiceLinesAndBudget(newRecord, ioRecord, context);

            log.debug('beforeSubmit', `IO validation and budget check passed for Opportunity ID: ${salesforceOppId}`);

        } catch (error) {
            log.error('beforeSubmit', `IO validation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Find IO record by Salesforce Opportunity ID
     * @param {string} salesforceOppId - Salesforce Opportunity ID
     * @returns {Object|null} IO record data or null if not found
     */
    function findIOBySalesforceOppId(salesforceOppId) {
        try {
            const searchObj = search.create({
                type: ioUtils.RECORD_TYPE,
                filters: [
                    ['custrecord_zeta_io_salesforceoppid', 'is', salesforceOppId]
                ],
                columns: [
                    'internalid',
                    'name',
                    'custrecord_zeta_io_approvalstatus',
                    'custrecord_zeta_io_closed',
                    'custrecord_zeta_io_customer',
                    'custrecord_zeta_io_currency',
                    'custrecord_zeta_io_budgettype',
                    'custrecord_zeta_io_ordertotal',
                    'custrecord_zeta_io_amountinvoiced',
                    'custrecord_zeta_io_isoverrideactive',
                    'custrecord_zeta_io_overrideamount',
                    'custrecord_zeta_io_salesforceoppid'
                ]
            });

            let ioRecord = null;
            searchObj.run().each(function(result) {
                ioRecord = {
                    id: result.getValue('internalid'),
                    name: result.getValue('name'),
                    approvalStatus: result.getValue('custrecord_zeta_io_approvalstatus'),
                    closed: result.getValue('custrecord_zeta_io_closed'),
                    customer: result.getValue('custrecord_zeta_io_customer'),
                    currency: result.getValue('custrecord_zeta_io_currency'),
                    budgetType: result.getValue('custrecord_zeta_io_budgettype'),
                    orderTotal: parseFloat(result.getValue('custrecord_zeta_io_ordertotal') || 0),
                    amountInvoiced: parseFloat(result.getValue('custrecord_zeta_io_amountinvoiced') || 0),
                    overrideActive: result.getValue('custrecord_zeta_io_isoverrideactive'),
                    overrideAmount: parseFloat(result.getValue('custrecord_zeta_io_overrideamount') || 0),
                    salesforceOppId: result.getValue('custrecord_zeta_io_salesforceoppid')
                };
                return false; // Stop after first result
            });

            return ioRecord;

        } catch (error) {
            log.error('findIOBySalesforceOppId', `Error searching for IO: ${error.message}`);
            throw new Error(`Error validating Insertion Order: ${error.message}`);
        }
    }

    /**
     * Validate customer and currency match between invoice and IO
     * @param {Record} invoiceRecord - Invoice record
     * @param {Object} ioRecord - IO record data
     */
    function validateCustomerAndCurrency(invoiceRecord, ioRecord) {
        const invoiceCustomer = invoiceRecord.getValue('entity');
        const invoiceCurrency = invoiceRecord.getValue('currency');

        if (invoiceCustomer != ioRecord.customer) {
            throw new Error('Invoice customer must match the Insertion Order customer.');
        }

        if (invoiceCurrency != ioRecord.currency) {
            throw new Error('Invoice currency must match the Insertion Order currency.');
        }
    }

    /**
     * Validate invoice line items and budget constraints
     * @param {Record} invoiceRecord - Invoice record
     * @param {Object} ioRecord - IO record data
     * @param {Object} context - Script context
     */
    function validateInvoiceLinesAndBudget(invoiceRecord, ioRecord, context) {
        const lineCount = invoiceRecord.getLineCount({ sublistId: 'item' });
        
        if (lineCount === 0) {
            throw new Error('Invoice must have at least one line item.');
        }

        let totalInvoiceAmount = 0;
        const invoiceDate = invoiceRecord.getValue('trandate');
        const invoiceMonth = getMonthYear(invoiceDate);
        
        // Get invoice header date range for monthly validation
        const invoiceStartDate = invoiceRecord.getValue('startdate');
        const invoiceEndDate = invoiceRecord.getValue('enddate');

        // Get IO line items for validation
        const ioLineItems = getIOLineItems(ioRecord.id);

        // Validate each invoice line
        for (let i = 0; i < lineCount; i++) {
            const salesforceLineId = invoiceRecord.getSublistValue({
                sublistId: 'item',
                fieldId: INVOICE_FIELDS.SALESFORCE_LINE_ID,
                line: i
            });

            const invoiceItem = invoiceRecord.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            const lineAmount = parseFloat(invoiceRecord.getSublistValue({
                sublistId: 'item',
                fieldId: 'amount',
                line: i
            }) || 0);

            totalInvoiceAmount += lineAmount;

            if (!salesforceLineId) {
                throw new Error('Opportunity / Line ID missing – cannot map to IO.');
            }

            // Find matching IO line item
            const matchingIOLine = ioLineItems.find(line => line.salesforceLineId === salesforceLineId);
            
            if (!matchingIOLine) {
                throw new Error('Line does not match an approved IO line.');
            }

            // Validate item match
            if (invoiceItem != matchingIOLine.item) {
                throw new Error('Line does not match an approved IO line.');
            }

            // Apply budget validation based on budget type
            if (ioRecord.budgetType === ioUtils.BUDGET_TYPES.MONTHLY_FIXED) {
                validateMonthlyFixedBudget(matchingIOLine, lineAmount, invoiceStartDate, invoiceEndDate, context);
            }
        }

        // Apply overall budget validation
        validateOverallBudget(ioRecord, totalInvoiceAmount, invoiceStartDate, invoiceEndDate, context);
    }

    /**
     * Get IO line items
     * @param {string} ioId - IO internal ID
     * @returns {Array} Array of IO line items
     */
    function getIOLineItems(ioId) {
        try {
            const searchObj = search.create({
                type: 'customrecord_zeta_insertionorderitems',
                filters: [
                    ['custrecord_zeta_ioi_insertionorder', 'anyof', ioId]
                ],
                columns: [
                    'internalid',
                    'custrecord_zeta_ioi_sforderlineid',
                    'custrecord_zeta_ioi_item',
                    'custrecord_zeta_ioi_amount',
                    'custrecord_zeta_ioi_revrecstartdate',
                    'custrecord_zeta_ioi_revrecenddate'
                ]
            });

            const ioLineItems = [];
            searchObj.run().each(function(result) {
                ioLineItems.push({
                    id: result.getValue('internalid'),
                    salesforceLineId: result.getValue('custrecord_zeta_ioi_sforderlineid'),
                    item: result.getValue('custrecord_zeta_ioi_item'),
                    amount: parseFloat(result.getValue('custrecord_zeta_ioi_amount') || 0),
                    revRecStartDate: result.getValue('custrecord_zeta_ioi_revrecstartdate'),
                    revRecEndDate: result.getValue('custrecord_zeta_ioi_revrecenddate')
                });
                return true;
            });

            return ioLineItems;

        } catch (error) {
            log.error('getIOLineItems', `Error retrieving IO line items: ${error.message}`);
            throw new Error(`Error retrieving IO line items: ${error.message}`);
        }
    }

    /**
     * Get month/year string from date
     * @param {Date} date - Date object
     * @returns {string} Month-year string (e.g., "2025-01")
     */
    function getMonthYear(date) {
        if (!date) return null;
        const d = new Date(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        return `${year}-${month}`;
    }

    /**
     * Validate overall budget based on budget type
     * @param {Object} ioRecord - IO record data
     * @param {number} invoiceAmount - Total invoice amount
     * @param {Date} invoiceStartDate - Invoice start date
     * @param {Date} invoiceEndDate - Invoice end date
     * @param {Object} context - Script context
     */
    function validateOverallBudget(ioRecord, invoiceAmount, invoiceStartDate, invoiceEndDate, context) {
        try {
            const budgetType = ioRecord.budgetType;
            
            if (budgetType === ioUtils.BUDGET_TYPES.FLUID) {
                validateFluidBudget(ioRecord, invoiceAmount, context);
            } else if (budgetType === ioUtils.BUDGET_TYPES.MONTHLY_FLUID) {
                validateMonthlyFluidBudget(ioRecord, invoiceAmount, invoiceStartDate, invoiceEndDate, context);
            }
            // Monthly Fixed is validated at line level

        } catch (error) {
            log.error('validateOverallBudget', `Budget validation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get total invoiced amount from actual invoice search
     * @param {Object} ioRecord - IO record data
     * @param {Object} context - Script context
     * @returns {number} Total invoiced amount
     */
    function getInvoicedAmountFromSearch(ioRecord, context) {
        try {
            // Get Salesforce Opportunity ID from IO record
            const salesforceOppId = ioRecord.salesforceOppId;
            
            if (!salesforceOppId) {
                log.debug('getInvoicedAmountFromSearch', 'No Salesforce Opportunity ID found, returning 0');
                return 0;
            }

            // Get current invoice ID if editing
            const currentInvoiceId = context.type === context.UserEventType.EDIT ? 
                context.newRecord.id : null;

            // Build search filters
            const searchFilters = [
                ["type", "anyof", "CustInvc"], 
                "AND", 
                ["mainline", "is", "T"], 
                "AND", 
                ["status", "noneof", "CustInvc:V", "CustInvc:E"],
                "AND",
                ["custbody_celigo_sfnc_salesforce_id", "is", salesforceOppId]
            ];

            // Exclude current invoice if editing
            if (currentInvoiceId) {
                searchFilters.push("AND");
                searchFilters.push(["internalid", "noneof", currentInvoiceId]);
            }

            log.debug('getInvoicedAmountFromSearch', `Searching invoices for SFDC Opp ID: ${salesforceOppId}, excluding invoice ID: ${currentInvoiceId || 'none'}`);

            // Create and run search
            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: searchFilters,
                columns: [
                    'internalid',
                    'tranid',
                    'fxamount'
                ]
            });

            let totalInvoiced = 0;
            let invoiceCount = 0;

            invoiceSearch.run().each(function(result) {
                const invoiceTotal = parseFloat(result.getValue('fxamount') || 0);
                totalInvoiced += invoiceTotal;
                invoiceCount++;
                
                log.debug('getInvoicedAmountFromSearch', `Found invoice ${result.getValue('tranid')} (ID: ${result.getValue('internalid')}) with total: ${invoiceTotal}`);
                return true;
            });

            log.debug('getInvoicedAmountFromSearch', `Total invoiced amount from ${invoiceCount} invoices: ${totalInvoiced}`);
            return totalInvoiced;

        } catch (error) {
            log.error('getInvoicedAmountFromSearch', `Error calculating invoiced amount: ${error.message}`);
            // Return 0 on error to avoid blocking invoice creation
            return 0;
        }
    }

    /**
     * Validate fluid budget
     * @param {Object} ioRecord - IO record data
     * @param {number} invoiceAmount - Invoice amount
     * @param {Object} context - Script context
     */
    function validateFluidBudget(ioRecord, invoiceAmount, context) {
        const ioBudget = ioRecord.orderTotal;
        const amountInvoiced = getInvoicedAmountFromSearch(ioRecord, context);
        const amountCredited = getCreditedAmount(ioRecord.id);
        const overrideAmount = ioRecord.overrideActive ? ioRecord.overrideAmount : 0;
        
        // Remaining Budget = IO Budget – (Invoiced – Credited) + Override Amount
        const remainingBudget = ioBudget - (amountInvoiced - amountCredited) + overrideAmount;
        
        log.debug('validateFluidBudget', `IO Budget: ${ioBudget}, Invoiced: ${amountInvoiced}, Credited: ${amountCredited}, Override: ${overrideAmount}, Remaining: ${remainingBudget}, Invoice Amount: ${invoiceAmount}`);
        
        if (remainingBudget < invoiceAmount) {
            throw new Error('Invoice exceeds available IO budget.');
        }
    }

    /**
     * Validate exact date match between invoice and IO line periods
     * @param {Date} invoiceStartDate - Invoice start date
     * @param {Date} invoiceEndDate - Invoice end date
     * @param {Date} lineStartDate - IO line start date
     * @param {Date} lineEndDate - IO line end date
     * @returns {boolean} True if dates match exactly
     */
    function validateExactDateMatch(invoiceStartDate, invoiceEndDate, lineStartDate, lineEndDate) {
        if (!invoiceStartDate || !invoiceEndDate || !lineStartDate || !lineEndDate) {
            return false;
        }
        
        const invStart = new Date(invoiceStartDate).getTime();
        const invEnd = new Date(invoiceEndDate).getTime();
        const lineStart = new Date(lineStartDate).getTime();
        const lineEnd = new Date(lineEndDate).getTime();
        
        return invStart === lineStart && invEnd === lineEnd;
    }

    /**
     * Get IO lines for exact date range match
     * @param {string} ioId - IO internal ID
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     * @returns {Array} Array of matching IO line items
     */
    function getIOLinesForExactDateRange(ioId, startDate, endDate) {
        try {
            const searchObj = search.create({
                type: 'customrecord_zeta_insertionorderitems',
                filters: [
                    ['custrecord_zeta_ioi_insertionorder', 'anyof', ioId],
                    'AND',
                    ['custrecord_zeta_ioi_revrecstartdate', 'on', startDate],
                    'AND',
                    ['custrecord_zeta_ioi_revrecenddate', 'on', endDate]
                ],
                columns: [
                    'internalid',
                    'custrecord_zeta_ioi_sforderlineid',
                    'custrecord_zeta_ioi_item',
                    'custrecord_zeta_ioi_amount',
                    'custrecord_zeta_ioi_revrecstartdate',
                    'custrecord_zeta_ioi_revrecenddate'
                ]
            });

            const matchingLines = [];
            searchObj.run().each(function(result) {
                matchingLines.push({
                    id: result.getValue('internalid'),
                    salesforceLineId: result.getValue('custrecord_zeta_ioi_sforderlineid'),
                    item: result.getValue('custrecord_zeta_ioi_item'),
                    amount: parseFloat(result.getValue('custrecord_zeta_ioi_amount') || 0),
                    revRecStartDate: result.getValue('custrecord_zeta_ioi_revrecstartdate'),
                    revRecEndDate: result.getValue('custrecord_zeta_ioi_revrecenddate')
                });
                return true;
            });

            return matchingLines;

        } catch (error) {
            log.error('getIOLinesForExactDateRange', `Error retrieving IO lines for date range: ${error.message}`);
            return [];
        }
    }

    /**
     * Get invoiced amount for specific date range
     * @param {Object} ioRecord - IO record data
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     * @param {string} lineId - Optional line ID for line-specific calculation
     * @param {Object} context - Script context
     * @returns {number} Total invoiced amount for the date range
     */
    function getInvoicedAmountForDateRange(ioRecord, startDate, endDate, lineId, context) {
        try {
            const salesforceOppId = ioRecord.salesforceOppId;
            
            if (!salesforceOppId) {
                return 0;
            }

            // Get current invoice ID if editing
            const currentInvoiceId = context.type === context.UserEventType.EDIT ? 
                context.newRecord.id : null;

            // Build search filters
            const searchFilters = [
                ["type", "anyof", "CustInvc"], 
                "AND", 
                ["mainline", "is", "F"], // Line level for date range filtering
                "AND", 
                ["status", "noneof", "CustInvc:V", "CustInvc:E"],
                "AND",
                ["custbody_celigo_sfnc_salesforce_id", "is", salesforceOppId]
            ];

            // Add date range filters
            if (startDate) {
                searchFilters.push("AND");
                searchFilters.push(["custcol_startdate", "on", startDate]);
            }
            if (endDate) {
                searchFilters.push("AND");
                searchFilters.push(["custcol_enddate", "on", endDate]);
            }

            // Add line ID filter if specified
            if (lineId) {
                searchFilters.push("AND");
                searchFilters.push(["custcol_zeta_sfdc_opplineid", "is", lineId]);
            }

            // Exclude current invoice if editing
            if (currentInvoiceId) {
                searchFilters.push("AND");
                searchFilters.push(["internalid", "noneof", currentInvoiceId]);
            }

            // Create and run search
            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: searchFilters,
                columns: [
                    'internalid',
                    'tranid',
                    'amount'
                ]
            });

            let totalInvoiced = 0;
            let invoiceCount = 0;

            invoiceSearch.run().each(function(result) {
                const lineAmount = parseFloat(result.getValue('amount') || 0);
                totalInvoiced += lineAmount;
                invoiceCount++;
                return true;
            });

            log.debug('getInvoicedAmountForDateRange', `Total invoiced amount for date range ${startDate} to ${endDate}: ${totalInvoiced} from ${invoiceCount} lines`);
            return totalInvoiced;

        } catch (error) {
            log.error('getInvoicedAmountForDateRange', `Error calculating invoiced amount for date range: ${error.message}`);
            return 0;
        }
    }

    /**
     * Validate monthly fluid budget
     * @param {Object} ioRecord - IO record data
     * @param {number} invoiceAmount - Invoice amount
     * @param {Date} invoiceStartDate - Invoice start date
     * @param {Date} invoiceEndDate - Invoice end date
     * @param {Object} context - Script context
     */
    function validateMonthlyFluidBudget(ioRecord, invoiceAmount, invoiceStartDate, invoiceEndDate, context) {
        try {
            if (!invoiceStartDate || !invoiceEndDate) {
                throw new Error('Invoice start and end dates are required for monthly fluid budget validation.');
            }

            // Get all IO lines that match the exact date range
            const matchingIOLines = getIOLinesForExactDateRange(ioRecord.id, invoiceStartDate, invoiceEndDate);
            
            if (matchingIOLines.length === 0) {
                throw new Error(`Invoice date range (${invoiceStartDate} to ${invoiceEndDate}) does not match any approved IO line period.`);
            }

            // Calculate total budget for this period (sum of all matching lines)
            let totalPeriodBudget = 0;
            matchingIOLines.forEach(line => {
                totalPeriodBudget += line.amount;
            });

            // Calculate total invoiced amount for this period (all lines)
            const totalInvoicedForPeriod = getInvoicedAmountForDateRange(ioRecord, invoiceStartDate, invoiceEndDate, null, context);
            
            // Calculate credited amount for this period
            const totalCreditedForPeriod = getCreditedAmountForDateRange(ioRecord.id, invoiceStartDate, invoiceEndDate);
            
            // Apply override if active
            const overrideAmount = ioRecord.overrideActive ? ioRecord.overrideAmount : 0;
            
            // Remaining Budget = Period Budget – (Invoiced – Credited) + Override Amount
            const remainingPeriodBudget = totalPeriodBudget - (totalInvoicedForPeriod - totalCreditedForPeriod) + overrideAmount;
            
            log.debug('validateMonthlyFluidBudget', `Period Budget: ${totalPeriodBudget}, Invoiced: ${totalInvoicedForPeriod}, Credited: ${totalCreditedForPeriod}, Override: ${overrideAmount}, Remaining: ${remainingPeriodBudget}, Invoice Amount: ${invoiceAmount}`);
            
            if (remainingPeriodBudget < invoiceAmount) {
                throw new Error(`Invoice exceeds available monthly budget for period ${invoiceStartDate} to ${invoiceEndDate}.`);
            }

        } catch (error) {
            log.error('validateMonthlyFluidBudget', `Monthly fluid budget validation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate monthly fixed budget for a specific line
     * @param {Object} ioLine - IO line item data
     * @param {number} lineAmount - Invoice line amount
     * @param {Date} invoiceStartDate - Invoice start date
     * @param {Date} invoiceEndDate - Invoice end date
     * @param {Object} context - Script context
     */
    function validateMonthlyFixedBudget(ioLine, lineAmount, invoiceStartDate, invoiceEndDate, context) {
        try {
            if (!invoiceStartDate || !invoiceEndDate) {
                throw new Error('Invoice start and end dates are required for monthly fixed budget validation.');
            }

            // Validate exact date match with IO line's revenue recognition period
            if (!validateExactDateMatch(invoiceStartDate, invoiceEndDate, ioLine.revRecStartDate, ioLine.revRecEndDate)) {
                throw new Error(`Invoice date range (${invoiceStartDate} to ${invoiceEndDate}) does not exactly match IO line period (${ioLine.revRecStartDate} to ${ioLine.revRecEndDate}).`);
            }

            // Get the IO record to access salesforceOppId
            const ioRecord = { salesforceOppId: context.newRecord.getValue(INVOICE_FIELDS.SALESFORCE_OPPORTUNITY_ID) };
            
            // Calculate invoiced amount for this specific line and period
            const lineInvoicedAmount = getInvoicedAmountForDateRange(ioRecord, invoiceStartDate, invoiceEndDate, ioLine.salesforceLineId, context);
            
            // Calculate credited amount for this specific line and period
            const lineCreditedAmount = getCreditedAmountForLineAndDateRange(ioLine.id, invoiceStartDate, invoiceEndDate);
            
            // Remaining Budget = Line Budget – (Invoiced – Credited)
            const remainingLineBudget = ioLine.amount - (lineInvoicedAmount - lineCreditedAmount);
            
            log.debug('validateMonthlyFixedBudget', `Line Budget: ${ioLine.amount}, Line Invoiced: ${lineInvoicedAmount}, Line Credited: ${lineCreditedAmount}, Remaining: ${remainingLineBudget}, Invoice Line Amount: ${lineAmount}`);
            
            if (remainingLineBudget < lineAmount) {
                throw new Error(`Invoice line exceeds monthly fixed budget for period ${invoiceStartDate} to ${invoiceEndDate}.`);
            }

        } catch (error) {
            log.error('validateMonthlyFixedBudget', `Monthly fixed budget validation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get credited amount for a specific date range
     * @param {string} ioId - IO internal ID
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     * @returns {number} Total credited amount for the date range
     */
    function getCreditedAmountForDateRange(ioId, startDate, endDate) {
        // For now, return 0 as credit memo tracking would require additional implementation
        // This function can be enhanced to search for credit memos linked to the IO for specific date ranges
        return 0;
    }

    /**
     * Get credited amount for a specific line and date range
     * @param {string} ioLineId - IO line internal ID
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     * @returns {number} Total credited amount for the line and date range
     */
    function getCreditedAmountForLineAndDateRange(ioLineId, startDate, endDate) {
        // For now, return 0 as credit memo tracking would require additional implementation
        // This function can be enhanced to search for credit memos linked to specific IO lines for specific date ranges
        return 0;
    }

    /**
     * Get credited amount for an IO
     * @param {string} ioId - IO internal ID
     * @returns {number} Total credited amount
     */
    function getCreditedAmount(ioId) {
        // For now, return 0 as credit memo tracking would require additional implementation
        // This function can be enhanced to search for credit memos linked to the IO
        return 0;
    }

    return {
        beforeSubmit: beforeSubmit
    };
});
