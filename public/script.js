// script.js — frontend posts to /api/list-release (same origin when deployed on Vercel)
const form = document.getElementById('form');
const statusEl = document.getElementById('status');
const resultsSection = document.getElementById('results');
const tbody = document.querySelector('tbody');
const countryLabel = document.getElementById('countryLabel');

function showStatus(msg, isError = false) {
  statusEl.classList.remove('hidden');
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ffb3b3' : '';
}
function hideStatus() { statusEl.classList.add('hidden'); statusEl.textContent = ''; }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideStatus();
  resultsSection.classList.add('hidden');
  tbody.innerHTML = '';

  const username = document.getElementById('username').value.trim();
  const listname = document.getElementById('listname').value.trim();
  const country = document.getElementById('country').value.trim().toUpperCase();

  if (!username || !listname || !country) { showStatus('Fill all fields', true); return; }
  countryLabel.textContent = country;
  showStatus('Fetching list and release dates — this may take some seconds...');

  try {
    const resp = await fetch('/api/list-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, listname, country })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Server error ${resp.status}: ${txt}`);
    }

    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error('Invalid server response');

    if (data.length === 0) {
      showStatus('No films found.', true);
      return;
    }

    hideStatus();
    renderTable(data);
  } catch (err) {
    console.error(err);
    showStatus('Error: ' + err.message, true);
  }
});

document.getElementById('clear').addEventListener('click', () => {
  document.getElementById('username').value = '';
  document.getElementById('listname').value = '';
  document.getElementById('country').value = '';
  tbody.innerHTML = '';
  resultsSection.classList.add('hidden');
  hideStatus();
});

function renderTable(rows) {
  resultsSection.classList.remove('hidden');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');

    const tdIndex = document.createElement('td');
    tdIndex.textContent = (i + 1).toString();
    tr.appendChild(tdIndex);

    const tdName = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://letterboxd.com/film/${r.film_query}/`;
    a.textContent = r.film_name || r.film_query;
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'film-link';
    tdName.appendChild(a);
    tr.appendChild(tdName);

    const tdCountry = document.createElement('td');
    tdCountry.textContent = r.country_release || '';
    tr.appendChild(tdCountry);

    const tdDigital = document.createElement('td');
    tdDigital.textContent = r.digital_release || '';
    tr.appendChild(tdDigital);

    const tdId = document.createElement('td');
    tdId.textContent = r.tmdb_id || '';
    tdId.className = 'small-muted';
    tr.appendChild(tdId);

    tbody.appendChild(tr);
  });
}
