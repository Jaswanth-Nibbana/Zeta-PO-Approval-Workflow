/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @description Suitelet for bulk Insertion Order approval operations - 3 separate pages
 */

define(['N/ui/serverWidget', 'N/search', 'N/task', 'N/runtime', 'N/redirect', 'N/url', 'N/record', './zeta_lib_io_utils'],
    function (serverWidget, search, task, runtime, redirect, url, record, ioUtils) {

        /**
         * On Request function
         * @param {Object} context
         */
        function onRequest(context) {
            try {
                const request = context.request;
                const response = context.response;

                const scriptAction = (runtime.getCurrentScript().getParameter({
                    name: 'custscript_io_bulkapprovalaction'
                }) || '').toLowerCase();


                const action = (request.parameters.action || scriptAction || 'submit');


                if (request.method === 'GET') {
                    showBulkPage(response, request, action);
                } else if (request.method === 'POST') {
                    processBulkAction(request, response, action);
                }

            } catch (error) {
                log.error('onRequest', 'Error in Suitelet: ' + error.message);
                showErrorPage(context.response, error.message);
            }
        }

        /**
         * Show appropriate bulk page based on action
         * @param {Object} response - HTTP response
         * @param {Object} request - HTTP request
         * @param {string} action - Page action (submit/review/approve)
         */
        function showBulkPage(response, request, action) {
            try {
                const currentUserRole = ioUtils.getCurrentUserRole();
                const creatorFilter = request.parameters.creator || '';

                // Validate user access to the requested page
                if (!hasAccessToPage(action, currentUserRole)) {
                    throw new Error('You do not have access to this page.');
                }

                let form;

                switch (action) {
                    case 'submit':
                        form = createBulkSubmissionPage(creatorFilter);
                        break;
                    case 'review':
                        form = createBulkReviewPage(creatorFilter);
                        break;
                    case 'approve':
                        form = createBulkApprovalPage(creatorFilter);
                        break;
                    default:
                        throw new Error('Invalid action specified.');
                }

                response.writePage(form);

            } catch (error) {
                log.error('showBulkPage', 'Error creating page: ' + error.message);
                showErrorPage(response, error.message);
            }
        }

        /**
         * Check if user has access to the specified page
         * @param {string} action - Page action
         * @param {number} userRole - User role
         * @returns {boolean} True if user has access
         */
        function hasAccessToPage(action, userRole) {
            switch (action) {
                case 'submit':
                case 'review':
                    return userRole === ioUtils.ROLES.AR_ANALYST || userRole === ioUtils.ROLES.ADMINISTRATOR;
                case 'approve':
                    return userRole === ioUtils.ROLES.AR_MANAGER || userRole === ioUtils.ROLES.ADMINISTRATOR;
                default:
                    return false;
            }
        }

        /**
         * Create bulk submission page
         * @param {string} creatorFilter - Selected creator filter
         * @returns {Object} Form object
         */
        function createBulkSubmissionPage(creatorFilter) {
            const form = serverWidget.createForm({
                title: 'Bulk Submit Insertion Orders for Review'
            });

            // Add hidden action field
            form.addField({
                id: 'custpage_action',
                type: serverWidget.FieldType.TEXT,
                label: 'Action'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.HIDDEN
            }).defaultValue = 'submit';

            // Add creator filter
            addCreatorFilter(form, creatorFilter);

            // Add sublist
            const sublist = createIOSublist(form, 'Draft Insertion Orders Ready for Submission');
            populateSubmissionSublist(sublist, creatorFilter);

            // Add buttons
            form.addSubmitButton({ label: 'Submit Selected for Review' });
            form.addButton({
                id: 'custpage_refresh',
                label: 'Refresh',
                functionName: 'refreshPage'
            });

            // Add client script
            form.clientScriptModulePath = './zeta_cl_io_bulkapproval.js';

            return form;
        }

        /**
         * Create bulk review page
         * @param {string} creatorFilter - Selected creator filter
         * @returns {Object} Form object
         */
        function createBulkReviewPage(creatorFilter) {
            const form = serverWidget.createForm({
                title: 'Bulk Review Insertion Orders'
            });

            // Add hidden action field
            form.addField({
                id: 'custpage_action',
                type: serverWidget.FieldType.TEXT,
                label: 'Action'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.HIDDEN
            }).defaultValue = 'review';

            // Add creator filter
            addCreatorFilter(form, creatorFilter);

            // Add sublist
            const sublist = createIOSublist(form, 'Insertion Orders Submitted for Review');
            populateReviewSublist(sublist, creatorFilter);

            // Add buttons
            form.addSubmitButton({ label: 'Mark Selected as Reviewed' });
            form.addButton({
                id: 'custpage_refresh',
                label: 'Refresh',
                functionName: 'refreshPage'
            });

            // Add client script
            form.clientScriptModulePath = './zeta_cl_io_bulkapproval.js';

            return form;
        }

        /**
         * Create bulk approval page
         * @param {string} creatorFilter - Selected creator filter
         * @returns {Object} Form object
         */
        function createBulkApprovalPage(creatorFilter) {
            const form = serverWidget.createForm({
                title: 'Bulk Approve Insertion Orders'
            });

            // Add hidden action field
            form.addField({
                id: 'custpage_action',
                type: serverWidget.FieldType.TEXT,
                label: 'Action'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.HIDDEN
            }).defaultValue = 'approve';

            // Add creator filter
            addCreatorFilter(form, creatorFilter);

            // Add sublist
            const sublist = createIOSublist(form, 'Insertion Orders Ready for Approval');
            populateApprovalSublist(sublist, creatorFilter);

            // Add buttons
            form.addSubmitButton({ label: 'Approve Selected' });
            form.addButton({
                id: 'custpage_refresh',
                label: 'Refresh',
                functionName: 'refreshPage'
            });

            // Add client script
            form.clientScriptModulePath = './zeta_cl_io_bulkapproval.js';

            return form;
        }

        /**
         * Add creator filter to form
         * @param {Object} form - Form object
         * @param {string} selectedCreator - Currently selected creator
         */
        function addCreatorFilter(form, selectedCreator) {
            const creatorField = form.addField({
                id: 'custpage_creator_filter',
                type: serverWidget.FieldType.SELECT,
                label: 'Filter by Creator'
            });

            // Add "All" option
            creatorField.addSelectOption({
                value: '',
                text: '-- All Creators --'
            });

            // Get list of creators (users who have created IOs)
            const creatorSearch = search.create({
                type: ioUtils.RECORD_TYPE,
                columns: [
                    search.createColumn({
                        name: 'owner',
                        summary: 'GROUP'
                    }),
                    search.createColumn({
                        name: 'entityid',
                        join: 'owner',
                        summary: 'GROUP'
                    })
                ]
            });

            creatorSearch.run().each(function (result) {
                const creatorId = result.getValue({
                    name: 'owner',
                    summary: 'GROUP'
                });
                const creatorName = result.getValue({
                    name: 'entityid',
                    join: 'owner',
                    summary: 'GROUP'
                });

                if (creatorId && creatorName) {
                    creatorField.addSelectOption({
                        value: creatorId,
                        text: creatorName,
                        isSelected: creatorId === selectedCreator
                    });
                }
                return true;
            });

            creatorField.defaultValue = selectedCreator;
        }

        /**
         * Create standard IO sublist
         * @param {Object} form - Form object
         * @param {string} label - Sublist label
         * @returns {Object} Sublist object
         */
        function createIOSublist(form, label) {
            const sublist = form.addSublist({
                id: 'custpage_io_list',
                type: serverWidget.SublistType.LIST,
                label: label
            });
            sublist.addMarkAllButtons();

            // Add select all checkbox in header
            sublist.addField({
                id: 'custpage_select',
                type: serverWidget.FieldType.CHECKBOX,
                label: 'Select'
            });

            sublist.addField({
                id: 'custpage_io_id',
                type: serverWidget.FieldType.TEXT,
                label: 'ID'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.INLINE
            });

            sublist.addField({
                id: 'custpage_io_name',
                type: serverWidget.FieldType.TEXT,
                label: 'Name'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.INLINE
            });

            sublist.addField({
                id: 'custpage_customer',
                type: serverWidget.FieldType.TEXT,
                label: 'Customer'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.INLINE
            });

            sublist.addField({
                id: 'custpage_amount',
                type: serverWidget.FieldType.CURRENCY,
                label: 'Total Amount'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.INLINE
            });

            sublist.addField({
                id: 'custpage_created_by',
                type: serverWidget.FieldType.TEXT,
                label: 'Created By'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.INLINE
            });

            sublist.addField({
                id: 'custpage_iodate',
                type: serverWidget.FieldType.DATE,
                label: 'Date'
            }).updateDisplayType({
                displayType: serverWidget.FieldDisplayType.INLINE
            });

            return sublist;
        }

        /**
         * Populate submission sublist (Draft IOs)
         * @param {Object} sublist - Sublist object
         * @param {string} creatorFilter - Creator filter
         */

        function populateSubmissionSublist(sublist, creatorFilter) {
            let searchFilters = [
                [ioUtils.FIELDS.APPROVAL_STATUS, 'anyof', ioUtils.APPROVAL_STATUS.DRAFT]
            ];

            // Limit to a single creator only when the user picked one
            if (creatorFilter) {
                searchFilters.push('AND');
                searchFilters.push(['owner', 'anyof', creatorFilter]);
            }

            populateSublistWithSearch(sublist, searchFilters);
        }

        /**
         * Populate review sublist (Submitted IOs)
         * @param {Object} sublist - Sublist object
         * @param {string} creatorFilter - Creator filter
         */
        function populateReviewSublist(sublist, creatorFilter) {
            const currentUserId = ioUtils.getCurrentUserId();

            let searchFilters = [
                [ioUtils.FIELDS.APPROVAL_STATUS, 'anyof', ioUtils.APPROVAL_STATUS.SUBMITTED_FOR_REVIEW],
                'AND',
                ['owner', 'noneof', currentUserId]          // never review your own IO
            ];

            // If a creator was picked, narrow to that creator as well
            if (creatorFilter) {
                searchFilters.push('AND');
                searchFilters.push(['owner', 'anyof', creatorFilter]);
            }

            populateSublistWithSearch(sublist, searchFilters);
        }

        /**
         * Populate approval sublist (Reviewed IOs)
         * @param {Object} sublist - Sublist object
         * @param {string} creatorFilter - Creator filter
         */
        function populateApprovalSublist(sublist, creatorFilter) {
            let searchFilters = [
                [ioUtils.FIELDS.APPROVAL_STATUS, 'anyof', ioUtils.APPROVAL_STATUS.REVIEWED_PENDING_APPROVAL]
            ];

            if (creatorFilter) {
                searchFilters.push('AND');
                searchFilters.push(['owner', 'anyof', creatorFilter]);
            }

            populateSublistWithSearch(sublist, searchFilters);
        }

        /**
         * Populate sublist with search results
         * @param {Object} sublist - Sublist object
         * @param {Array} searchFilters - Search filters
         */
        function populateSublistWithSearch(sublist, searchFilters) {
            try {
                const ioSearch = search.create({
                    type: ioUtils.RECORD_TYPE,
                    filters: searchFilters,
                    columns: [
                        'internalid',
                        'name',
                        'custrecord_zeta_io_customer',
                        'custrecord_zeta_io_sfopportunitytotal',
                        'owner',
                        'custrecord_zeta_io_date'
                    ]
                });

                let lineNum = 0;
                ioSearch.run().each(function (result) {
                    const ioId = result.getValue('internalid');
                    const ioName = result.getValue('name');
                    const customer = result.getText('custrecord_zeta_io_customer') || ' ';
                    const amount = result.getValue('custrecord_zeta_io_sfopportunitytotal') || 0;
                    const createdBy = result.getText('owner') || ' ';
                    const ioDate = result.getValue('custrecord_zeta_io_date') || '';

                    sublist.setSublistValue({
                        id: 'custpage_io_id',
                        line: lineNum,
                        value: ioId
                    });

                    sublist.setSublistValue({
                        id: 'custpage_io_name',
                        line: lineNum,
                        value: ioName
                    });

                    sublist.setSublistValue({
                        id: 'custpage_customer',
                        line: lineNum,
                        value: customer
                    });

                    sublist.setSublistValue({
                        id: 'custpage_amount',
                        line: lineNum,
                        value: amount.toString()
                    });

                    sublist.setSublistValue({
                        id: 'custpage_created_by',
                        line: lineNum,
                        value: createdBy
                    });

                    if (ioDate) {
                        sublist.setSublistValue({
                            id: 'custpage_iodate',
                            line: lineNum,
                            value: ioDate
                        });
                    }


                    lineNum++;
                    return true;
                });

                log.debug('populateSublistWithSearch', `Populated ${lineNum} records`);

            } catch (error) {
                log.error('populateSublistWithSearch', 'Error populating sublist: ' + error.message);
            }
        }

        /**
         * Process bulk action
         * @param {Object} request - HTTP request
         * @param {Object} response - HTTP response
         * @param {string} action - Action type
         */
        function processBulkAction(request, response, action) {
            try {
                const lineCount = request.getLineCount({ group: 'custpage_io_list' });
                const selectedIOs = [];

                // Get selected IOs
                for (let i = 0; i < lineCount; i++) {
                    const isSelected = request.getSublistValue({
                        group: 'custpage_io_list',
                        name: 'custpage_select',
                        line: i
                    });
                    if (isSelected === 'T') {
                        const ioId = request.getSublistValue({
                            group: 'custpage_io_list',
                            name: 'custpage_io_id',
                            line: i
                        });
                        selectedIOs.push(ioId);
                    }
                }

                if (selectedIOs.length === 0) {
                    throw new Error('Please select at least one Insertion Order to process.');
                }

                log.debug('processBulkAction', `Processing ${selectedIOs.length} IOs for action: ${action}`);

                // Create a record in the background processor
                const backgroundProcessor = record.create({
                    type: 'customrecord_zeta_io_backgroundprocessor',
                    isDynamic: true
                });

                backgroundProcessor.setValue({
                    fieldId: 'custrecord_zeta_io_requestor',
                    value: ioUtils.getCurrentUserId()
                });
                backgroundProcessor.setValue({
                    fieldId: 'custrecord_zeta_io_action',
                    value: action
                });
                backgroundProcessor.setValue({
                    fieldId: 'custrecord_zeta_io_data',
                    value: JSON.stringify(selectedIOs)
                });
                backgroundProcessor.setValue({
                    fieldId: 'custrecord_zeta_io_status',
                    value: 1 // Not Processed
                });

                const backgroundProcessorId = backgroundProcessor.save();

                // Create Map/Reduce task
                const mrTask = task.create({
                    taskType: task.TaskType.MAP_REDUCE,
                    scriptId: 'customscript_zeta_mr_io_iobulkapprovals',
                    deploymentId: 'customdeploy_zeta_mr_io_iobulkapprovals',
                    params: {
                        custscript_io_bprid: backgroundProcessorId
                    }
                });

                const taskId = mrTask.submit();
                log.debug('processBulkAction', `Submitted Map/Reduce task: ${taskId}`);

                // Redirect to success page
                showSuccessPage(response, action, selectedIOs.length, taskId);

            } catch (error) {
                log.error('processBulkAction', 'Error processing bulk action: ' + error.message);
                showErrorPage(response, error.message);
            }
        }

        /**
         * Show success page
         * @param {Object} response - HTTP response
         * @param {string} action - Action performed
         * @param {number} count - Number of records processed
         * @param {string} taskId - Task ID
         */
        function showSuccessPage(response, action, count, taskId) {
            const form = serverWidget.createForm({
                title: 'Bulk Processing Started'
            });

            const actionText = {
                'submit': 'submission for review',
                'review': 'review',
                'approve': 'approval'
            };

            form.addField({
                id: 'custpage_success',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Success'
            }).defaultValue = `<div style="color: green; font-weight: bold; padding: 20px; text-align: center;">
            <h3>Bulk ${actionText[action]} started successfully!</h3>
            <p>Processing ${count} Insertion Order(s)...</p>
            <p>Task ID: ${taskId}</p>
            <p>You will receive a notification when processing is complete.</p>
        </div>`;


            response.writePage(form);
        }

        /**
         * Show error page
         * @param {Object} response - HTTP response
         * @param {string} errorMessage - Error message
         */
        function showErrorPage(response, errorMessage) {
            const form = serverWidget.createForm({
                title: 'Bulk Processing Error'
            });

            form.addField({
                id: 'custpage_error',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Error'
            }).defaultValue = `<div style="color: red; font-weight: bold; padding: 20px; text-align: center;">
            <h3>Error occurred during processing</h3>
            <p>${errorMessage}</p>
        </div>`;

            form.addButton({
                id: 'custpage_back',
                label: 'Back',
                functionName: 'history.back()'
            });

            response.writePage(form);
        }

        return {
            onRequest: onRequest
        };
    });
