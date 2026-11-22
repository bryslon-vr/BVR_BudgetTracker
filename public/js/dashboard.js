// Draws the two dashboard charts. The numbers come from the page itself:
// blocks of JSON with the ids "chart-data" (spending by category) and "trend-data" (income vs expenses).
(function () {
  function readJson(id) {
    var el = document.getElementById(id);
    return el ? JSON.parse(el.textContent) : null;
  }
  function rand(n) {
    return 'R ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var colours = ['#FFFFFF', '#1F2544', '#DCE4FF', '#3F5FD9', '#B8C6FF', '#0F1115'];

  // Colour the dots in the spending list so they match the slices
  document.querySelectorAll('[data-swatch]').forEach(function (el) {
    el.style.backgroundColor = colours[Number(el.getAttribute('data-swatch')) % colours.length];
  });

  if (typeof Chart === 'undefined') return; // the text versions of the numbers are still on the page

  // spending by category (doughnut) 
  var spendingCanvas = document.getElementById('spendingChart');
  var spending = readJson('chart-data');
  if (spendingCanvas && spending && spending.values.length) {
    new Chart(spendingCanvas, {
      type: 'doughnut',
      data: {
        labels: spending.labels,
        datasets: [{
          data: spending.values,
          backgroundColor: spending.values.map(function (_, i) { return colours[i % colours.length]; }),
          borderWidth: 2,
          borderColor: 'rgba(255,255,255,.35)',
        }],
      },
      options: {
        cutout: '64%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { return ' ' + ctx.label + ': ' + rand(ctx.parsed); } } },
        },
      },
    });
  }

  // income vs expenses over six months (bars) 
  var trendCanvas = document.getElementById('trendChart');
  var trend = readJson('trend-data');
  if (trendCanvas && trend && trend.labels.length) {
    var last = trend.labels.length - 1;
    // The current month is drawn at full strength, earlier months a little lighter
    var shade = function (colour) {
      return trend.labels.map(function (_, i) { return i === last ? colour : colour + '99'; });
    };
    new Chart(trendCanvas, {
      type: 'bar',
      data: {
        labels: trend.labels,
        datasets: [
          { label: 'Income', data: trend.income, backgroundColor: shade('#5B7CFA'), borderRadius: 8, borderSkipped: false },
          { label: 'Expenses', data: trend.expense, backgroundColor: shade('#1F2544'), borderRadius: 8, borderSkipped: false },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { color: '#4B5278' } },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,.7)' },
            ticks: { color: '#4B5278', callback: function (v) { return v >= 1000 ? 'R ' + v / 1000 + 'k' : 'R ' + v; } },
          },
        },
        plugins: {
          legend: { position: 'top', labels: { color: '#1B1F3B', usePointStyle: true, boxWidth: 8 } },
          tooltip: { callbacks: { label: function (ctx) { return ' ' + ctx.dataset.label + ': ' + rand(ctx.parsed.y); } } },
        },
      },
    });
  }
})();