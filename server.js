
const express = require("express");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const { parse } = require("csv-parse/sync");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "development-secret-change-before-deployment";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@company.com").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// ---------- Database ----------

const db = require("./db");

// Do NOT call db.seedIfEmpty().
// It creates sample employee records.

const databasePath = path.join(__dirname, "data", "payroll.db");
const sqlDb = new DatabaseSync(databasePath);

// Add manager_email to existing employee databases.
const employeeColumns = sqlDb.prepare("PRAGMA table_info(employees)").all();
if (!employeeColumns.some((column) => column.name === "manager_email")) {
  sqlDb.exec("ALTER TABLE employees ADD COLUMN manager_email TEXT NOT NULL DEFAULT ''");
}

// Store missing-employee cases.
sqlDb.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    last_paid TEXT NOT NULL,
    name TEXT NOT NULL,
    payroll_id TEXT NOT NULL,
    manager_email TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'Pending manager',
    risk TEXT NOT NULL DEFAULT 'Medium',
    response_at TEXT,
    UNIQUE(month, payroll_id)
  );
`);

// ---------- Middleware ----------

app.use(express.json({ limit: "100kb" }));

// Basic CORS support.
// Set CORS_ORIGIN to your frontend origin when deploying separately.
const allowedOrigins = (process.env.CORS_ORIGIN ||
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5500,http://127.0.0.1:5500")
  .split(",")
  .map((origin) => origin.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Frontend folder: backend/../frontend by default.
// You can override this using FRONTEND_DIR.
const frontendPath = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.join(__dirname, "..", "frontend");

if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}

// ---------- File Upload ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (![".csv", ".json"].includes(extension)) {
      return callback(new Error("Only CSV and JSON files are allowed."));
    }

    callback(null, true);
  }
});

// ---------- Authentication ----------

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const loginAttempts = new Map();

function recentAttempts(ip) {
  const now = Date.now();

  const attempts = (loginAttempts.get(ip) || []).filter(
    (time) => now - time < 15 * 60 * 1000
  );

  loginAttempts.set(ip, attempts);

  return attempts;
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired login session."
    });
  }
}

// ---------- Login API ----------

app.post("/api/login", (req, res) => {
  const attempts = recentAttempts(req.ip);

  if (attempts.length >= 5) {
    return res.status(429).json({
      error: "Too many attempts. Try again in 15 minutes."
    });
  }

  const { email = "", password = "" } = req.body || {};

  const validEmail = safeEqual(
    String(email).trim().toLowerCase(),
    ADMIN_EMAIL
  );

  const validPassword = safeEqual(password, ADMIN_PASSWORD);

  if (!validEmail || !validPassword) {
    attempts.push(Date.now());

    return res.status(401).json({
      error: "Wrong email or password."
    });
  }

  const token = jwt.sign(
    { email: ADMIN_EMAIL },
    JWT_SECRET,
    { expiresIn: "8h" }
  );

  res.json({ token });
});

// ---------- Dashboard Statistics ----------

app.get("/api/stats", authenticate, (req, res) => {
  res.json(db.stats());
});

// ---------- Employee List ----------

app.get("/api/employees", authenticate, (req, res) => {
  const batch = req.query.batch === "previous"
    ? "previous"
    : "current";

  const month = db.monthFor(batch);

  const employees = db.listEmployees(month);

  res.json({
    month,
    employees
  });
});

// ---------- Single Employee ----------

app.get("/api/employees/:id", authenticate, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid employee ID." });
  }

  const employee = sqlDb.prepare(
    "SELECT * FROM employees WHERE id = ?"
  ).get(id);

  if (!employee) {
    return res.status(404).json({ error: "Employee not found." });
  }

  res.json(employee);
});

// ---------- Update Employee ----------

app.put("/api/employees/:id", authenticate, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid employee ID." });
  }

  const existing = sqlDb.prepare(
    "SELECT * FROM employees WHERE id = ?"
  ).get(id);

  if (!existing) {
    return res.status(404).json({ error: "Employee not found." });
  }

  const name = String(req.body.name ?? existing.name).trim();
  const payroll_id = String(
    req.body.payroll_id ?? existing.payroll_id
  ).trim();

  const salary = Number(req.body.salary ?? existing.salary);

  const bank_account = String(
    req.body.bank_account ?? existing.bank_account
  ).trim();

  const manager_email = String(
    req.body.manager_email ?? existing.manager_email
  ).trim();

  if (!name || !payroll_id || !Number.isFinite(salary) || salary <= 0) {
    return res.status(400).json({
      error: "Enter a valid name, payroll ID and positive salary."
    });
  }

  const sameMonth = sqlDb.prepare(
    "SELECT * FROM employees WHERE month = ? AND id != ?"
  ).all(existing.month, id);

  const analyzed = db.analyze([
    ...sameMonth,
    { name, payroll_id, salary, bank_account }
  ]);

  const updated = analyzed[analyzed.length - 1];

  sqlDb.prepare(`
    UPDATE employees
    SET name = ?, payroll_id = ?, salary = ?,
        bank_account = ?, status = ?, reasons = ?,
        manager_email = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.payroll_id,
    updated.salary,
    updated.bank_account,
    updated.status,
    updated.reasons,
    manager_email,
    id
  );

  res.json({
    message: "Employee updated successfully.",
    employee: sqlDb.prepare(
      "SELECT * FROM employees WHERE id = ?"
    ).get(id)
  });
});

