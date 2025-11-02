// script.js — frontend that calls a backend API to do the scraping & TMDB lookups.
//
// IMPORTANT: Replace API_BASE with your deployed backend (see server code).
const API_BASE = "https://your-backend.example.com"; // <-- deploy the Node server and put URL here

function el(q, root=document) { return root.querySelector(q); }
function els(q, root=document) { return Array.from(root.querySelectorAll(q)); }

const form = el("#form");
const status = el("#status");
const results = el("#results");
const tbody = el("tbody");
const countryLabel = el("#countryLabel");

function setStatus(text, isError=false) {
  status.classList.remove("hidden");
  status.textContent = text;
  status.style.color = isError ? "#ffb3b3" : "";
}

function clearStatus(){
  status.classList.add("hidden");
  status.textContent = "";
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearStatus();
  tbody.innerHTML = "";
  results.classList.add("hidden");

  const username = el("#username").value.trim();
  const listname = el("#listname").value.trim();
  const country = el("#country").value.trim().toUpperCase();

  if(!username || !listname || !country) {
    setStatus("Please fill username, list slug and country ISO.", true);
    return;
  }

  countryLabel.textContent = country;
  setStatus("Starting… fetching list and release dates (this can take a few seconds)…");

  try {
    const resp = await fetch(`${API_BASE}/api/list-release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, listname, country })
    });

    if(!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Server error ${resp.status}: ${txt}`);
    }

    const json = await resp.json();
    if(!Array.isArray(json)) throw new Error("Invalid response from server");

    if(json.length === 0) {
      setStatus("No films found in list or something went wrong.", true);
      return;
    }

    setStatus(`Received ${json.length} rows — rendering table...`);
    renderTable(json);
    clearStatus();
  } catch(err) {
    console.error(err);
    setStatus("Error: " + err.message, true);
  }
});

el("#clear").addEventListener("click", () => {
  el("#username").value = "";
  el("#listname").value = "";
  el("#country").value = "";
  tbody.innerHTML = "";
  results.classList.add("hidden");
  clearStatus();
});

function formatMaybeDate(d) {
  if(!d) return "";
  return d; // server already returns DD-MM-YYYY
}

function renderTable(rows) {
  results.classList.remove("hidden");
  tbody.innerHTML = "";
  rows.forEach((r, idx) => {
    const tr = document.createElement("tr");
    const nr = document.createElement("td");
    nr.textContent = (idx + 1).toString();
    tr.appendChild(nr);

    const nameTd = document.createElement("td");
    const a = document.createElement("a");
    a.href = `https://letterboxd.com/film/${r.film_query}/`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "film-link";
    a.textContent = r.film_name || r.film_query;
    nameTd.appendChild(a);
    tr.appendChild(nameTd);

    const theatreTd = document.createElement("td");
    theatreTd.textContent = formatMaybeDate(r.country_release);
    tr.appendChild(theatreTd);

    const digitalTd = document.createElement("td");
    digitalTd.textContent = formatMaybeDate(r.digital_release);
    tr.appendChild(digitalTd);

    const idTd = document.createElement("td");
    idTd.textContent = r.tmdb_id || "";
    idTd.className = "small-muted";
    tr.appendChild(idTd);

    tbody.appendChild(tr);
  });
}
