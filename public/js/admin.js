// Draws the transactions-per-month chart on the admin page.
// The numbers come from the page itself: a block of JSON with the id "admin-data".
(function () {
  var canvas = document.getElementById('adminChart');
  var dataEl = document.getElementById('admin-data');
  if (!canvas || !dataEl || typeof Chart === 'undefined') return; // the table of numbers is still on the page

  var data = JSON.parse(dataEl.textContent);
  var last = data.labels.length - 1;

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [{
        label: 'Transactions',
        data: data.counts,
        // The current month at full strength, earlier months a little lighter
        backgroundColor: data.labels.map(function (_, i) { return i === last ? '#5B7CFA' : '#5B7CFA99'; }),
        borderRadius: 8,
        borderSkipped: false,
      }],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: '#4B5278' } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,.7)' }, ticks: { color: '#4B5278', precision: 0 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function (ctx) { return ' ' + ctx.parsed.y + ' transactions'; } } },
      },
    },
  });
})();