// ---------- Delete Employee ----------

app.delete("/api/employees/:id", authenticate, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid employee ID." });
  }

  const result = sqlDb.prepare(
    "DELETE FROM employees WHERE id = ?"
  ).run(id);

  if (!result.changes) {
    return res.status(404).json({ error: "Employee not found." });
  }

  res.json({
    message: "Employee deleted successfully."
  });
});

// ---------- Upload Employee Data ----------

app.post(
  "/api/upload",
  authenticate,
  upload.single("file"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Please select a CSV or JSON file."
      });
    }

    const month = String(
      req.body.month || db.currentMonthKey()
    );

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({
        error: "Month must be in YYYY-MM format."
      });
    }

    try {
      const extension = path.extname(
        req.file.originalname
      ).toLowerCase();

      let rows;

      if (extension === ".csv") {
        rows = parse(req.file.buffer.toString("utf8"), {
          columns: true,
          skip_empty_lines: true,
          trim: true
        });
      } else {
        const parsed = JSON.parse(
          req.file.buffer.toString("utf8")
        );

        rows = Array.isArray(parsed)
          ? parsed
          : parsed.employees;
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({
          error: "The uploaded file contains no employee records."
        });
      }

      if (rows.length > 10000) {
        return res.status(400).json({
          error: "The file contains too many records."
        });
      }

      const normalizedRows = rows.map((row) => ({
        name: row.name,
        payroll_id: row.payroll_id,
        salary: row.salary,
        bank_account: row.bank_account,
        manager_email: row.manager_email
      }));

      const analyzed = db.analyze(normalizedRows);

      // Save employee records.
      db.replaceMonth(month, analyzed);

      // Save manager email separately because db.js's original
      // replaceMonth function does not include that column.
      const updateManager = sqlDb.prepare(`
        UPDATE employees
        SET manager_email = ?
        WHERE month = ? AND payroll_id = ?
      `);

      for (const row of normalizedRows) {
        updateManager.run(
          String(row.manager_email || "").trim(),
          month,
          String(row.payroll_id || "").trim()
        );
      }

      const flagged = analyzed.filter(
        (employee) => employee.status === "Review"
      ).length;

      res.json({
        message: "Employee data uploaded successfully.",
        month,
        total: analyzed.length,
        flagged
      });

    } catch (error) {
      res.status(400).json({
        error: "Could not process the file: " + error.message
      });
    }
  }
);

// ---------- Flagged Employee Report ----------

