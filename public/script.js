// public/script.js — uses Google Sheets URL (CSV) as source of tmdb ids
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

function typeLetter(typeNum) {
  if (!typeNum && typeNum !== 0) return '';
  const n = Number(typeNum);
  if (n === 3) return 'T';
  if (n === 4) return 'D';
  if (n === 5) return 'P';
  if (n === 6) return 'TV';
  return String(n);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideStatus();
  resultsSection.classList.add('hidden');
  tbody.innerHTML = '';

  const sheetUrl = document.getElementById('sheetUrl').value.trim();
  const country = document.getElementById('country').value.trim().toUpperCase();
  const excludePremieresChecked = document.getElementById('excludePremieres').checked || false;

  if (!sheetUrl || !country) {
    showStatus('Please fill Google Sheets URL and country ISO.', true);
    return;
  }

  countryLabel.textContent = country;
  showStatus('Fetching TMDB release dates — this may take a few seconds...');

  try {
    const resp = await fetch('/api/list-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetUrl, country, excludePremieres: excludePremieresChecked })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Server error ${resp.status}${txt ? `: ${txt}` : ''}`);
    }

    const json = await resp.json().catch(() => null);
    if (!json) throw new Error('Invalid JSON response from server');

    let rows = null;
    if (Array.isArray(json)) {
      rows = json;
    } else if (json && typeof json === 'object' && Array.isArray(json.results)) {
      if (json.ok === false) {
        const msg = json.error || 'Server returned ok=false';
        throw new Error(msg);
      }
      rows = json.results;
    } else {
      throw new Error('Invalid server response structure');
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      showStatus('No films found in the sheet (or response empty).', true);
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
  document.getElementById('sheetUrl').value = '';
  document.getElementById('country').value = '';
  document.getElementById('excludePremieres').checked = false;
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
    tdIndex.className = 'center';
    tr.appendChild(tdIndex);

    const tdName = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://www.themoviedb.org/movie/${r.tmdb_id || ''}`;
    a.textContent = r.film_name || r.tmdb_id || '';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'film-link';
    tdName.appendChild(a);
    tr.appendChild(tdName);

    const tdCountry = document.createElement('td');
    tdCountry.className = 'center';
    if (r.country_release) {
      const letter = typeLetter(r.country_release_type) || '';
      tdCountry.textContent = letter ? `${r.country_release} (${letter})` : r.country_release;
    } else tdCountry.textContent = '';
    tr.appendChild(tdCountry);

    const tdDigital = document.createElement('td');
    tdDigital.className = 'center';
    if (r.digital_release) {
      const letter = typeLetter(r.digital_release_type) || '';
      tdDigital.textContent = letter ? `${r.digital_release} (${letter})` : r.digital_release;
    } else tdDigital.textContent = '';
    tr.appendChild(tdDigital);

    const tdId = document.createElement('td');
    tdId.className = 'center small-muted';
    tdId.textContent = r.tmdb_id || '';
    tr.appendChild(tdId);

    const tdError = document.createElement('td');
    tdError.className = 'center';
    tdError.style.color = '#ffb3b3';
    tdError.textContent = (Array.isArray(r.error) ? r.error.join(' | ') : (r.error || '')) || '';
    tr.appendChild(tdError);

    tbody.appendChild(tr);
  });
}
