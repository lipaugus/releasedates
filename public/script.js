// public/script.js
// Frontend that POSTs to /api/list-release and accepts either:
//  - an array (old behavior), or
//  - { ok: true, results: [...] } (newer server behaviour).
// Renders movie rows and per-item error messages (if any).

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
function hideStatus() {
  statusEl.classList.add('hidden');
  statusEl.textContent = '';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideStatus();
  resultsSection.classList.add('hidden');
  tbody.innerHTML = '';

  const username = document.getElementById('username').value.trim();
  const listname = document.getElementById('listname').value.trim();
  const country = document.getElementById('country').value.trim().toUpperCase();

  if (!username || !listname || !country) {
    showStatus('Please fill username, list slug and country ISO.', true);
    return;
  }

  countryLabel.textContent = country;
  showStatus('Fetching list and release dates — this may take a few seconds...');

  try {
    const resp = await fetch('/api/list-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, listname, country })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Server error ${resp.status}${txt ? `: ${txt}` : ''}`);
    }

    const json = await resp.json().catch(() => null);
    if (!json) throw new Error('Invalid JSON response from server');

    // Accept either an array or the object { ok: true, results: [...] }
    let rows = null;
    if (Array.isArray(json)) {
      rows = json;
    } else if (json && typeof json === 'object' && Array.isArray(json.results)) {
      if (json.ok === false) {
        // server indicated failure
        const msg = json.error || 'Server returned ok=false';
        throw new Error(msg);
      }
      rows = json.results;
    } else {
      throw new Error('Invalid server response structure');
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      showStatus('No films found in the list (or response empty).', true);
      return;
    }

    hideStatus();
    renderTable(rows);
  } catch (err) {
    console.error(err);
    showStatus('Error: ' + (err.message || String(err)), true);
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

  // If table has no "Error" column, add it
  const thead = document.querySelector('thead tr');
  if (!thead.querySelector('.col-error')) {
    const th = document.createElement('th');
    th.textContent = 'Error';
    th.className = 'col-error';
    thead.appendChild(th);
  }

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');

    const tdIndex = document.createElement('td');
    tdIndex.textContent = (i + 1).toString();
    tr.appendChild(tdIndex);

    const tdName = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://letterboxd.com/film/${r.film_query || ''}/`;
    a.textContent = r.film_name || r.film_query || '';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
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

    const tdError = document.createElement('td');
    tdError.textContent = (Array.isArray(r.error) ? r.error.join(' | ') : (r.error || '')) || '';
    tdError.style.color = '#ffb3b3';
    tr.appendChild(tdError);

    tbody.appendChild(tr);
  });
}
