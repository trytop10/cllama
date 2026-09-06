import { browser } from './browser.mjs';

/**
 * Custom confirmation dialog using Bootstrap Modal
 * @param {string} message - Message to display
 * @param {object} [options] - Configuration options
 * @param {string} [options.okText] - Confirm button text (defaults to i18n "confirm")
 * @param {string} [options.cancelText] - Cancel button text (defaults to i18n "cancel")
 * @param {string} [options.title='Confirmation'] - Dialog title
 * @returns {Promise<boolean>} User's choice (true for confirm, false for cancel)
 */
export function confirm(message, options = {}) {
  
  return new Promise((resolve) => {
    const config = {
      okText: options.okText || browser.i18n.getMessage("confirm"),
      cancelText: options.cancelText || browser.i18n.getMessage("cancel"),
      title: options.title || 'Confirmation'
    };

    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${config.title}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <p>${message}</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${config.cancelText}</button>
            <button type="button" class="btn btn-primary">${config.okText}</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const bsModal = new bootstrap.Modal(modal);
    const confirmBtn = modal.querySelector('.btn-primary');
    const cancelBtn = modal.querySelector('.btn-secondary');

    const cleanup = () => {
      bsModal.hide();
      modal.removeEventListener('hidden.bs.modal', handleCancel);
      modal.remove();
    };

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    modal.addEventListener('hidden.bs.modal', handleCancel);

    bsModal.show();

    modal.addEventListener('shown.bs.modal', () => {
      confirmBtn.focus();
    });
  });
}

/**
 * Custom alert dialog using Bootstrap Modal
 * @param {string} message - Message to display
 * @param {object} [options] - Configuration options
 * @param {string} [options.okText='Close'] - Close button text
 * @param {string} [options.title='Information'] - Dialog title
 * @returns {Promise<boolean>} Always resolves to false when closed
 */
export function balert(message, options = {}) {
  return new Promise((resolve) => {
    const config = {
      okText: options.okText || "Close",
      title: options.title || 'Information'
    };

    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${config.title}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <p>${message}</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-primary">${config.okText}</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const bsModal = new bootstrap.Modal(modal);
    const confirmBtn = modal.querySelector('.btn-primary');

    const cleanup = () => {
      bsModal.hide();
      modal.removeEventListener('hidden.bs.modal', handleConfirm);
      modal.remove();
    };

    const handleConfirm = () => {
      cleanup();
      resolve(false);
    };

    confirmBtn.addEventListener('click', handleConfirm);
    modal.addEventListener('hidden.bs.modal', handleConfirm);

    bsModal.show();

    modal.addEventListener('shown.bs.modal', () => {
      confirmBtn.focus();
    });
  });
}