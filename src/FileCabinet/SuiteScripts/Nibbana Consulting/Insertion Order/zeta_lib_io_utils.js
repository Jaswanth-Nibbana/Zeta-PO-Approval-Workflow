/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @description Utility library for Insertion Order approval workflow
 */

define(['N/runtime', 'N/search', 'N/record'], function(runtime, search, record) {
    
    // Constants
    const APPROVAL_STATUS = {
        DRAFT: '1',
        SUBMITTED_FOR_REVIEW: '2', 
        REVIEWED_PENDING_APPROVAL: '3',
        APPROVED: '4',
        REJECTED: '5'
    };

    const BACKGROUND_PROCESSOR_STATUS = {
        NOT_PROCESSED: '1',
        PROCESSING: '2',
        SUCCESS: '3',
        FAILURE: '4'
    };

    const BUDGET_TYPES = {
        FLUID: '1',
        MONTHLY_FLUID: '2', 
        MONTHLY_FIXED: '3'
    };

    const ROLES = {
        ADMINISTRATOR: 3,    // Administrator
        AR_ANALYST: 1034,    // Zeta | A/R Analyst
        AR_MANAGER: 1048     // Zeta | A/R Manager
    };

    const RECORD_TYPE = 'customrecord_zeta_insertionorder';

    const EMAIL_SENDER_ID = 2557; // Hardcoded employee ID for email sender

    const FIELDS = {
        APPROVAL_STATUS: 'custrecord_zeta_io_approvalstatus',
        REVIEWED_BY: 'custrecord_zeta_io_reviewedby',
        APPROVED_BY: 'custrecord_zeta_io_approvedby',
        REJECT_REASON: 'custrecord_zeta_io_rejectreason',
        OVERRIDE_ACTIVE: 'custrecord_zeta_io_isoverrideactive',
        OVERRIDE_AMOUNT: 'custrecord_zeta_io_overrideamount',
        OVERRIDE_REASON: 'custrecord_zeta_io_overridereason',
        OVERRIDE_START_DATE: 'custrecord_zeta_io_lastoverridestartdate',
        OVERRIDE_END_DATE: 'custrecord_zeta_io_lastoverrideenddate',
        OVERRIDE_USER: 'custrecord_zeta_io_lastoverrideuser',
        CLOSED: 'custrecord_zeta_io_closed',
        CLOSE_REASON: 'custrecord_zeta_io_closereason',
        SALESFORCE_OPPORTUNITY_ID: 'custrecord_zeta_io_salesforceoppid',
        IO_TOTAL: 'custrecord_zeta_io_ordertotal',
        SALESFORCE_OPPORTUNITY_TOTAL: 'custrecord_zeta_io_sfopportunitytotal',
        EDITORS: 'custrecord_zeta_io_editors',
        IS_PGMT: 'custrecord_zeta_io_ispgmt',
        CAMPAIGN_ID: 'custrecord_zeta_io_campaignid',
        CAMPAIGN_NAME: 'custrecord_zeta_io_campaignname'
    };

    const BACKGROUND_PROCESSOR_FIELDS = {
        STATUS: 'custrecord_zeta_io_status',
        FAILURE_REASON: 'custrecord_zeta_io_failurereason',
        DATA: 'custrecord_zeta_io_data',
        ACTION: 'custrecord_zeta_io_action',
        REQUESTOR: 'custrecord_zeta_io_requestor'
    };

    // Fields that trigger approval retrigger (all except PO and Memo)
    const RETRIGGER_FIELDS = [
        'custrecord_zeta_io_customer',
        'custrecord_zeta_io_date',
        'custrecord_zeta_io_currency',
        'custrecord_zeta_io_paymentterm',
        'custrecord_zeta_io_salesforceoppid',
        'custrecord_zeta_io_opportunityname',
        'custrecord_zeta_io_advertiser',
        'custrecord_zeta_io_advertiserid',
        'custrecord_zeta_io_campaignid',
        'custrecord_zeta_io_campaignname',
        'custrecord_zeta_io_campaignstartdate',
        'custrecord_zeta_io_campaignenddate',
        'custrecord_zeta_io_accagencyname',
        'custrecord_zeta_io_salesperson',
        'custrecord_zeta_io_accmanager',
        'custrecord_zeta_io_sfopportunitytotal',
        'custrecord_zeta_io_budgettype',
        'custrecord_zeta_io_ordertype',
        'custrecord_zeta_io_parentsfoppid'
    ];

    // Fields that trigger retrigger when changed on Insertion Order Items
    const RETRIGGER_FIELDS_IOItems = [
        'custrecord_zeta_ioi_item',
        'custrecord_zeta_ioi_description',
        'custrecord_zeta_ioi_quantity',
        'custrecord_zeta_ioi_rate',
        'custrecord_zeta_ioi_amount',
        'custrecord_zeta_ioi_subbu',
        'custrecord_zeta_ioi_finsection',
        'custrecord_zeta_ioi_department',
        'custrecord_zeta_ioi_location',
        'custrecord_zeta_ioi_revrecstartdate',
        'custrecord_zeta_ioi_revrecenddate',
        'custrecord_zeta_ioi_costcenter',
        'custrecord_zeta_ioi_sforderlineid',
        'custrecord_zeta_ioi_sfproductcode'
    ];

    // Sub-Bu's that require Validations
    const SUB_BU_LIST = {
        LIVEINTENT_PLATFORM_MEDIA_AD_SERVING_FEES: "1271",
        LIVEINTENT_PLATFORM_MEDIA_AUDIENCES: "1272",
        LIVEINTENT_PLATFORM_MEDIA_CUSTOMER_INTELLIGENCE: "1273",
        LIVEINTENT_PLATFORM_MEDIA_DSP_FEES: "1274",
        LIVEINTENT_PLATFORM_MEDIA_SSP_FEES: "1275",
        LIVEINTENT_PLATFORM_MEDIA_THIRD_PARTY_AUDIENCES: "1276",
        LIVEINTENT_PLATFORM_MEDIA_THIRD_PARTY_DSP_FEES: "1277",
        ZETA_EXCHANGE_PROGRAMMATIC_ADVOCACY: "1229",
        ZETA_EXCHANGE_PROGRAMMATIC_DISQUS: "204",
        ZETA_EXCHANGE_PROGRAMMATIC_EMEA_PROG: "1233",
        ZETA_EXCHANGE_PROGRAMMATIC_HOLD_CO: "1253",
        ZETA_EXCHANGE_PROGRAMMATIC_LATAM: "1231",
        ZETA_EXCHANGE_PROGRAMMATIC_MANAGED: "1236",
        ZETA_EXCHANGE_PROGRAMMATIC_SELF_SERVICE: "1216",
        ZETA_EXCHANGE_PROGRAMMATIC_UK_MANAGED_PROG: "1235",
        ZETA_EXCHANGE_PROGRAMMATIC_UK_PROG_SELF_SERVICE: "1234"
    };

    // Valid status transitions
    const VALID_TRANSITIONS = {
        [APPROVAL_STATUS.DRAFT]: {
            [APPROVAL_STATUS.SUBMITTED_FOR_REVIEW]: [ROLES.AR_ANALYST]
        },
        [APPROVAL_STATUS.SUBMITTED_FOR_REVIEW]: {
            [APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL]: [ROLES.AR_ANALYST],
            [APPROVAL_STATUS.REJECTED]: [ROLES.AR_ANALYST]
        },
        [APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL]: {
            [APPROVAL_STATUS.APPROVED]: [ROLES.AR_MANAGER],
            [APPROVAL_STATUS.REJECTED]: [ROLES.AR_MANAGER]
        },
        [APPROVAL_STATUS.REJECTED]:{
            [APPROVAL_STATUS.SUBMITTED_FOR_REVIEW]: [ROLES.AR_ANALYST]
        }
    };

    /**
     * Get current user's role
     * @returns {number} Role ID
     */
    function getCurrentUserRole() {
        const user = runtime.getCurrentUser();
        return user.role;
    }

    // Utility to get Sub-Bu values as array
    function getSubBuListArray() {
        return Object.values(SUB_BU_LIST);
    }

    /**
     * Get current user ID
     * @returns {number} User ID
     */
    function getCurrentUserId() {
        const user = runtime.getCurrentUser();
        return user.id;
    }

    /**
     * Check if status transition is valid
     * @param {string} fromStatus - Current status
     * @param {string} toStatus - Target status
     * @param {number} userRole - User's role ID
     * @returns {boolean} True if transition is valid
     */
    function isValidTransition(fromStatus, toStatus, userRole) {
        if (!VALID_TRANSITIONS[fromStatus]) {
            return false;
        }
        
        if (!VALID_TRANSITIONS[fromStatus][toStatus]) {
            return false;
        }
        
        return VALID_TRANSITIONS[fromStatus][toStatus].includes(userRole);
    }

    /**
     * Check if user can review the IO (reviewer cannot be creator)
     * @param {number} ioId - Insertion Order ID
     * @param {number} userId - User ID attempting to review
     * @returns {boolean} True if user can review
     */
    function canUserReview(ioId, userId) {
        try {
            const ioRecord = record.load({
                type: RECORD_TYPE,
                id: ioId
            });
            
            const createdBy = ioRecord.getValue('owner') || ioRecord.getValue('custrecord_created_by');

            return createdBy != userId;
        } catch (e) {
            log.error('canUserReview', 'Error checking review permission: ' + e.message);
            return false;
        }
    }

    /**
     * Check if any retrigger fields have changed
     * @param {Record} newRecord - New record
     * @param {Record} oldRecord - Old record
     * @returns {boolean} True if retrigger fields changed
     */
    function hasRetriggerFieldsChanged(newRecord, oldRecord) {
        for (let field of RETRIGGER_FIELDS) {
            const newValue = newRecord.getValue(field);
            const oldValue = oldRecord.getValue(field);
            
            // Handle different data types appropriately
            if (field.includes('date')) {
                // For dates, compare as date objects to avoid timezone formatting issues
                const oldDate = oldValue ? new Date(oldValue).getTime() : null;
                const newDate = newValue ? new Date(newValue).getTime() : null;
                if (oldDate !== newDate) {
                    log.debug('hasRetriggerFieldsChanged', `Date field ${field} changed: ${oldValue} -> ${newValue}`);
                    return true;
                }
            } else {
                // For other fields, direct comparison
                if (newValue !== oldValue) {
                    log.debug('hasRetriggerFieldsChanged', `Field ${field} changed: ${oldValue} -> ${newValue}`);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Check if meaningful fields have changed on IO Items
     * @param {Record} newRecord - New record
     * @param {Record} oldRecord - Old record
     * @returns {boolean} True if meaningful changes detected
     */
    function hasMeaningfulChangesIOItems(newRecord, oldRecord) {
        for (let field of RETRIGGER_FIELDS_IOItems) {
            const oldValue = oldRecord.getValue(field);
            const newValue = newRecord.getValue(field);
            
            // Handle different data types appropriately
            if (field.includes('date')) {
                // For dates, compare as date objects to avoid timezone formatting issues
                const oldDate = oldValue ? new Date(oldValue).getTime() : null;
                const newDate = newValue ? new Date(newValue).getTime() : null;
                if (oldDate !== newDate) {
                    log.debug('hasMeaningfulChangesIOItems', `Date field ${field} changed: ${oldValue} -> ${newValue}`);
                    return true;
                }
            } else {
                // For other fields, direct comparison
                if (oldValue !== newValue) {
                    log.debug('hasMeaningfulChangesIOItems', `Field ${field} changed: ${oldValue} -> ${newValue}`);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Clear override fields
     * @param {Record} record - Record to update
     */
    function clearOverrideFields(record) {
        record.setValue(FIELDS.OVERRIDE_ACTIVE, false);
        record.setValue(FIELDS.OVERRIDE_AMOUNT, '');
        record.setValue(FIELDS.OVERRIDE_REASON, '');
        record.setValue(FIELDS.OVERRIDE_START_DATE, '');
        record.setValue(FIELDS.OVERRIDE_END_DATE, new Date());
        record.setValue(FIELDS.OVERRIDE_USER, getCurrentUserId());
    }

    /**
     * Get status display name
     * @param {string} statusValue - Status internal value
     * @returns {string} Display name
     */
    function getStatusDisplayName(statusValue) {
        const statusMap = {
            [APPROVAL_STATUS.DRAFT]: 'Draft',
            [APPROVAL_STATUS.SUBMITTED_FOR_REVIEW]: 'Submitted for Review',
            [APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL]: 'Reviewed - Pending Approval',
            [APPROVAL_STATUS.APPROVED]: 'Approved',
            [APPROVAL_STATUS.REJECTED]: 'Rejected'
        };
        return statusMap[statusValue] || 'Unknown';
    }

    /**
     * Validate required fields for status transition
     * @param {Record} record - Record to validate
     * @param {string} newStatus - Target status
     * @returns {object} Validation result {isValid: boolean, errors: string[]}
     */
    function validateRequiredFields(record, newStatus) {
        const errors = [];
        
        // Reject reason is required when rejecting
        if (newStatus === APPROVAL_STATUS.REJECTED) {
            const rejectReason = record.getValue(FIELDS.REJECT_REASON);
            if (!rejectReason || rejectReason.trim() === '') {
                errors.push('Reject reason is mandatory when rejecting an Insertion Order. Please provide a reason for rejection.');
            } else if (rejectReason.trim().length < 5) {
                errors.push('Reject reason must be at least 5 characters long. Please provide a meaningful reason for rejection.');
            }
        }
        
        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Get IOs awaiting review for notifications
     * @returns {Array} Array of IO records awaiting review
     */
    function getIOsAwaitingReview() {
        const searchObj = search.create({
            type: RECORD_TYPE,
            filters: [
                [FIELDS.APPROVAL_STATUS, 'anyof', APPROVAL_STATUS.SUBMITTED_FOR_REVIEW]
            ],
            columns: [
                'internalid',
                'name',
                'owner',
                FIELDS.APPROVAL_STATUS,
                'datecreated'
            ]
        });
        
        const results = [];
        searchObj.run().each(function(result) {
            results.push({
                id: result.getValue('internalid'),
                name: result.getValue('name'),
                owner: result.getValue('owner'),
                status: result.getValue(FIELDS.APPROVAL_STATUS),
                dateCreated: result.getValue('datecreated')
            });
            return true;
        });
        
        return results;
    }

    /**
     * Get IOs awaiting approval for notifications
     * @returns {Array} Array of IO records awaiting approval
     */
    function getIOsAwaitingApproval() {
        const searchObj = search.create({
            type: RECORD_TYPE,
            filters: [
                [FIELDS.APPROVAL_STATUS, 'anyof', APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL]
            ],
            columns: [
                'internalid',
                'name',
                FIELDS.REVIEWED_BY,
                FIELDS.APPROVAL_STATUS,
                'lastmodified'
            ]
        });
        
        const results = [];
        searchObj.run().each(function(result) {
            results.push({
                id: result.getValue('internalid'),
                name: result.getValue('name'),
                reviewedBy: result.getValue(FIELDS.REVIEWED_BY),
                status: result.getValue(FIELDS.APPROVAL_STATUS),
                lastModified: result.getValue('lastmodified')
            });
            return true;
        });
        
        return results;
    }

    return {
        APPROVAL_STATUS: APPROVAL_STATUS,
        BACKGROUND_PROCESSOR_STATUS: BACKGROUND_PROCESSOR_STATUS,
        BACKGROUND_PROCESSOR_FIELDS: BACKGROUND_PROCESSOR_FIELDS,
        BUDGET_TYPES: BUDGET_TYPES,
        EMAIL_SENDER_ID: EMAIL_SENDER_ID,
        ROLES: ROLES,
        RECORD_TYPE: RECORD_TYPE,
        FIELDS: FIELDS,
        RETRIGGER_FIELDS: RETRIGGER_FIELDS,
        RETRIGGER_FIELDS_IOItems: RETRIGGER_FIELDS_IOItems,
        SUB_BU_LIST:SUB_BU_LIST,
        VALID_TRANSITIONS: VALID_TRANSITIONS,
        getCurrentUserRole: getCurrentUserRole,
        getCurrentUserId: getCurrentUserId,
        isValidTransition: isValidTransition,
        canUserReview: canUserReview,
        hasRetriggerFieldsChanged: hasRetriggerFieldsChanged,
        hasMeaningfulChangesIOItems: hasMeaningfulChangesIOItems,
        clearOverrideFields: clearOverrideFields,
        getStatusDisplayName: getStatusDisplayName,
        validateRequiredFields: validateRequiredFields,
        getIOsAwaitingReview: getIOsAwaitingReview,
        getIOsAwaitingApproval: getIOsAwaitingApproval,
        getSubBuListArray: getSubBuListArray
    };
});
