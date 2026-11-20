const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- API helper (same origin: the backend serves this page) ----------
const token = () => sessionStorage.getItem("pg_token");
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token()) headers.Authorization = "Bearer " + token();
  const res = await fetch("/api" + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || "Request failed"); err.status = res.status; throw err; }
  return data;
}

// ---------- Hero art ----------
const lines = ["verify.payroll()", "if (employee.id)", "access: granted", "scan / ghost_00", "salary.sync()", "// encrypted", "0x7F3A  0x19C2", "hash.match(id)"];
$("#code-field").innerHTML = Array.from({ length: 16 }, (_, i) =>
  `<span style="--i:${i};left:${(i * 29) % 70 + 3}%;top:${(i * 6.2) % 92 + 2}%">${lines[i % lines.length]}</span>`).join("");
$("#particles").innerHTML = Array.from({ length: 34 }, () =>
  `<i style="left:${Math.random() * 100}%;top:${Math.random() * 100}%;animation-delay:${(-Math.random() * 6).toFixed(1)}s;--s:${(1 + Math.random() * 2.5).toFixed(1)}px"></i>`).join("");
const art = $("#hero-art");
window.addEventListener("pointermove", (e) => {
  art.style.setProperty("--mx", `${(e.clientX / innerWidth - .5) * 16}px`);
  art.style.setProperty("--my", `${(e.clientY / innerHeight - .5) * 12}px`);
});

// ---------- Nav ----------
const nav = $("#nav");
$("#menu-btn").addEventListener("click", () => nav.classList.toggle("open"));
$$("[data-go]").forEach((b) => b.addEventListener("click", () => { nav.classList.remove("open"); window.scrollTo({ top: 0, behavior: "smooth" }); }));

// ---------- Modals ----------
const panelModal = $("#panel-modal"), loginModal = $("#login-modal");
let lastFocus = null;
const openModal = (m) => { lastFocus = document.activeElement; m.hidden = false; $("button, input", m)?.focus(); };
const closeModals = () => { panelModal.hidden = loginModal.hidden = true; lastFocus?.focus(); };

// ---------- Tables ----------
const table = (head, rows) => rows.length
  ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
  : `<p class="empty">No data yet. Upload an employee file to get started.</p>`;
const empRow = (e) => `<tr><td><span class="avatar">${esc(e.name[0] || "?")}</span>${esc(e.name || "(no name)")}</td><td>${esc(e.payroll_id)}</td>
  <td>$${Number(e.salary || 0).toLocaleString("en-US")}</td><td class="st ${e.status === "Review" ? "review" : ""}" title="${esc((e.reasons || []).join("; "))}">${e.status}${e.reasons?.length ? " · " + esc(e.reasons[0]) : ""}</td></tr>`;
const empHead = ["Employee", "Payroll ID", "Net salary", "Status"];

const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthLabel = (m) => new Date(m + "-01T00:00:00").toLocaleString("en-US", { month: "long", year: "numeric" });
const withMeta = (data, noun) => data.month
  ? `<p class="meta"><strong>${monthLabel(data.month)}</strong> · ${data.employees.length} ${noun}</p>` + table(empHead, data.employees.map(empRow))
  : `<p class="empty">No data yet. Upload an employee file to get started.</p>`;

const uploadHTML = () => `<div class="drop" id="dropzone"><strong>Drop employee data here</strong>
  <span>CSV or JSON with columns: name, payroll_id, salary, bank_account, manager_email</span>
  <label class="month-pick">Salary month <input type="month" id="upload-month" value="${thisMonth()}"></label>
  <input type="file" id="file-input" accept=".csv,.json" hidden><button class="gold-btn sm" id="choose-file">Choose file</button><span id="file-name"></span></div>`;

// ---------- Missing-employee cases (flowchart) ----------
let casesCache = [];
const managerLink = (t) => `${location.origin}/manager.html?token=${t}`;
const caseClass = (s) => (s === "Salary stopped" ? "stopped" : s === "Pending manager" ? "review" : "");

