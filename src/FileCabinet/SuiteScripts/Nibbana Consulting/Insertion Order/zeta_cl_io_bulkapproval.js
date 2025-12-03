/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @description Client script for bulk Insertion Order approval pages
 */

define(['N/currentRecord', 'N/url'],
  function (currentRecord, url) {

    /**
     * Page Init function
     * @param {Object} context
     */
    function pageInit(context) {
      try {
        const currentRec = context.currentRecord;

        // Set up creator filter change handler
      //  setupCreatorFilterHandler();

        log.debug('pageInit', 'Bulk approval page initialized');

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
        const currentRec = context.currentRecord;
        const fieldId = context.fieldId;

        if (fieldId === 'custpage_creator_filter') {
          handleCreatorFilterChange(currentRec);
        }

      } catch (error) {
        console.error('Error in fieldChanged:', error);
      }
    }

    /**
     * Handle creator filter change
     * @param {Record} currentRec - Current record
     */
    function handleCreatorFilterChange(currentRec) {
      try {
        // read field values with the options-object signature
        const creatorFilter = currentRec.getValue({ fieldId: 'custpage_creator_filter' });
        const action = currentRec.getValue({ fieldId: 'custpage_action' });

        /* copy the current query-string so we keep script & deploy */
        const params = new URLSearchParams(window.location.search);

        params.set('action', action);          // always present
        if (creatorFilter) {
          params.set('creator', creatorFilter);
        } else {
          params.delete('creator');          // “All creators” chosen
        }

        /* trigger reload */
        window.location.search = params.toString();

      } catch (error) {
        console.error('Error handling creator filter change:', error);
      }
    }



    /**
     * Validate form before submission
     * @param {Object} context
     * @returns {boolean} True if validation passes
     */
    function saveRecord(context) {
      try {
        const currentRec = context.currentRecord;
        const lineCount = currentRec.getLineCount({ sublistId: 'custpage_io_list' });

        let selectedCount = 0;

        // Count selected items
        for (let i = 0; i < lineCount; i++) {
          const isSelected = currentRec.getSublistValue({
            sublistId: 'custpage_io_list',
            fieldId: 'custpage_select',
            line: i
          });

          if (isSelected) {
            selectedCount++;
          }
        }

        if (selectedCount === 0) {
          alert('Please select at least one Insertion Order to process.');
          return false;
        }

        // Show confirmation dialog
        const action = currentRec.getValue('custpage_action');
        const actionText = {
          'submit': 'submit for review',
          'review': 'mark as reviewed',
          'approve': 'approve'
        };

        const confirmMessage = `Are you sure you want to ${actionText[action]} ${selectedCount} Insertion Order(s)?`;

        if (!confirm(confirmMessage)) {
          return false;
        }

        // Show processing indicator
        showProcessingIndicator();

        return true;

      } catch (error) {
        console.error('Error in saveRecord validation:', error);
        return false;
      }
    }

    /**
     * Show processing indicator during form submission
     */
    function showProcessingIndicator() {
      try {
        // Disable submit button
        const submitButton = document.querySelector('input[type="submit"]');
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.value = 'Processing...';
        }

        // Create processing overlay
        const overlay = document.createElement('div');
        overlay.id = 'processing_overlay';
        overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 9999;
            `;

        const processingDiv = document.createElement('div');
        processingDiv.style.cssText = `
                background: white;
                padding: 30px;
                border-radius: 5px;
                text-align: center;
                font-weight: bold;
                min-width: 300px;
            `;
        processingDiv.innerHTML = `
                <div style="margin-bottom: 15px;">Processing your request...</div>
                <div style="font-size: 12px; color: #666;">Please do not close this window.</div>
            `;

        overlay.appendChild(processingDiv);
        document.body.appendChild(overlay);

      } catch (error) {
        console.error('Error showing processing indicator:', error);
      }
    }

    /**
     * Refresh page function (called by refresh button)
     */
    function refreshPage() {
      try {
        window.location.reload();
      } catch (error) {
        console.error('Error refreshing page:', error);
      }
    }

    // Make functions globally accessible for button clicks
    if (typeof window !== 'undefined') {
      window.refreshPage = refreshPage;
    }

    return {
      pageInit: pageInit,
      fieldChanged: fieldChanged,
      saveRecord: saveRecord
    };
  });
