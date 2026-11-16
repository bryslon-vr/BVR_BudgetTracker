// Small helpers used on several pages
(function () {
  // Date inputs marked data-default-today start on today's date (on the person's own device)
  var now = new Date();
  var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  document.querySelectorAll('[data-default-today]').forEach(function (input) {
    if (!input.value) input.value = today;
  });

  // One delete confirmation window for every list. Delete buttons carry data-label and data-action.
  var modal = document.getElementById('deleteModal');
  if (modal) {
    modal.addEventListener('show.bs.modal', function (event) {
      var button = event.relatedTarget;
      document.getElementById('deleteLabel').textContent = button.getAttribute('data-label');
      document.getElementById('deleteForm').setAttribute('action', button.getAttribute('data-action'));
    });
  }
})();