app.get("/api/reports/flagged", authenticate, (req, res) => {
  const month = db.monthFor("current");

  res.json({
    month,
    employees: db.listEmployees(month, true)
  });
});

// ---------- Missing Employee Cases ----------

app.get("/api/cases", authenticate, (req, res) => {
  const cases = sqlDb.prepare(
    "SELECT * FROM cases ORDER BY id DESC"
  ).all();

  res.json({ cases });
});

// Compare previous payroll with current payroll.
app.post("/api/cases/run", authenticate, (req, res) => {
  const previousMonth = db.monthFor("previous");
  const currentMonth = db.monthFor("current");

  if (!previousMonth || !currentMonth) {
    return res.status(400).json({
      error: "Upload two different payroll months before running the check."
    });
  }

  if (previousMonth === currentMonth) {
    return res.status(400).json({
      error: "Previous and current payroll months must be different."
    });
  }

  const previousEmployees = sqlDb.prepare(
    "SELECT * FROM employees WHERE month = ?"
  ).all(previousMonth);

  const currentEmployees = sqlDb.prepare(
    "SELECT payroll_id FROM employees WHERE month = ?"
  ).all(currentMonth);

  const currentIds = new Set(
    currentEmployees.map((employee) => employee.payroll_id)
  );

  const missingEmployees = previousEmployees.filter(
    (employee) => !currentIds.has(employee.payroll_id)
  );

  const insertCase = sqlDb.prepare(`
    INSERT INTO cases
      (month, last_paid, name, payroll_id, manager_email, token, status, risk)
    VALUES (?, ?, ?, ?, ?, ?, 'Pending manager', ?, ?)
    ON CONFLICT(month, payroll_id) DO NOTHING
  `);

  for (const employee of missingEmployees) {
    const token = crypto.randomBytes(32).toString("hex");

    const risk = employee.status === "Review"
      ? "High"
      : "Medium";

    insertCase.run(
      currentMonth,
      previousMonth,
      employee.name,
      employee.payroll_id,
      employee.manager_email || "",
      token,
      risk
    );
  }

  res.json({
    message: `${missingEmployees.length} missing employee record(s) found.`,
    total: missingEmployees.length
  });
});

// ---------- Manager Verification ----------

// Public endpoint: access is controlled by the unique manager token.
app.get("/api/manager/:token", (req, res) => {
  const record = sqlDb.prepare(
    "SELECT * FROM cases WHERE token = ?"
  ).get(req.params.token);

  if (!record) {
    return res.status(404).json({
      error: "Manager verification link is invalid."
    });
  }

  res.json(record);
});

// Manager submits their response.
app.post("/api/manager/:token/answer", (req, res) => {
  const record = sqlDb.prepare(
    "SELECT * FROM cases WHERE token = ?"
  ).get(req.params.token);

  if (!record) {
    return res.status(404).json({
      error: "Manager verification link is invalid."
    });
  }

  if (record.status !== "Pending manager") {
    return res.status(409).json({
      error: "This case has already been answered."
    });
  }

  if (typeof req.body.stillWorking !== "boolean") {
    return res.status(400).json({
      error: "Please submit a valid manager response."
    });
  }

  const status = req.body.stillWorking
    ? "Salary continues"
    : "Salary stopped";

  sqlDb.prepare(`
    UPDATE cases
    SET status = ?, response_at = ?
    WHERE token = ?
  `).run(
    status,
    new Date().toISOString(),
    req.params.token
  );

  res.json({
    ...record,
    status,
    response_at: new Date().toISOString()
  });
});

// ---------- 404 Handler ----------

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API endpoint not found."
  });
});

// ---------- Error Handler ----------

app.use((error, req, res, next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: "File upload error: " + error.message
    });
  }

  res.status(500).json({
    error: error.message || "Internal server error."
  });
});

// ---------- Start Server ----------

app.listen(PORT, () => {
  console.log("----------------------------------");
  console.log("       PAYROLL GUARD SERVER");
  console.log("----------------------------------");
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("Database connected.");
  console.log("----------------------------------");
});
s