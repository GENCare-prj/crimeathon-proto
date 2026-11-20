// SQLite database layer (uses Node's built-in node:sqlite, so no extra install needed. Needs Node 22.13+)
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, "data", "payroll.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    month        TEXT NOT NULL,              -- 'YYYY-MM'
    name         TEXT NOT NULL DEFAULT '',
    payroll_id   TEXT NOT NULL DEFAULT '',
    salary       REAL NOT NULL DEFAULT 0,
    bank_account TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL,              -- 'Verified' or 'Review'
    reasons      TEXT NOT NULL DEFAULT ''    -- reasons joined by ' | '
  );
  CREATE INDEX IF NOT EXISTS idx_employees_month ON employees(month);
`);

// ---------- Ghost-account checks ----------
function analyze(rows) {
  const idCount = {}, bankCount = {};
  const clean = rows.map((r) => ({
    name: String(r.name || "").trim(),
    payroll_id: String(r.payroll_id || "").trim(),
    salary: Number(String(r.salary || "").replace(/[^0-9.]/g, "")),
    bank_account: String(r.bank_account || "").trim(),
  }));
  clean.forEach((r) => {
    idCount[r.payroll_id] = (idCount[r.payroll_id] || 0) + 1;
    if (r.bank_account) bankCount[r.bank_account] = (bankCount[r.bank_account] || 0) + 1;
  });
  return clean.map((r) => {
    const reasons = [];
    if (!r.name || !r.payroll_id) reasons.push("Missing name or payroll ID");
    if (!Number.isFinite(r.salary) || r.salary <= 0) reasons.push("Invalid salary");
    if (r.payroll_id && idCount[r.payroll_id] > 1) reasons.push("Duplicate payroll ID");
    if (r.bank_account && bankCount[r.bank_account] > 1) reasons.push("Bank account shared with another employee");
    return { ...r, salary: Number.isFinite(r.salary) ? r.salary : 0, status: reasons.length ? "Review" : "Verified", reasons: reasons.join(" | ") };
  });
}

// ---------- Queries ----------
const monthOffset = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 7); };
const currentMonthKey = () => monthOffset(0);

// "current" = newest month in the table, "previous" = the one before it
function monthFor(batch) {
  const months = db.prepare("SELECT DISTINCT month FROM employees ORDER BY month DESC LIMIT 2").all().map((r) => r.month);
  return (batch === "previous" ? months[1] : months[0]) || null;
}

function listEmployees(month, onlyFlagged = false) {
  if (!month) return [];
  const sql = `SELECT name, payroll_id, salary, bank_account, status, reasons FROM employees
               WHERE month = ? ${onlyFlagged ? "AND status = 'Review'" : ""} ORDER BY id`;
  return db.prepare(sql).all(month).map((r) => ({ ...r, reasons: r.reasons ? r.reasons.split(" | ") : [] }));
}

function stats() {
  const month = monthFor("current");
  if (!month) return { month: null, flagged: 0, verified: 0, total: 0, coverage: 0 };
  const row = db.prepare(`SELECT COUNT(*) total, SUM(status = 'Review') flagged FROM employees WHERE month = ?`).get(month);
  const flagged = row.flagged || 0, verified = row.total - flagged;
  return { month, flagged, verified, total: row.total, coverage: row.total ? +((verified / row.total) * 100).toFixed(1) : 0 };
}

// Replace all rows of one month with a new upload (all-or-nothing)
function replaceMonth(month, analyzedRows) {
  const insert = db.prepare("INSERT INTO employees (month, name, payroll_id, salary, bank_account, status, reasons) VALUES (?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM employees WHERE month = ?").run(month);
    for (const r of analyzedRows) insert.run(month, r.name, r.payroll_id, r.salary, r.bank_account, r.status, r.reasons);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ---------- Sample data on first run, so the buttons show something right away ----------
function seedIfEmpty() {
  if (db.prepare("SELECT COUNT(*) c FROM employees").get().c) return;
  const prev = [
    ["Maya Chen", "PG-2048", 8420, "1001001"], ["Jon Bell", "PG-2089", 7960, "1001002"], ["A. Walker", "PG-2166", 5200, "1001003"],
    ["R. Singh", "PG-2190", 9840, "1001004"], ["Priya Nair", "PG-2201", 6500, "1001005"], ["Karthik Raj", "PG-2210", 7100, "1001006"],
  ];
  const cur = [...prev, ["Ghost Person", "PG-2190", 4100, "1001007"], ["Divya S", "PG-2230", 6900, "1001003"], ["Sam Lee", "PG-2244", 7300, "1001008"]];
  const toRows = (list) => analyze(list.map(([name, payroll_id, salary, bank_account]) => ({ name, payroll_id, salary, bank_account })));
  replaceMonth(monthOffset(-1), toRows(prev));
  replaceMonth(monthOffset(0), toRows(cur));
}

module.exports = { analyze, monthFor, listEmployees, stats, replaceMonth, seedIfEmpty, currentMonthKey };
