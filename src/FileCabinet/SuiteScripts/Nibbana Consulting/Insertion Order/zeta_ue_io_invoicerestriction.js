/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @description User Event script to restrict invoice actions unless IO is approved and validate budget constraints
 */

define(['N/record', 'N/search', 'N/log', 'N/format', './zeta_lib_io_utils'], function (record, search, log, format, ioUtils) {

    // Invoice fields that link to IO
    const INVOICE_FIELDS = {
        SALESFORCE_OPPORTUNITY_ID: 'custbody_celigo_sfnc_salesforce_id', // Header field
        IO_REFERENCE: 'custbody_zeta_io_insertionorder', // Direct IO reference field
        SALESFORCE_LINE_ID: 'custcol_zeta_sfdc_opplineid', // Line field
        INVOICE_TYPE: 'custbody_zeta_invoicetype', // Invoice type field
        ORIGINAL_CREDIT_MEMO_NO: 'custbody_zeta_origcmno', // Original credit memo number field
        NEW_INVOICE_NUMBER: 'custbody_zeta_ra_newinvoicenumner' // New invoice number field on credit memo
    };

    const subBuList = ioUtils.getSubBuListArray();

    function beforeLoad(context) {
        var newRecord = context.newRecord;
        var recordType = newRecord.type;
        if (recordType !== record.Type.INVOICE) {
            return;
        }

        if (context.type === context.UserEventType.COPY) {
            newRecord.setValue('custbody_zeta_io_insertionorder', '')
            newRecord.setValue('custbody_zeta_origcmno', '')
            newRecord.setValue('custbody_zeta_invoicetype', '')
            newRecord.setValue('custbody_celigo_sfnc_salesforce_id', '')
        }
    }

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

            var cust = newRecord.getValue('entity');
            log.debug('beforeSubmit', 'Invoice Customer: ' + cust);

            var custRec = record.load({
                type: record.Type.CUSTOMER,
                id: cust
            });

            var isIoMandatory = custRec.getValue('custentity_zeta_io_is_iomandatory');
            log.debug('beforeSubmit', 'Is IO Mandatory for Customer: ' + isIoMandatory);

            if (!isIoMandatory) {
                log.debug('beforeSubmit', 'IO is not mandatory for this customer. Skipping IO validations.');
                return;
            }

            // Skip validation if sub-Bu is not in the specified list
            // even if one line item sub-Bu does not match, skips validation
            var itemLineCount = newRecord.getLineCount({ sublistId: 'item' });
            log.debug('beforeSubmit', 'Item line count: ' + itemLineCount);
            var allLinesValid = true;
            var invalidLine = null;
            for (var i = 0; i < itemLineCount; i++) {
                log.debug('beforeSubmit', 'Checking line ' + (i + 1));
                var subBu = newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'class',
                    line: i
                });
                log.debug('beforeSubmit', subBuList);
                log.debug('!subBuList.includes(subBu)', !subBuList.includes(subBu))
                    if (!subBuList.includes(subBu)) {
                        allLinesValid = false;
                        invalidLine = i + 1;
                        break;
                    }
                
            }

            if (!allLinesValid) {
                log.debug('beforeSubmit', 'Line ' + invalidLine + ' sub-Bu is not in the specified list. Skipping IO validations.');
                return;
            }

            // Get Salesforce Opportunity ID from invoice header
            const salesforceOppId = newRecord.getValue(INVOICE_FIELDS.SALESFORCE_OPPORTUNITY_ID);

            if (!salesforceOppId) {
                throw new Error('Salesforce Opportunity ID missing – cannot map to IO.');
            }

            // Find and validate the IO
            const ioRecord = findIOBySalesforceOppId(salesforceOppId);

            if (!ioRecord) {
                throw new Error(`No Insertion Order found for Salesforce Opportunity ID: ${salesforceOppId}`);
            }

            if (salesforceOppId) {
                // Set the IO reference on the invoice only if Salesforce Opportunity ID is present
                newRecord.setValue(INVOICE_FIELDS.IO_REFERENCE, ioRecord.id);
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
            searchObj.run().each(function (result) {
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

        // Group invoice lines by Salesforce Line ID for monthly fixed budget validation
        const invoiceLineGroups = {};

        // First pass: collect and group all invoice lines
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
                throw new Error('Line ID missing – cannot map to IO.');
            }

            // Find matching IO line item
            const matchingIOLine = ioLineItems.find(line => line.salesforceLineId === salesforceLineId);

            if (!matchingIOLine) {
                throw new Error('Line does not match an approved IO line.');
            }


            // Group lines by Salesforce Line ID for monthly fixed budget validation
            if (ioRecord.budgetType === ioUtils.BUDGET_TYPES.MONTHLY_FIXED) {
                if (!invoiceLineGroups[salesforceLineId]) {
                    invoiceLineGroups[salesforceLineId] = {
                        ioLine: matchingIOLine,
                        totalAmount: 0,
                        lineCount: 0
                    };
                }
                invoiceLineGroups[salesforceLineId].totalAmount += lineAmount;
                invoiceLineGroups[salesforceLineId].lineCount++;
            }
        }

        // Second pass: validate monthly fixed budget for each Salesforce Line ID group
        if (ioRecord.budgetType === ioUtils.BUDGET_TYPES.MONTHLY_FIXED) {
            for (const salesforceLineId in invoiceLineGroups) {
                const group = invoiceLineGroups[salesforceLineId];
                validateMonthlyFixedBudget(group.ioLine, group.totalAmount, invoiceStartDate, invoiceEndDate, context, ioRecord);

                log.debug('validateInvoiceLinesAndBudget', `Monthly fixed budget validation for Salesforce Line ID ${salesforceLineId}: ${group.lineCount} invoice lines totaling ${group.totalAmount} against IO line budget ${group.ioLine.amount}`);
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
            searchObj.run().each(function (result) {
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
     * Check if invoice spans multiple months
     * @param {Date} startDate - Invoice start date
     * @param {Date} endDate - Invoice end date
     * @returns {boolean} True if invoice spans multiple months
     */
    function isMultiMonth(startDate, endDate) {
        if (!startDate || !endDate) return false;
        return getMonthYear(startDate) !== getMonthYear(endDate);
    }

    /**
     * Get invoice month (assumes single month after validation)
     * @param {Date} startDate - Invoice start date
     * @param {Date} endDate - Invoice end date
     * @returns {Object} Object with year and month
     */
    function getInvoiceMonth(startDate, endDate) {
        if (!startDate) return null;
        const d = new Date(startDate);
        return {
            year: d.getFullYear(),
            month: d.getMonth() + 1, // 1-based month
            monthYear: getMonthYear(startDate)
        };
    }

    /**
     * Get IO lines that overlap with specific month
     * @param {string} ioId - IO internal ID
     * @param {number} year - Year (e.g., 2025)
     * @param {number} month - Month (1-12)
     * @returns {Array} Array of matching IO line items
     */
    function getIOLinesForMonth(ioId, year, month) {
        try {
            // Create month boundaries
            const monthStart = new Date(year, month - 1, 1); // First day of month
            const monthEnd = new Date(year, month, 0); // Last day of month

            // Format dates for NetSuite search
            const formattedMonthStart = format.format({
                value: monthStart,
                type: format.Type.DATE
            });

            const formattedMonthEnd = format.format({
                value: monthEnd,
                type: format.Type.DATE
            });

            log.debug('getIOLinesForMonth', `Searching for IO lines overlapping with month ${year}-${String(month).padStart(2, '0')} (${formattedMonthStart} to ${formattedMonthEnd})`);

            const searchObj = search.create({
                type: 'customrecord_zeta_insertionorderitems',
                filters: [
                    ['custrecord_zeta_ioi_insertionorder', 'anyof', ioId],
                    'AND',
                    // IO line overlaps with month if: (line_start <= month_end) AND (line_end >= month_start)
                    ['custrecord_zeta_ioi_revrecstartdate', 'onorbefore', formattedMonthEnd],
                    'AND',
                    ['custrecord_zeta_ioi_revrecenddate', 'onorafter', formattedMonthStart]
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
            searchObj.run().each(function (result) {
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

            log.debug('getIOLinesForMonth', `Found ${matchingLines.length} IO lines for ${year}-${String(month).padStart(2, '0')}`);
            return matchingLines;

        } catch (error) {
            log.error('getIOLinesForMonth', `Error retrieving IO lines for month: ${error.message}`);
            return [];
        }
    }

    /**
     * Get invoiced amount for specific month
     * @param {Object} ioRecord - IO record data
     * @param {number} year - Year (e.g., 2025)
     * @param {number} month - Month (1-12)
     * @param {Object} context - Script context
     * @returns {number} Total invoiced amount for the month
     */
    function getInvoicedAmountForMonth(ioRecord, year, month, context) {
        try {
            const ioId = ioRecord.id;

            if (!ioId) {
                return 0;
            }

            // Get current invoice ID if editing
            const currentInvoiceId = context.type === context.UserEventType.EDIT ?
                context.newRecord.id : null;

            // Create month boundaries
            const monthStart = new Date(year, month - 1, 1);
            const monthEnd = new Date(year, month, 0);

            // Format dates for NetSuite search
            const formattedMonthStart = format.format({
                value: monthStart,
                type: format.Type.DATE
            });

            const formattedMonthEnd = format.format({
                value: monthEnd,
                type: format.Type.DATE
            });

            // Build search filters
            const searchFilters = [
                ["type", "anyof", "CustInvc"],
                "AND",
                ["mainline", "is", "T"],
                "AND",
                ["status", "noneof", "CustInvc:V", "CustInvc:E"],
                "AND",
                ["custbody_zeta_io_insertionorder", "anyof", ioId],
                "AND",
                // Invoice overlaps with month if: (invoice_start <= month_end) AND (invoice_end >= month_start)
                ["startdate", "onorbefore", formattedMonthEnd],
                "AND",
                ["enddate", "onorafter", formattedMonthStart]
            ];

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
                    search.createColumn({
                        name: 'formulacurrency',
                        formula: '{fxamount} - NVL({taxtotal},0)',
                        label: 'Amount Without Tax'
                    })
                ]
            });

            let totalInvoiced = 0;
            let invoiceCount = 0;

            invoiceSearch.run().each(function (result) {
                const invoiceTotal = parseFloat(result.getValue({ name: 'formulacurrency', formula: '{fxamount} - NVL({taxtotal},0)' }) || 0);
                totalInvoiced += invoiceTotal;
                invoiceCount++;

                log.debug('getInvoicedAmountForMonth', `Found invoice ${result.getValue('tranid')} (ID: ${result.getValue('internalid')}) with total (without tax): ${invoiceTotal}`);
                return true;
            });

            log.debug('getInvoicedAmountForMonth', `Total invoiced amount for ${year}-${String(month).padStart(2, '0')}: ${totalInvoiced} from ${invoiceCount} invoices`);
            return totalInvoiced;

        } catch (error) {
            log.error('getInvoicedAmountForMonth', `Error calculating invoiced amount for month: ${error.message}`);
            return 0;
        }
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
            const ioId = ioRecord.id;

            if (!ioId) {
                log.debug('getInvoicedAmountFromSearch', 'No IO ID found, returning 0');
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
                ["custbody_zeta_io_insertionorder", "anyof", ioId]
            ];

            // Exclude current invoice if editing
            if (currentInvoiceId) {
                searchFilters.push("AND");
                searchFilters.push(["internalid", "noneof", currentInvoiceId]);
            }

            log.debug('getInvoicedAmountFromSearch', `Searching invoices for IO ID: ${ioId}, excluding invoice ID: ${currentInvoiceId || 'none'}`);

            // Create and run search
            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: searchFilters,
                columns: [
                    'internalid',
                    'tranid',
                    search.createColumn({
                        name: 'formulacurrency',
                        formula: '{fxamount} - NVL({taxtotal},0)',
                        label: 'Amount Without Tax'
                    })
                ]
            });

            let totalInvoiced = 0;
            let invoiceCount = 0;

            invoiceSearch.run().each(function (result) {
                const invoiceTotal = parseFloat(result.getValue({ name: 'formulacurrency', formula: '{fxamount} - NVL({taxtotal},0)' }) || 0);
                totalInvoiced += invoiceTotal;
                invoiceCount++;

                log.debug('getInvoicedAmountFromSearch', `Found invoice ${result.getValue('tranid')} (ID: ${result.getValue('internalid')}) with total (without tax): ${invoiceTotal}`);
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
        const amountCredited = getCreditedAmount(ioRecord);
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
            searchObj.run().each(function (result) {
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
            const ioId = ioRecord.id;

            if (!ioId) {
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
                ["custbody_zeta_io_insertionorder", "anyof", ioId]
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

            invoiceSearch.run().each(function (result) {
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

            // Check if invoice spans multiple months - not allowed for monthly fluid budget
            if (isMultiMonth(invoiceStartDate, invoiceEndDate)) {
                throw new Error('Monthly fluid budget invoices cannot span multiple months.');
            }

            // Get the invoice month
            const invoiceMonth = getInvoiceMonth(invoiceStartDate, invoiceEndDate);
            if (!invoiceMonth) {
                throw new Error('Unable to determine invoice month for budget validation.');
            }

            log.debug('validateMonthlyFluidBudget', `Validating monthly fluid budget for ${invoiceMonth.monthYear}`);

            // Get all IO lines that overlap with the invoice month
            const matchingIOLines = getIOLinesForMonth(ioRecord.id, invoiceMonth.year, invoiceMonth.month);

            if (matchingIOLines.length === 0) {
                throw new Error(`No approved IO lines found for invoice month ${invoiceMonth.monthYear}.`);
            }

            // Calculate total budget for this month (sum of all matching lines)
            let totalMonthlyBudget = 0;
            matchingIOLines.forEach(line => {
                totalMonthlyBudget += line.amount;
                log.debug('validateMonthlyFluidBudget', `Including IO line ${line.id} (${line.salesforceLineId}) with amount ${line.amount} for month ${invoiceMonth.monthYear}`);
            });

            // Calculate total invoiced amount for this month
            const totalInvoicedForMonth = getInvoicedAmountForMonth(ioRecord, invoiceMonth.year, invoiceMonth.month, context);

            // Calculate credited amount for this month
            const totalCreditedForMonth = getCreditedAmountForMonth(ioRecord, invoiceMonth.year, invoiceMonth.month);

            // Apply override if active (note: override applies to overall IO, not per month)
            const overrideAmount = ioRecord.overrideActive ? ioRecord.overrideAmount : 0;

            // Remaining Budget = Monthly Budget – (Invoiced – Credited) + Override Amount
            const remainingMonthlyBudget = totalMonthlyBudget - (totalInvoicedForMonth - totalCreditedForMonth) + overrideAmount;

            log.debug('validateMonthlyFluidBudget', `Monthly Budget: ${totalMonthlyBudget}, Invoiced: ${totalInvoicedForMonth}, Credited: ${totalCreditedForMonth}, Override: ${overrideAmount}, Remaining: ${remainingMonthlyBudget}, Invoice Amount: ${invoiceAmount}`);

            if (remainingMonthlyBudget < invoiceAmount) {
                throw new Error(`Invoice exceeds available monthly budget for ${invoiceMonth.monthYear}. Available: ${remainingMonthlyBudget}, Requested: ${invoiceAmount}`);
            }

            log.debug('validateMonthlyFluidBudget', `Monthly fluid budget validation passed for ${invoiceMonth.monthYear}`);

        } catch (error) {
            log.error('validateMonthlyFluidBudget', `Monthly fluid budget validation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate monthly fixed budget for a specific line
     * @param {Object} ioLine - IO line item data
     * @param {number} lineAmount - Invoice line amount (aggregated for same Salesforce Line ID)
     * @param {Date} invoiceStartDate - Invoice start date
     * @param {Date} invoiceEndDate - Invoice end date
     * @param {Object} context - Script context
     * @param {Object} ioRecord - IO record data
     */
    function validateMonthlyFixedBudget(ioLine, lineAmount, invoiceStartDate, invoiceEndDate, context, ioRecord) {
        try {
            if (!invoiceStartDate || !invoiceEndDate) {
                throw new Error('Invoice start and end dates are required for monthly fixed budget validation.');
            }

            // Check if invoice spans multiple months - not allowed for monthly fixed budget
            if (isMultiMonth(invoiceStartDate, invoiceEndDate)) {
                throw new Error('Monthly fixed budget invoices cannot span multiple months.');
            }

            // Get the invoice month
            const invoiceMonth = getInvoiceMonth(invoiceStartDate, invoiceEndDate);
            if (!invoiceMonth) {
                throw new Error('Unable to determine invoice month for budget validation.');
            }

            log.debug('validateMonthlyFixedBudget', `Validating monthly fixed budget for Salesforce Line ID ${ioLine.salesforceLineId} in month ${invoiceMonth.monthYear}`);

            // Validate that the IO line's revenue recognition period overlaps with the invoice month
            if (!validateMonthOverlap(invoiceMonth.year, invoiceMonth.month, ioLine.revRecStartDate, ioLine.revRecEndDate)) {
                throw new Error(`Invoice month ${invoiceMonth.monthYear} does not overlap with IO line revenue recognition period (${ioLine.revRecStartDate} to ${ioLine.revRecEndDate}).`);
            }

            // Calculate invoiced amount for this specific Salesforce Line ID in this month
            const lineInvoicedAmount = getInvoicedAmountForLineAndMonth(ioRecord, ioLine.salesforceLineId, invoiceMonth.year, invoiceMonth.month, context);

            // Calculate credited amount for this specific line in this month
            const lineCreditedAmount = getCreditedAmountForLineAndMonth(ioRecord, ioLine.salesforceLineId, invoiceMonth.year, invoiceMonth.month);

            // Remaining Budget = Line Budget – (Invoiced – Credited)
            const remainingLineBudget = ioLine.amount - (lineInvoicedAmount - lineCreditedAmount);

            log.debug('validateMonthlyFixedBudget', `Line Budget: ${ioLine.amount}, Line Invoiced: ${lineInvoicedAmount}, Line Credited: ${lineCreditedAmount}, Remaining: ${remainingLineBudget}, Invoice Line Amount: ${lineAmount}`);

            if (remainingLineBudget < lineAmount) {
                throw new Error(`Invoice exceeds monthly fixed budget for Salesforce Line ID ${ioLine.salesforceLineId} in month ${invoiceMonth.monthYear}. Available: ${remainingLineBudget}, Requested: ${lineAmount}`);
            }

            log.debug('validateMonthlyFixedBudget', `Monthly fixed budget validation passed for Salesforce Line ID ${ioLine.salesforceLineId} in month ${invoiceMonth.monthYear}`);

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
     * Validate that a month overlaps with IO line revenue recognition period
     * @param {number} year - Year (e.g., 2025)
     * @param {number} month - Month (1-12)
     * @param {Date} lineStartDate - IO line start date
     * @param {Date} lineEndDate - IO line end date
     * @returns {boolean} True if month overlaps with line period
     */
    function validateMonthOverlap(year, month, lineStartDate, lineEndDate) {
        if (!lineStartDate || !lineEndDate) {
            return false;
        }

        // Create month boundaries
        const monthStart = new Date(year, month - 1, 1); // First day of month
        const monthEnd = new Date(year, month, 0); // Last day of month

        const lineStart = new Date(lineStartDate);
        const lineEnd = new Date(lineEndDate);

        // Month overlaps with line if: (line_start <= month_end) AND (line_end >= month_start)
        return lineStart <= monthEnd && lineEnd >= monthStart;
    }

    /**
     * Get invoiced amount for specific Salesforce Line ID in specific month
     * @param {Object} ioRecord - IO record data
     * @param {string} salesforceLineId - Salesforce Line ID
     * @param {number} year - Year (e.g., 2025)
     * @param {number} month - Month (1-12)
     * @param {Object} context - Script context
     * @returns {number} Total invoiced amount for the line in the month
     */
    function getInvoicedAmountForLineAndMonth(ioRecord, salesforceLineId, year, month, context) {
        try {
            const ioId = ioRecord.id;

            if (!ioId || !salesforceLineId) {
                return 0;
            }

            // Get current invoice ID if editing
            const currentInvoiceId = context.type === context.UserEventType.EDIT ?
                context.newRecord.id : null;

            // Create month boundaries
            const monthStart = new Date(year, month - 1, 1);
            const monthEnd = new Date(year, month, 0);

            // Format dates for NetSuite search
            const formattedMonthStart = format.format({
                value: monthStart,
                type: format.Type.DATE
            });

            const formattedMonthEnd = format.format({
                value: monthEnd,
                type: format.Type.DATE
            });

            // Build search filters for line-level search
            const searchFilters = [
                ["type", "anyof", "CustInvc"],
                "AND",
                ["mainline", "is", "F"], // Line level
                "AND",
                ["status", "noneof", "CustInvc:V", "CustInvc:E"],
                "AND",
                ["custbody_zeta_io_insertionorder", "anyof", ioId],
                "AND",
                ["custcol_zeta_sfdc_opplineid", "is", salesforceLineId],
                "AND",
                // Invoice overlaps with month if: (invoice_start <= month_end) AND (invoice_end >= month_start)
                ["startdate", "onorbefore", formattedMonthEnd],
                "AND",
                ["enddate", "onorafter", formattedMonthStart]
            ];

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
            let lineCount = 0;

            invoiceSearch.run().each(function (result) {
                const lineAmount = parseFloat(result.getValue('amount') || 0);
                totalInvoiced += lineAmount;
                lineCount++;

                log.debug('getInvoicedAmountForLineAndMonth', `Found invoice line ${result.getValue('tranid')} (ID: ${result.getValue('internalid')}) with amount: ${lineAmount}`);
                return true;
            });

            log.debug('getInvoicedAmountForLineAndMonth', `Total invoiced amount for Salesforce Line ID ${salesforceLineId} in ${year}-${String(month).padStart(2, '0')}: ${totalInvoiced} from ${lineCount} lines`);
            return totalInvoiced;

        } catch (error) {
            log.error('getInvoicedAmountForLineAndMonth', `Error calculating invoiced amount for line and month: ${error.message}`);
            return 0;
        }
    }

    /**
     * Get credited amount for specific Salesforce Line ID in specific month
     * @param {Object} ioRecord - IO record data
     * @param {string} salesforceLineId - Salesforce Line ID
     * @param {number} year - Year (e.g., 2025)
     * @param {number} month - Month (1-12)
     * @returns {number} Total credited amount for the line in the month
     */
    function getCreditedAmountForLineAndMonth(ioRecord, salesforceLineId, year, month) {
        try {
            const ioId = ioRecord.id;

            if (!ioId || !salesforceLineId) {
                log.debug('getCreditedAmountForLineAndMonth', 'No IO ID or Salesforce Line ID provided, returning 0');
                return 0;
            }

            // Create month boundaries
            const monthStart = new Date(year, month - 1, 1);
            const monthEnd = new Date(year, month, 0);

            // Format dates for NetSuite search
            const formattedMonthStart = format.format({
                value: monthStart,
                type: format.Type.DATE
            });

            const formattedMonthEnd = format.format({
                value: monthEnd,
                type: format.Type.DATE
            });

            log.debug('getCreditedAmountForLineAndMonth', `Searching credit memo lines for IO ID: ${ioId}, Salesforce Line ID: ${salesforceLineId} in month ${year}-${String(month).padStart(2, '0')}`);

            // Search for credit memo lines with matching IO and Salesforce Line ID that overlap with the month
            const creditMemoSearch = search.create({
                type: search.Type.CREDIT_MEMO,
                filters: [
                    ["type", "anyof", "CustCred"],
                    "AND",
                    ["mainline", "is", "F"], // Line level
                    "AND",
                    ["status", "noneof", "CustCred:V"], // Exclude voided credit memos
                    "AND",
                    ["custbody_zeta_io_insertionorder", "anyof", ioId],
                    "AND",
                    ["custcol_zeta_sfdc_opplineid", "is", salesforceLineId],
                    "AND",
                    // Credit memo overlaps with month if: (credit_start <= month_end) AND (credit_end >= month_start)
                    ["startdate", "onorbefore", formattedMonthEnd],
                    "AND",
                    ["enddate", "onorafter", formattedMonthStart]
                ],
                columns: [
                    'internalid',
                    'tranid',
                    'amount'
                ]
            });

            let totalCredited = 0;
            let creditLineCount = 0;

            creditMemoSearch.run().each(function (result) {
                const creditAmount = parseFloat(result.getValue('amount') || 0);
                totalCredited += Math.abs(creditAmount); // Credit memo lines are negative, so take absolute value
                creditLineCount++;

                log.debug('getCreditedAmountForLineAndMonth', `Found credit memo line ${result.getValue('tranid')} (ID: ${result.getValue('internalid')}) with amount: ${Math.abs(creditAmount)}`);
                return true;
            });

            log.debug('getCreditedAmountForLineAndMonth', `Total credited amount for Salesforce Line ID ${salesforceLineId} in ${year}-${String(month).padStart(2, '0')}: ${totalCredited} from ${creditLineCount} credit memo lines`);
            return totalCredited;

        } catch (error) {
            log.error('getCreditedAmountForLineAndMonth', `Error calculating credited amount for line and month: ${error.message}`);
            return 0;
        }
    }

    /**
     * Get credited amount for a specific month
     * @param {Object} ioRecord - IO record data
     * @param {number} year - Year (e.g., 2025)
     * @param {number} month - Month (1-12)
     * @returns {number} Total credited amount for the month
     */
    function getCreditedAmountForMonth(ioRecord, year, month) {
        try {
            const ioId = ioRecord.id;

            if (!ioId) {
                log.debug('getCreditedAmountForMonth', 'No IO ID found, returning 0');
                return 0;
            }

            // Create month boundaries
            const monthStart = new Date(year, month - 1, 1);
            const monthEnd = new Date(year, month, 0);

            // Format dates for NetSuite search
            const formattedMonthStart = format.format({
                value: monthStart,
                type: format.Type.DATE
            });

            const formattedMonthEnd = format.format({
                value: monthEnd,
                type: format.Type.DATE
            });

            log.debug('getCreditedAmountForMonth', `Searching credit memos for IO ID: ${ioId} in month ${year}-${String(month).padStart(2, '0')}`);

            // Search for credit memos linked to the IO using the IO reference field that overlap with the month
            const creditMemoSearch = search.create({
                type: search.Type.CREDIT_MEMO,
                filters: [
                    ["type", "anyof", "CustCred"],
                    "AND",
                    ["mainline", "is", "T"],
                    "AND",
                    ["status", "noneof", "CustCred:V"], // Exclude voided credit memos
                    "AND",
                    ["custbody_zeta_io_insertionorder", "anyof", ioId],
                    "AND",
                    // Credit memo overlaps with month if: (credit_start <= month_end) AND (credit_end >= month_start)
                    ["startdate", "onorbefore", formattedMonthEnd],
                    "AND",
                    ["enddate", "onorafter", formattedMonthStart]
                ],
                columns: [
                    'internalid',
                    'tranid',
                    search.createColumn({
                        name: 'formulacurrency',
                        formula: '{fxamount} - NVL({taxtotal},0)',
                        label: 'Amount Without Tax'
                    })
                ]
            });

            let totalCredited = 0;
            let creditMemoCount = 0;

            creditMemoSearch.run().each(function (result) {
                const creditAmount = parseFloat(result.getValue({ name: 'formulacurrency', formula: '{fxamount} - NVL({taxtotal},0)' }) || 0);
                totalCredited += Math.abs(creditAmount); // Credit memos are negative, so take absolute value
                creditMemoCount++;

                log.debug('getCreditedAmountForMonth', `Found credit memo ${result.getValue('tranid')} (ID: ${result.getValue('internalid')}) with amount: ${Math.abs(creditAmount)}`);
                return true;
            });

            log.debug('getCreditedAmountForMonth', `Total credited amount for IO ${ioId} in ${year}-${String(month).padStart(2, '0')}: ${totalCredited} from ${creditMemoCount} credit memos`);
            return totalCredited;

        } catch (error) {
            log.error('getCreditedAmountForMonth', `Error calculating credited amount for month: ${error.message}`);
            return 0;
        }
    }

    /**
     * Get credited amount for an IO
     * @param {Object} ioRecord - IO record data
     * @returns {number} Total credited amount
     */
    function getCreditedAmount(ioRecord) {
        try {
            const ioId = ioRecord.id;

            if (!ioId) {
                log.debug('getCreditedAmount', 'No IO ID found, returning 0');
                return 0;
            }

            log.debug('getCreditedAmount', `Searching credit memos for IO ID: ${ioId}`);

            // Search for credit memos linked to the IO using the IO reference field
            const creditMemoSearch = search.create({
                type: search.Type.CREDIT_MEMO,
                filters: [
                    ["type", "anyof", "CustCred"],
                    "AND",
                    ["mainline", "is", "T"],
                    "AND",
                    ["status", "noneof", "CustCred:V"], // Exclude voided credit memos
                    "AND",
                    ["custbody_zeta_io_insertionorder", "anyof", ioId]
                ],
                columns: [
                    'internalid',
                    'tranid',
                    search.createColumn({
                        name: 'formulacurrency',
                        formula: '{fxamount} - NVL({taxtotal},0)',
                        label: 'Amount Without Tax'
                    })
                ]
            });

            let totalCredited = 0;
            let creditMemoCount = 0;

            creditMemoSearch.run().each(function (result) {
                const creditAmount = parseFloat(result.getValue({ name: 'formulacurrency', formula: '{fxamount} - NVL({taxtotal},0)' }) || 0);
                totalCredited += Math.abs(creditAmount); // Credit memos are negative, so take absolute value
                creditMemoCount++;

                log.debug('getCreditedAmount', `Found credit memo ${result.getValue('tranid')} (ID: ${result.getValue('internalid')}) with amount: ${Math.abs(creditAmount)}`);
                return true;
            });

            log.debug('getCreditedAmount', `Total credited amount for IO ${ioId}: ${totalCredited} from ${creditMemoCount} credit memos`);
            return totalCredited;

        } catch (error) {
            log.error('getCreditedAmount', `Error calculating credited amount for IO ${ioRecord ? ioRecord.id : 'unknown'}: ${error.message}`);
            return 0;
        }
    }

    /**
     * Function to handle credit and rebill linkage after invoice creation/edit
     * @param {Object} context - Script context
     */
    function afterSubmit(context) {
        try {
            log.debug('afterSubmit', 'Starting credit and rebill linkage process');

            // Only process on create and edit operations
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

            var cust = newRecord.getValue({ fieldId: 'entity' });
            log.debug('afterSubmit', 'Customer ID: ' + cust);

            var custRec = record.load({
                type: record.Type.CUSTOMER,
                id: cust
            }); 

            var isIoMandatory = custRec.getValue({ fieldId: 'custentity_zeta_io_is_iomandatory' });
            log.debug('afterSubmit', 'Is IO Mandatory for Customer: ' + isIoMandatory);
            if (!isIoMandatory) {
                log.debug('afterSubmit', 'IO Mandatory not set for customer. Skipping credit and rebill linkage process.');
                return;
            }

            // Skip validation if sub-Bu is not in the specified list
            // even if one line item sub-Bu does not match, skips validation
            var itemLineCount = newRecord.getLineCount({ sublistId: 'item' });
            var allLinesValid = true;
            var invalidLine = null;
            for (var i = 0; i < itemLineCount; i++) {
                var subBu = newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'class',
                    line: i
                });
                log.debug('AfterSubmit', subBuList);
                if (!subBuList.includes(subBu)) {
                    allLinesValid = false;
                    invalidLine = i + 1;
                    break;
                }
            }

            if (!allLinesValid) {
                log.debug('beforeSubmit', 'Line ' + invalidLine + ' sub-Bu is not in the specified list. Skipping IO validations.');
                return;
            }

            // Check if this is a credit and rebill invoice (invoice type = 2)
            const invoiceType = newRecord.getValue(INVOICE_FIELDS.INVOICE_TYPE);

            if (!invoiceType || invoiceType !== '2') {
                log.debug('afterSubmit', `Invoice type is ${invoiceType}, not a credit and rebill. Skipping linkage process.`);
                return;
            }

            // Get the original credit memo number
            const originalCreditMemoNo = newRecord.getValue(INVOICE_FIELDS.ORIGINAL_CREDIT_MEMO_NO);

            if (!originalCreditMemoNo) {
                log.error('afterSubmit', 'Credit and rebill invoice missing original credit memo number. Cannot establish linkage.');
                return;
            }

            // Get the current invoice document number
            const currentInvoiceNumber = newRecord.getValue('tranid');

            if (!currentInvoiceNumber) {
                log.error('afterSubmit', 'Unable to get current invoice document number for linkage.');
                return;
            }

            log.debug('afterSubmit', `Processing credit and rebill linkage: Original CM: ${originalCreditMemoNo}, New Invoice: ${currentInvoiceNumber}`);

            // Find and update the credit memo
            updateCreditMemoWithNewInvoice(originalCreditMemoNo, currentInvoiceNumber);

            log.debug('afterSubmit', `Successfully completed credit and rebill linkage for invoice ${currentInvoiceNumber}`);

        } catch (error) {
            log.error('afterSubmit', `Credit and rebill linkage failed: ${error.message}`);
            // Don't throw error to avoid blocking invoice creation - just log the issue
        }
    }

    /**
     * Search for credit memo by document number and update with new invoice number
     * @param {string} creditMemoDocNumber - Credit memo document number
     * @param {string} newInvoiceNumber - New invoice document number
     */
    function updateCreditMemoWithNewInvoice(creditMemoDocNumbers, newInvoiceNumber) {
        try {

            // Split by semicolon and trim spaces
            const docNumbers = creditMemoDocNumbers.split(';').map(s => s.trim()).filter(Boolean);

            docNumbers.forEach(function (creditMemoDocNumber) {
                log.debug('updateCreditMemoWithNewInvoice', `Searching for credit memo with document number: ${creditMemoDocNumber}`);

                // Search for credit memo by document number
                const creditMemoSearch = search.create({
                    type: search.Type.CREDIT_MEMO,
                    filters: [
                        ['tranid', 'is', creditMemoDocNumber],
                        'AND',
                        ['mainline', 'is', 'T']
                    ],
                    columns: [
                        'internalid',
                        'tranid'
                    ]
                });

                let creditMemoId = null;
                let foundCount = 0;

                creditMemoSearch.run().each(function (result) {
                    creditMemoId = result.getValue('internalid');
                    foundCount++;
                    log.debug('updateCreditMemoWithNewInvoice', `Found credit memo: ID ${creditMemoId}, Document Number: ${result.getValue('tranid')}`);
                    return true; // Continue to count all matches
                });

                if (foundCount === 0) {
                    throw new Error(`No credit memo found with document number: ${creditMemoDocNumber}`);
                }

                if (foundCount > 1) {
                    log.audit('updateCreditMemoWithNewInvoice', `Warning: Multiple credit memos found with document number ${creditMemoDocNumber}. Using the first one (ID: ${creditMemoId}).`);
                }

                if (!creditMemoId) {
                    throw new Error(`Unable to retrieve credit memo ID for document number: ${creditMemoDocNumber}`);
                }

                // Load and update the credit memo record
                log.debug('updateCreditMemoWithNewInvoice', `Loading credit memo record with ID: ${creditMemoId}`);

                const creditMemoRecord = record.load({
                    type: record.Type.CREDIT_MEMO,
                    id: creditMemoId
                });

                // Get existing invoice numbers (if any)
                let existingValue = creditMemoRecord.getValue({
                    fieldId: INVOICE_FIELDS.NEW_INVOICE_NUMBER
                }) || '';

                // Split, trim, and check if already present
                let invoiceNumbers = existingValue
                    ? existingValue.split(';').map(s => s.trim()).filter(Boolean)
                    : [];

                if (!invoiceNumbers.includes(newInvoiceNumber)) {
                    invoiceNumbers.push(newInvoiceNumber);
                }

                // Join back with semicolon
                const updatedValue = invoiceNumbers.join(';');

                // Set the new invoice number field
                creditMemoRecord.setValue({
                    fieldId: INVOICE_FIELDS.NEW_INVOICE_NUMBER,
                    value: updatedValue
                });
                
                // Save the credit memo record
                const savedId = creditMemoRecord.save();

                log.audit('updateCreditMemoWithNewInvoice', `Successfully updated credit memo ${creditMemoDocNumber} (ID: ${savedId}) with new invoice number: ${newInvoiceNumber}`);
            })


        } catch (error) {
            log.error('updateCreditMemoWithNewInvoice', `Error updating credit memo: ${error.message}`);
            throw error;
        }
    }

    return {
        beforeLoad: beforeLoad,
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});