async function casesHTML(notice) {
  const { cases } = await api("/cases");
  casesCache = cases;
  const rows = cases.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.payroll_id)}</td><td>${esc(c.manager_email || "(no manager email)")}</td>
    <td class="st ${caseClass(c.status)}">${esc(c.status)}</td>
    <td class="acts"><a class="mini" href="${managerLink(c.token)}" target="_blank" rel="noopener">Manager page</a>
    <button class="mini" data-act="copy" data-token="${c.token}">Copy link</button>
    <button class="mini" data-act="report" data-id="${c.id}">Report</button></td></tr>`);
  return `<div class="bar"><span class="meta">Paid last month but missing this month</span><button class="gold-btn sm" data-act="run">Run check</button></div>
    ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
    ${cases.length ? table(["Employee", "Payroll ID", "Manager", "Status", "Actions"], rows) : `<p class="empty">No cases yet. Click "Run check" after uploading last month and this month.</p>`}`;
}

function reportHTML(c) {
  const mgr = c.status === "Pending manager" ? "Waiting for manager" : c.status === "Salary continues" ? "Still working" : "Has left";
  const action = c.status === "Salary stopped" ? "Salary stopped, SSO account disabled, kiosk account disabled" : "None yet";
  const ev = (code, label, v) => `<tr><td>${code}</td><td>${label}</td><td>${v}</td></tr>`;
  const na = "Not connected (demo)";
  return `<div class="report"><p class="meta"><strong>Case #${c.id}</strong> · Risk level: <strong>${esc(c.risk)}</strong></p>
    <table><tbody>
      <tr><th>Employee</th><td>${esc(c.name)} (${esc(c.payroll_id)})</td></tr>
      <tr><th>Last paid</th><td>${monthLabel(c.last_paid)}</td></tr>
      <tr><th>Missing from</th><td>${monthLabel(c.month)}</td></tr>
      <tr><th>Manager</th><td>${esc(c.manager_email || "(none)")}</td></tr>
      <tr><th>Manager verification</th><td>${mgr}</td></tr>
      <tr><th>Action taken</th><td>${action}</td></tr>
    </tbody></table>
    <h3>Evidence checklist</h3>
    <table><thead><tr><th>Code</th><th>Evidence</th><th>Checked</th></tr></thead><tbody>
      ${ev("E14", "Staff roster", "Yes, compared with payroll")}${ev("E03", "SSO log", na)}${ev("E02", "HelpDeskr audit", na)}
      ${ev("E05", "BlueVault access", na)}${ev("E10", "IT security policy", na)}
    </tbody></table>
    <p class="meta">SSO and kiosk accounts are marked disabled in this app's database. Connect your real SSO and kiosk systems to enforce it.</p>
    <p class="noprint"><button class="mini" data-act="back">Back to cases</button> <button class="mini" data-act="print">Print report</button></p></div>`;
}

// ---------- Panels ----------
async function render(name, notice) {
  if (name === "Upload Employee Details") return uploadHTML();
  if (name === "Missing Employee Cases") return casesHTML(notice);
  if (name === "Access Control") return table(["Team", "Access", "Status"], [["Finance", "Payroll approval", "Active"], ["HR", "Employee records", "Active"], ["Contractors", "Own timesheets only", "Limited"]]
    .map((a) => `<tr><td>${a[0]}</td><td>${a[1]}</td><td class="st ${a[2] === "Limited" ? "review" : ""}">${a[2]}</td></tr>`));
  if (name === "Reports") return withMeta(await api("/reports/flagged"), "flagged accounts");
  const batch = name === "Previous Month List" ? "previous" : "current";
  return withMeta(await api("/employees?batch=" + batch), "employees");
}

function wireUpload() {
  const input = $("#file-input"), zone = $("#dropzone"), out = $("#file-name");
  async function send(file) {
    if (!file) return;
    out.textContent = `Uploading ${file.name}...`;
    const fd = new FormData(); fd.append("month", $("#upload-month").value || thisMonth()); fd.append("file", file);
    try {
      const r = await api("/upload", { method: "POST", body: fd });
      out.textContent = `Saved to database for ${monthLabel(r.month)}: ${r.total} employees, ${r.flagged} flagged.`;
      loadStats();
    } catch (e) { out.textContent = e.message; }
  }
  $("#choose-file").addEventListener("click", () => input.click());
  input.addEventListener("change", () => send(input.files[0]));
  zone.addEventListener("dragover", (e) => e.preventDefault());
  zone.addEventListener("drop", (e) => { e.preventDefault(); send(e.dataTransfer.files[0]); });
}

function needLogin() { closeModals(); $("#login-msg").textContent = "Log in to continue."; openModal(loginModal); }

async function showPanel(name, notice) {
  nav.classList.remove("open");
  $("#panel-title").textContent = name;
  $("#panel-body").innerHTML = `<p class="empty">Loading...</p>`;
  openModal(panelModal);
  try {
    $("#panel-body").innerHTML = await render(name, notice);
    if (name === "Upload Employee Details") wireUpload();
  } catch (e) {
    if (e.status === 401) needLogin();
    else $("#panel-body").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}
$$("[data-panel]").forEach((btn) => btn.addEventListener("click", () => showPanel(btn.dataset.panel)));

// Buttons inside the cases panel
$("#panel-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  try {
    if (act === "run") { const r = await api("/cases/run", { method: "POST" }); showPanel("Missing Employee Cases", r.message); }
    else if (act === "copy") {
      const link = managerLink(b.dataset.token);
      try { await navigator.clipboard.writeText(link); b.textContent = "Copied!"; } catch { prompt("Copy this link:", link); }
    } else if (act === "report") {
      const c = casesCache.find((x) => x.id === Number(b.dataset.id));
      if (c) { $("#panel-title").textContent = "Evidence Case File"; $("#panel-body").innerHTML = reportHTML(c); }
    } else if (act === "back") showPanel("Missing Employee Cases");
    else if (act === "print") window.print();
  } catch (err) { if (err.status === 401) needLogin(); else alert(err.message); }
});

$("#open-login").addEventListener("click", () => { nav.classList.remove("open"); openModal(loginModal); });
$$("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
[panelModal, loginModal].forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModals(); }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });

// ---------- Login ----------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#login-msg");
  try {
    const { token: t } = await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("#login-email").value.trim(), password: $("#login-pass").value }),
    });
    sessionStorage.setItem("pg_token", t);
    $("#login-pass").value = "";
    closeModals(); loadStats();
  } catch (err) { msg.textContent = err.message; }
});

// ---------- Dashboard cards ----------
async function loadStats() {
  if (!token()) return;
  try {
    const s = await api("/stats");
    $("#stat-flagged").textContent = s.flagged;
    $("#stat-verified").textContent = s.verified.toLocaleString("en-US");
    $("#stat-note").textContent = `${s.coverage}% coverage`;
  } catch {}
}
loadStats();
