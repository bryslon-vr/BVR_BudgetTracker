// Draws the spending doughnut on the dashboard.
// The numbers come from the page itself: a block of JSON with the id "chart-data".
(function () {
  var canvas = document.getElementById('spendingChart');
  var dataEl = document.getElementById('chart-data');
  if (!canvas || !dataEl) return;

  var data = JSON.parse(dataEl.textContent);
  var colours = ['#FFFFFF', '#1F2544', '#DCE4FF', '#3F5FD9', '#B8C6FF', '#0F1115'];

  // Colour the dots in the text list so they match the slices
  document.querySelectorAll('[data-swatch]').forEach(function (el) {
    el.style.backgroundColor = colours[Number(el.getAttribute('data-swatch')) % colours.length];
  });

  if (typeof Chart === 'undefined' || !data.values.length) return;

  new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: data.labels,
      datasets: [{
        data: data.values,
        backgroundColor: data.values.map(function (_, i) { return colours[i % colours.length]; }),
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,.35)',
      }],
    },
    options: {
      cutout: '64%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ' ' + ctx.label + ': R ' + ctx.parsed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            },
          },
        },
      },
    },
  });
})();