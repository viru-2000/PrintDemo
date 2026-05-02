require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const db       = require("./database/db");
const cors     = require("cors");
const fs       = require("fs");
const path     = require("path");
const pdfParse = require("pdf-parse");
const crypto   = require("crypto");
const Razorpay = require("razorpay");
const cron     = require("node-cron");
const bcrypt   = require("bcrypt");
const { getIO, initSocket } = require("./server/socket");
const adminRoutes            = require("./routes/admin.routes");

const app = express();

console.log("ENV CHECK:");
console.log("RAZORPAY_KEY_ID:", process.env.RAZORPAY_KEY_ID ? "OK" : "MISSING");
console.log("DB_HOST:", process.env.DB_HOST || process.env.MYSQLHOST);

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

/* ---------------- CONFIG ---------------- */
// ✅ Razorpay — only initialize if keys are present
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} else {
  console.warn("⚠️ Razorpay keys missing — payment routes will return 503");
}

// ✅ The public URL of this Railway deployment
// Set this in Railway Variables: API_BASE_URL = https://your-app.up.railway.app/api
const SERVER_API_BASE = process.env.API_BASE_URL || "https://print-production-524d.up.railway.app/api";

/* ---------------- CORS ---------------- */
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const allowed =
      origin.endsWith(".vercel.app") ||
      origin === "https://print-kappa-sepia.vercel.app" ||
      /^http:\/\/localhost:\d+$/.test(origin) ||
      /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin);

    if (allowed) return callback(null, true);
    console.warn("CORS blocked:", origin);
    callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "x-machine-id",
    "x-timestamp",
    "x-signature",
    "x-api-key",
  ],
  credentials: true,
}));

/* ---------------- MIDDLEWARE ---------------- */
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api/admin", adminRoutes);

/* ---------------- UPLOAD DIR ---------------- */
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + ".pdf");
  },
});

const upload = multer({
  storage,
  fileFilter: (_, file, cb) =>
    file.mimetype === "application/pdf"
      ? cb(null, true)
      : cb(new Error("Only PDF allowed")),
});

/* ---------------- HELPERS ---------------- */
const generateOTP = () =>
  Math.floor(1000 + Math.random() * 9000).toString();

const generateQrToken = () =>
  crypto.randomBytes(32).toString("hex");

function calculatePrice(job) {
  let rate;
  if (job.color === "bw") {
    rate = job.print_side === "duplex" ? 4 : 2;
  } else {
    rate = job.print_side === "duplex" ? 10 : 5;
  }

  const units =
    job.print_side === "duplex"
      ? Math.ceil(job.total_pages / 2) * job.copies
      : job.total_pages * job.copies;

  return {
    units,
    rate,
    total: units * rate,
    paise: units * rate * 100,
  };
}

/* ---------------- AUDIT LOGGER ---------------- */
async function logAudit(machineId, jobId, action, details = null) {
  try {
    await db.query(
      `INSERT INTO audit_logs (machine_id, job_id, action, details)
       VALUES (?, ?, ?, ?)`,
      [machineId, jobId, action, JSON.stringify(details)]
    );
  } catch (err) {
    console.error("AUDIT LOG ERROR:", err.message);
  }
}

/* ---------------- MACHINE AUTH ---------------- */
async function verifyMachine(req, res, next) {
  try {
    const machineId = req.headers["x-machine-id"];
    const timestamp = req.headers["x-timestamp"];
    const signature = req.headers["x-signature"];
    const apiKey    = req.headers["x-api-key"];

    if (!machineId || !timestamp || !signature || !apiKey) {
      return res.status(401).json({ error: "Missing auth headers" });
    }

    const requestTime = parseInt(timestamp);
    const now = Date.now();

    if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
      return res.status(401).json({ error: "Request expired" });
    }

    const [[machine]] = await db.query(
      `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`,
      [machineId]
    );

    if (!machine) {
      return res.status(403).json({ error: "Invalid machine" });
    }

    const valid = await bcrypt.compare(apiKey, machine.api_key_hash);
    if (!valid) {
      return res.status(403).json({ error: "Key mismatch" });
    }

    const bodyString = JSON.stringify(req.body || {});
    const expectedSignature = crypto
      .createHmac("sha256", apiKey)
      .update(machineId + timestamp + bodyString)
      .digest("hex");

    if (expectedSignature !== signature) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    req.machine = machine;
    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    res.status(500).json({ error: "Auth failed" });
  }
}

/* =========================================================
   HEALTH CHECK
========================================================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* =========================================================
   MACHINE STATUS
========================================================= */
app.get("/api/machines/:machineId/status", async (req, res) => {
  const { machineId } = req.params;

  // ── Step 1: fetch machine row ──────────────────────────
  let machine = null;
  try {
    const [rows] = await db.query(
      `SELECT machine_id, is_print_locked, last_seen
       FROM machines WHERE machine_id=?`,
      [machineId]
    );
    machine = rows && rows.length ? rows[0] : null;
  } catch (err) {
    console.error("❌ STATUS — machines query failed:", err.message);
    return res.status(500).json({ error: "DB error fetching machine" });
  }

  if (!machine) {
    return res.status(404).json({ error: "Machine not found" });
  }

  // ── Step 2: fetch latest heartbeat (table may not exist yet — safe fallback) ──
  let isOnline   = false;
  let paperLevel = null;

  try {
    const [hbRows] = await db.query(
      `SELECT paper_level, created_at
       FROM machine_heartbeat_logs
       WHERE machine_id=?
       ORDER BY created_at DESC
       LIMIT 1`,
      [machineId]
    );

    if (hbRows && hbRows.length > 0) {
      const lastPing = new Date(hbRows[0].created_at);
      if (!isNaN(lastPing.getTime())) {
        isOnline = (Date.now() - lastPing.getTime()) / 1000 < 120;
      }
      paperLevel = hbRows[0].paper_level ?? null;
    }
  } catch (err) {
    // ✅ Heartbeat table missing or query failed — not fatal, just means offline
    // This is the most common cause of 502 on a fresh deployment
    console.warn("⚠️ STATUS — heartbeat query failed (table may not exist yet):", err.message);
    isOnline   = false;
    paperLevel = null;
  }

  // ── Step 3: always respond — never let Railway see an unhandled rejection ──
  return res.json({
    machine_id:      machine.machine_id,
    is_online:       isOnline,
    paper_level:     paperLevel,
    is_print_locked: machine.is_print_locked,
  });
});

/* =========================================================
   HEARTBEAT
========================================================= */
app.post("/api/kiosk/heartbeat", verifyMachine, async (req, res) => {
  try {
    const machineId = req.machine.machine_id;
    const { cpu_usage, paper_level, ink_level, status } = req.body;

    await db.query(
      `INSERT INTO machine_heartbeat_logs
       (machine_id, cpu_usage, paper_level, ink_level, status)
       VALUES (?, ?, ?, ?, ?)`,
      [machineId, cpu_usage || null, paper_level || null, ink_level || null, status || "ONLINE"]
    );

    await db.query(
      `UPDATE machines SET last_seen=NOW(), last_ip=? WHERE machine_id=?`,
      [req.ip, machineId]
    );

    const [[machine]] = await db.query(
      `SELECT paper_threshold, critical_paper_threshold, is_print_locked
       FROM machines WHERE machine_id=?`,
      [machineId]
    );

    const lowThreshold      = machine.paper_threshold          || 10;
    const criticalThreshold = machine.critical_paper_threshold || 5;

    if (paper_level !== undefined) {
      if (paper_level <= criticalThreshold) {
        await db.query(
          `UPDATE machines SET is_print_locked=TRUE WHERE machine_id=?`,
          [machineId]
        );
      }

      if (paper_level <= lowThreshold) {
        const [[existing]] = await db.query(
          `SELECT id FROM machine_alerts
           WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
          [machineId]
        );

        if (!existing) {
          await db.query(
            `INSERT INTO machine_alerts (machine_id, alert_type, message)
             VALUES (?, 'LOW_PAPER', ?)`,
            [machineId, `Paper level is ${paper_level}%`]
          );
          console.log("LOW PAPER ALERT CREATED");
        }
      } else {
        await db.query(
          `UPDATE machine_alerts
           SET is_resolved=TRUE, resolved_at=NOW()
           WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
          [machineId]
        );
      }
    }

    await logAudit(machineId, null, "HEARTBEAT");

    const io = getIO();
    io.emit("machine_update", { machineId, paper_level, status });

    res.json({ status: "alive" });
  } catch (err) {
    console.error("HEARTBEAT ERROR:", err);
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

/* =========================================================
   1️⃣  UPLOAD JOB
========================================================= */
app.post("/api/upload-job", upload.single("pdf"), async (req, res) => {
  try {
    const { machineId, color, copies, paperSize, printSide } = req.body;

    const pdf   = await pdfParse(fs.readFileSync(req.file.path));
    const jobId = "JOB_" + Date.now();

    await db.query(
      `INSERT INTO print_jobs
       (job_id, machine_id, file_name, file_path, color, copies,
        paper_size, print_side, total_pages, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')`,
      [jobId, machineId, req.file.originalname, req.file.path,
       color, copies, paperSize, printSide, pdf.numpages]
    );

    const io = getIO();
    io.emit("job_created", { jobId, machineId, pages: pdf.numpages });

    res.json({ jobId });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* =========================================================
   2️⃣  JOB SUMMARY (PRICE PREVIEW)
========================================================= */
app.get("/api/job-summary/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const [[job]] = await db.query(
      `SELECT * FROM print_jobs WHERE job_id=?`, [jobId]
    );

    if (!job) return res.status(404).json({ error: "Job not found" });

    const price = calculatePrice(job);
    res.json({
      pages:       job.total_pages,
      totalPages:  job.total_pages,
      copies:      job.copies,
      printSide:   job.print_side,
      color:       job.color,
      units:       price.units,
      rate:        price.rate,
      totalAmount: price.total,
    });
  } catch (err) {
    console.error("JOB SUMMARY ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* =========================================================
   UPDATE JOB (RESET PAYMENT)
========================================================= */
app.patch("/api/job/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const { color, copies, paperSize, printSide } = req.body;

    const [r] = await db.query(
      `UPDATE print_jobs
       SET color=?, copies=?, paper_size=?, print_side=?,
           amount=NULL, payment_order_id=NULL, status='CREATED'
       WHERE job_id=? AND status IN ('CREATED','PAYING')`,
      [color, copies, paperSize, printSide, jobId]
    );

    if (!r.affectedRows)
      return res.status(409).json({ error: "Job locked" });

    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE JOB ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* =========================================================
   3️⃣  CREATE PAYMENT
========================================================= */
app.post("/api/create-payment", async (req, res) => {
  // ✅ Guard: return 503 if Razorpay is not configured
  if (!razorpay) {
    return res.status(503).json({ error: "Payment service unavailable — Razorpay keys missing" });
  }

  try {
    const { jobId } = req.body;

    const [[job]] = await db.query(
      `SELECT * FROM print_jobs WHERE job_id=? AND status='CREATED'`, [jobId]
    );

    if (!job)
      return res.status(409).json({ error: "Finish or cancel current payment" });

    const [[machine]] = await db.query(
      `SELECT is_print_locked FROM machines WHERE machine_id=?`, [job.machine_id]
    );

    if (machine.is_print_locked) {
      return res.status(400).json({ error: "Machine out of paper. Payment disabled." });
    }

    const price  = calculatePrice(job);
    const amount = Math.round(price.paise);

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt:  jobId + "_" + Date.now(),
    });

    await db.query(
      `UPDATE print_jobs SET amount=?, payment_order_id=?, status='PAYING' WHERE job_id=?`,
      [price.total, order.id, jobId]
    );

    res.json({ key: process.env.RAZORPAY_KEY_ID, amount, orderId: order.id });
  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment creation failed" });
  }
});

/* =========================================================
   4️⃣  VERIFY PAYMENT
========================================================= */
app.post("/api/verify-payment", async (req, res) => {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.query(
      `SELECT * FROM print_jobs WHERE payment_order_id=? FOR UPDATE`,
      [razorpay_order_id]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: "Job not found" });
    }

    const job = rows[0];

    if (job.status !== "PAYING") {
      await connection.rollback();
      return res.status(409).json({ error: "Payment already processed or invalid state" });
    }

    const otp    = generateOTP();
    const qr     = generateQrToken();
    const expiry = new Date(Date.now() + 5 * 60 * 1000);

    await connection.query(
      `UPDATE print_jobs
       SET status='PAID', payment_id=?, otp=?, otp_expires_at=?,
           qr_token=?, qr_expires_at=?, otp_verified=0
       WHERE id=?`,
      [razorpay_payment_id, otp, expiry, qr, expiry, job.id]
    );

    const io = getIO();
    io.emit("payment_success", {
      jobId:     job.job_id,
      machineId: job.machine_id,
      filePath:  job.file_path,
    });

    await connection.commit();
    res.json({ success: true, otp, qrToken: qr });
  } catch (err) {
    if (transactionStarted) await connection.rollback();
    console.error("VERIFY PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment verification failed" });
  } finally {
    connection.release();
  }
});

/* =========================================================
   5️⃣  KIOSK UNLOCK (OTP OR QR)
========================================================= */
app.post("/api/kiosk/unlock", verifyMachine, async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { otp, qrToken } = req.body;
    const machineId = req.machine.machine_id;

    if (!machineId)
      return res.status(400).json({ error: "Machine ID required" });

    const [[machine]] = await db.query(
      `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`, [machineId]
    );

    if (!machine)
      return res.status(403).json({ error: "Invalid machine" });

    await connection.beginTransaction();
    const now = new Date();

    const [rows] = await connection.query(
      `SELECT * FROM print_jobs
       WHERE machine_id=?
         AND status='PAID'
         AND otp_verified=0
         AND (
           (otp IS NOT NULL AND otp=? AND otp_expires_at>?)
           OR
           (qr_token IS NOT NULL AND qr_token=? AND qr_expires_at>?)
         )
       FOR UPDATE`,
      [machineId, otp || null, now, qrToken || null, now]
    );

    if (!rows.length) {
      await connection.rollback();
      await logAudit(machineId, null, "UNLOCK_FAILED", { otp, qrToken });
      return res.status(401).json({ error: "Invalid or expired OTP / QR" });
    }

    const job = rows[0];

    await connection.query(
      `UPDATE print_jobs SET status='PRINTING', otp_verified=1 WHERE id=?`,
      [job.id]
    );

    await connection.commit();
    await logAudit(machineId, job.job_id, "JOB_UNLOCKED");

    return res.json({
      jobId:     job.job_id,
      filePath:  job.file_path,
      copies:    job.copies,
      color:     job.color,
      paperSize: job.paper_size,
      printSide: job.print_side,
    });
  } catch (err) {
    await connection.rollback();
    console.error("KIOSK UNLOCK ERROR:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

/* =========================================================
   MARK PRINTED
========================================================= */
app.post("/api/kiosk/mark-printed", verifyMachine, async (req, res) => {
  try {
    const { jobId }  = req.body;
    const machineId  = req.machine.machine_id;

    if (!jobId) return res.status(400).json({ error: "Job ID required" });

    const [[job]] = await db.query(
      `SELECT file_path, status FROM print_jobs WHERE job_id=?`, [jobId]
    );

    if (!job)
      return res.status(404).json({ error: "Job not found" });
    if (job.status !== "PRINTING")
      return res.status(400).json({ error: "Invalid job state" });

    const [result] = await db.query(
      `UPDATE print_jobs SET status='PRINTED', printed_at=NOW()
       WHERE job_id=? AND status='PRINTING'`,
      [jobId]
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ error: "State transition failed" });

    await logAudit(machineId, jobId, "JOB_PRINTED");

    if (job.file_path && fs.existsSync(job.file_path)) {
      try {
        fs.unlinkSync(job.file_path);
        console.log("File deleted:", job.file_path);
      } catch (err) {
        console.error("FILE DELETE ERROR:", err.message);
      }
    }

    const io = getIO();
    io.emit("job_printed", { jobId });

    res.json({ success: true });
  } catch (err) {
    console.error("MARK PRINTED ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* =========================================================
   MARK FAILED (with auto Razorpay refund)
========================================================= */
app.post("/api/kiosk/mark-failed", verifyMachine, async (req, res) => {
  try {
    const { jobId }  = req.body;
    const machineId  = req.machine.machine_id;

    const [[job]] = await db.query(
      `SELECT payment_id, amount FROM print_jobs
       WHERE job_id=? AND status='PRINTING'`,
      [jobId]
    );

    if (!job) return res.status(400).json({ error: "Invalid state" });

    const [result] = await db.query(
      `UPDATE print_jobs SET status='FAILED'
       WHERE job_id=? AND status='PRINTING'`,
      [jobId]
    );

    if (!result.affectedRows)
      return res.status(400).json({ error: "Invalid state transition" });

    // Trigger Razorpay refund automatically (only if Razorpay is available)
    if (razorpay && job.payment_id) {
      try {
        await razorpay.payments.refund(job.payment_id, {
          amount: Math.round(job.amount * 100),
        });
        console.log("Refund triggered for", jobId);
      } catch (refundErr) {
        console.error("REFUND ERROR:", refundErr.message);
      }
    }

    await logAudit(machineId, jobId, "JOB_FAILED");
    res.json({ success: true });
  } catch (err) {
    console.error("MARK FAILED ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* =========================================================
   JOB STATUS
========================================================= */
app.get("/api/job-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const [[job]] = await db.query(
      `SELECT status FROM print_jobs WHERE job_id=?`, [jobId]
    );

    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ status: job.status });
  } catch (err) {
    console.error("JOB STATUS ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* =========================================================
   PENDING JOBS
========================================================= */
app.get("/api/kiosk/pending-jobs", verifyMachine, async (req, res) => {
  try {
    const machineId = req.machine.machine_id;
    const [jobs] = await db.query(
      `SELECT job_id, file_path
       FROM print_jobs
       WHERE machine_id=? AND status='PAID' AND otp_verified=0 AND otp_expires_at>NOW()`,
      [machineId]
    );
    res.json({ jobs });
  } catch (err) {
    console.error("PENDING JOBS ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* =========================================================
   REGISTER MACHINE
========================================================= */
app.post("/api/register-machine", async (req, res) => {
  try {
    const { deviceSerial } = req.body;

    if (!deviceSerial) {
      return res.status(400).json({ error: "Device serial required" });
    }

    const [[existing]] = await db.query(
      `SELECT * FROM machines WHERE device_serial=?`, [deviceSerial]
    );

    if (existing) {
      const apiKey = crypto.randomBytes(32).toString("hex");
      const hash   = await bcrypt.hash(apiKey, 10);

      await db.query(
        `UPDATE machines SET api_key_hash=? WHERE machine_id=?`,
        [hash, existing.machine_id]
      );

      return res.json({
        MACHINE_ID: existing.machine_id,
        API_KEY:    apiKey,
        API_BASE:   SERVER_API_BASE,
      });
    }

    const [[machine]] = await db.query(
      `SELECT * FROM machines WHERE assigned=FALSE AND status='PENDING' LIMIT 1`
    );

    if (!machine) {
      return res.status(400).json({
        error: "No available machines. Create from admin panel first.",
      });
    }

    const apiKey = crypto.randomBytes(32).toString("hex");
    const hash   = await bcrypt.hash(apiKey, 10);

    await db.query(
      `UPDATE machines
       SET assigned=TRUE, status='ACTIVE', device_serial=?, api_key_hash=?, last_seen=NOW()
       WHERE machine_id=?`,
      [deviceSerial, hash, machine.machine_id]
    );

    res.json({
      MACHINE_ID: machine.machine_id,
      API_KEY:    apiKey,
      API_BASE:   SERVER_API_BASE,
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

/* =========================================================
   CLEANUP CRON — every 5 minutes
========================================================= */
cron.schedule("*/5 * * * *", async () => {
  try {
    await db.query(`
      DELETE FROM print_jobs
      WHERE status='CREATED' AND created_at < NOW() - INTERVAL 30 MINUTE
    `);
    await db.query(`
      UPDATE print_jobs SET status='EXPIRED'
      WHERE status='PAID' AND otp_expires_at < NOW()
    `);
    await db.query(`
      DELETE FROM print_jobs
      WHERE status='PRINTED' AND created_at < NOW() - INTERVAL 1 DAY
    `);
  } catch (err) {
    console.error("CLEANUP ERROR:", err.message);
  }
});

/* ---------------- START ---------------- */
const http = require("http");

const server = http.createServer(app);

// ✅ Socket.io initialized — was commented out before, causing getIO() to crash
initSocket(server);

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ API_BASE: ${SERVER_API_BASE}`);
});


// require("dotenv").config({ path: "./payment.env" });

// const express  = require("express");
// const multer   = require("multer");
// const db       = require("./database/db");
// const cors     = require("cors");
// const fs       = require("fs");
// const path     = require("path");
// const pdfParse = require("pdf-parse");
// const crypto   = require("crypto");
// const Razorpay = require("razorpay");
// const cron     = require("node-cron");
// const bcrypt   = require("bcrypt");
// const { getIO }      = require("./server/socket");
// const adminRoutes    = require("./routes/admin.routes");

// const app = express();

// /* ---------------- CONFIG ---------------- */
// const razorpay = new Razorpay({
//   key_id:     process.env.RAZORPAY_KEY_ID,
//   key_secret: process.env.RAZORPAY_KEY_SECRET,
// });

// /* ---------------- MIDDLEWARE ---------------- */
// // app.use(cors({
// //   origin: process.env.FRONTEND_URL || 'http://192.168.0.104:5000/api',
// //   methods: ['GET', 'POST', 'PATCH'],
// //   allowedHeaders: ['Content-Type'],
// // }));
// app.use(cors({
//   // origin: "*",
//   origin: [
//     "https://print-kappa-sepia.vercel.app",
//     "https://print-qov1z4o8v-bhu3203298s007-9747s-projects.vercel.app"
//   ],
//   methods: ['GET', 'POST', 'PATCH'],
//   allowedHeaders: [
//     'Content-Type',
//     'x-machine-id',
//     'x-timestamp',
//     'x-signature',
//     'x-api-key'
//   ],
// }));
// // app.use(cors({
// //   origin: process.env.FRONTEND_URL || '*',   // set FRONTEND_URL in Railway env vars
// //   methods: ['GET', 'POST', 'PATCH'],
// //   allowedHeaders: ['Content-Type', 'x-machine-id', 'x-timestamp', 'x-signature', 'x-api-key'],
// // }));
// app.use(express.json());
// // Add this line after app.use(express.json())
// app.use("/uploads", express.static(path.join(__dirname, "uploads")));
// app.use("/api/admin", adminRoutes);

// /* ---------------- UPLOAD ---------------- */
// const uploadDir = path.join(__dirname, "uploads");
// if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// // const upload = multer({
// //   dest: uploadDir,
// //   fileFilter: (_, file, cb) =>
// //     file.mimetype === "application/pdf"
// //       ? cb(null, true)
// //       : cb(new Error("Only PDF allowed")),
// // });
// // REPLACE your current multer config with this:
// const storage = multer.diskStorage({
//   destination: (req, file, cb) => cb(null, uploadDir),
//   filename: (req, file, cb) => {
//     const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
//     cb(null, unique + ".pdf");
//   }
// });

// const upload = multer({
//   storage,
//   fileFilter: (_, file, cb) =>
//     file.mimetype === "application/pdf"
//       ? cb(null, true)
//       : cb(new Error("Only PDF allowed")),
// });

// /* ---------------- HELPERS ---------------- */
// const generateOTP = () =>
//   Math.floor(1000 + Math.random() * 9000).toString();

// const generateQrToken = () =>
//   crypto.randomBytes(32).toString("hex");

// function calculatePrice(job) {
//   let rate;
//   if (job.color === "bw") {
//     rate = job.print_side === "duplex" ? 4 : 2;
//   } else {
//     rate = job.print_side === "duplex" ? 10 : 5;
//   }

//   const units =
//     job.print_side === "duplex"
//       ? Math.ceil(job.total_pages / 2) * job.copies
//       : job.total_pages * job.copies;

//   return {
//     units,
//     rate,
//     total:  units * rate,
//     paise:  units * rate * 100,
//   };
// }

// /* ---------------- AUDIT LOGGER ---------------- */
// async function logAudit(machineId, jobId, action, details = null) {
//   try {
//     await db.query(
//       `INSERT INTO audit_logs (machine_id, job_id, action, details)
//        VALUES (?, ?, ?, ?)`,
//       [machineId, jobId, action, JSON.stringify(details)]
//     );
//   } catch (err) {
//     console.error("AUDIT LOG ERROR:", err.message);
//   }
// }

// /* ---------------- MACHINE AUTH ---------------- */
// async function verifyMachine(req, res, next) {
//   try {
//     const machineId = req.headers["x-machine-id"];
//     const timestamp = req.headers["x-timestamp"];
//     const signature = req.headers["x-signature"];
//     const apiKey    = req.headers["x-api-key"];

//     if (!machineId || !timestamp || !signature || !apiKey) {
//       return res.status(401).json({ error: "Missing auth headers" });
//     }

//     const requestTime = parseInt(timestamp);
//     const now = Date.now();

//     if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
//       return res.status(401).json({ error: "Request expired" });
//     }

//     const [[machine]] = await db.query(
//       `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`,
//       [machineId]
//     );

//     if (!machine) {
//       return res.status(403).json({ error: "Invalid machine" });
//     }

//     const valid = await bcrypt.compare(apiKey, machine.api_key_hash);
//     if (!valid) {
//       return res.status(403).json({ error: "Key mismatch" });
//     }

//     const bodyString = JSON.stringify(req.body || {});
//     const expectedSignature = crypto
//       .createHmac("sha256", apiKey)
//       .update(machineId + timestamp + bodyString)
//       .digest("hex");

//     if (expectedSignature !== signature) {
//       return res.status(403).json({ error: "Invalid signature" });
//     }

//     req.machine = machine;
//     next();
//   } catch (err) {
//     console.error("AUTH ERROR:", err);
//     res.status(500).json({ error: "Auth failed" });
//   }
// }

// /* ================= MACHINE STATUS API ================= */
// app.get("/api/machines/:machineId/status", async (req, res) => {
//   try {
//     const { machineId } = req.params;

//     const [[machine]] = await db.query(
//       `SELECT machine_id, is_print_locked, last_seen
//        FROM machines WHERE machine_id=?`,
//       [machineId]
//     );

//     if (!machine) {
//       return res.status(404).json({ error: "Machine not found" });
//     }

//     const [heartbeat] = await db.query(
//       `SELECT paper_level, created_at
//        FROM machine_heartbeat_logs
//        WHERE machine_id=?
//        ORDER BY created_at DESC
//        LIMIT 1`,
//       [machineId]
//     );

//     let isOnline   = false;
//     let paperLevel = null;

//     if (heartbeat.length > 0) {
//       const lastPing = new Date(heartbeat[0].created_at);
//       const diff = (Date.now() - lastPing.getTime()) / 1000;
//       isOnline   = diff < 120;
//       paperLevel = heartbeat[0].paper_level;
//     }

//     res.json({
//       machine_id:      machine.machine_id,
//       is_online:       isOnline,
//       paper_level:     paperLevel,
//       is_print_locked: machine.is_print_locked,
//     });

//   } catch (err) {
//     console.error("MACHINE STATUS ERROR:", err);
//     res.status(500).json({ error: "Internal error" });
//   }
// });

// /* =========================================================
//    HEARTBEAT
// ========================================================= */
// app.post("/api/kiosk/heartbeat", verifyMachine, async (req, res) => {
//   try {
//     const machineId = req.machine.machine_id;
//     const { cpu_usage, paper_level, ink_level, status } = req.body;

//     await db.query(
//       `INSERT INTO machine_heartbeat_logs
//        (machine_id, cpu_usage, paper_level, ink_level, status)
//        VALUES (?, ?, ?, ?, ?)`,
//       [machineId, cpu_usage || null, paper_level || null, ink_level || null, status || "ONLINE"]
//     );

//     await db.query(
//       `UPDATE machines SET last_seen=NOW(), last_ip=? WHERE machine_id=?`,
//       [req.ip, machineId]
//     );

//     const [[machine]] = await db.query(
//       `SELECT paper_threshold, critical_paper_threshold, is_print_locked
//        FROM machines WHERE machine_id=?`,
//       [machineId]
//     );

//     const lowThreshold      = machine.paper_threshold          || 10;
//     const criticalThreshold = machine.critical_paper_threshold || 5;

//     if (paper_level !== undefined) {
//       // AUTO LOCK IF CRITICAL
//       if (paper_level <= criticalThreshold) {
//         await db.query(
//           `UPDATE machines SET is_print_locked=TRUE WHERE machine_id=?`,
//           [machineId]
//         );
//       }

//       if (paper_level <= lowThreshold) {
//         const [[existing]] = await db.query(
//           `SELECT id FROM machine_alerts
//            WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
//           [machineId]
//         );

//         if (!existing) {
//           await db.query(
//             `INSERT INTO machine_alerts (machine_id, alert_type, message)
//              VALUES (?, 'LOW_PAPER', ?)`,
//             [machineId, `Paper level is ${paper_level}%`]
//           );
//           console.log("LOW PAPER ALERT CREATED");
//         }
//       } else {
//         // Auto resolve if paper refilled
//         await db.query(
//           `UPDATE machine_alerts
//            SET is_resolved=TRUE, resolved_at=NOW()
//            WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
//           [machineId]
//         );
//       }
//     }

//     await logAudit(machineId, null, "HEARTBEAT");

//     const io = getIO();
//     io.emit("machine_update", { machineId, paper_level, status });

//     res.json({ status: "alive" });
//   } catch (err) {
//     console.error("HEARTBEAT ERROR:", err);
//     res.status(500).json({ error: "Heartbeat failed" });
//   }
// });

// /* =========================================================
//    1️⃣  UPLOAD JOB
// ========================================================= */
// app.post("/api/upload-job", upload.single("pdf"), async (req, res) => {
//   try {
//     const { machineId, color, copies, paperSize, printSide } = req.body;

//     const pdf   = await pdfParse(fs.readFileSync(req.file.path));
//     const jobId = "JOB_" + Date.now();

//     await db.query(
//       `INSERT INTO print_jobs
//        (job_id, machine_id, file_name, file_path, color, copies,
//         paper_size, print_side, total_pages, status)
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')`,
//       [jobId, machineId, req.file.originalname, req.file.path,
//        color, copies, paperSize, printSide, pdf.numpages]
//     );

//     const io = getIO();
//     io.emit("job_created", { jobId, machineId, pages: pdf.numpages });

//     res.json({ jobId });
//   } catch (err) {
//     console.error("UPLOAD ERROR:", err);
//     res.status(500).json({ error: "Upload failed" });
//   }
// });

// /* =========================================================
//    2️⃣  JOB SUMMARY (PRICE PREVIEW)
// ========================================================= */
// app.get("/api/job-summary/:jobId", async (req, res) => {
//   try {
//     const { jobId } = req.params;
//     const [[job]] = await db.query(
//       `SELECT * FROM print_jobs WHERE job_id=?`, [jobId]
//     );

//     if (!job) return res.status(404).json({ error: "Job not found" });

//     const price = calculatePrice(job);
//     res.json({
//       pages:       job.total_pages,
//       totalPages:  job.total_pages,
//       copies:      job.copies,
//       printSide:   job.print_side,
//       color:       job.color,
//       units:       price.units,
//       rate:        price.rate,
//       totalAmount: price.total,
//     });
//   } catch (err) {
//     console.error("JOB SUMMARY ERROR:", err);
//     res.status(500).json({ error: "Internal error" });
//   }
// });

// /* =========================================================
//    UPDATE JOB (RESET PAYMENT)
// ========================================================= */
// app.patch("/api/job/:jobId", async (req, res) => {
//   try {
//     const { jobId } = req.params;
//     const { color, copies, paperSize, printSide } = req.body;

//     const [r] = await db.query(
//       `UPDATE print_jobs
//        SET color=?, copies=?, paper_size=?, print_side=?,
//            amount=NULL, payment_order_id=NULL, status='CREATED'
//        WHERE job_id=? AND status IN ('CREATED','PAYING')`,
//       [color, copies, paperSize, printSide, jobId]
//     );

//     if (!r.affectedRows)
//       return res.status(409).json({ error: "Job locked" });

//     res.json({ success: true });
//   } catch (err) {
//     console.error("UPDATE JOB ERROR:", err);
//     res.status(500).json({ error: "Internal error" });
//   }
// });

// /* =========================================================
//    3️⃣  CREATE PAYMENT
// ========================================================= */
// app.post("/api/create-payment", async (req, res) => {
//   try {
//     const { jobId } = req.body;

//     const [[job]] = await db.query(
//       `SELECT * FROM print_jobs WHERE job_id=? AND status='CREATED'`, [jobId]
//     );

//     if (!job)
//       return res.status(409).json({ error: "Finish or cancel current payment" });

//     const [[machine]] = await db.query(
//       `SELECT is_print_locked FROM machines WHERE machine_id=?`, [job.machine_id]
//     );

//     if (machine.is_print_locked) {
//       return res.status(400).json({ error: "Machine out of paper. Payment disabled." });
//     }

//     const price  = calculatePrice(job);
//     const amount = Math.round(price.paise);

//     const order = await razorpay.orders.create({
//       amount,
//       currency: "INR",
//       receipt:  jobId + "_" + Date.now(),
//     });

//     await db.query(
//       `UPDATE print_jobs SET amount=?, payment_order_id=?, status='PAYING' WHERE job_id=?`,
//       [price.total, order.id, jobId]
//     );

//     res.json({ key: process.env.RAZORPAY_KEY_ID, amount, orderId: order.id });
//   } catch (err) {
//     console.error("CREATE PAYMENT ERROR:", err);
//     res.status(500).json({ error: "Payment creation failed" });
//   }
// });

// /* =========================================================
//    4️⃣  VERIFY PAYMENT
// ========================================================= */
// app.post("/api/verify-payment", async (req, res) => {
//   const connection = await db.getConnection();
//   let transactionStarted = false;

//   try {
//     const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

//     if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
//       return res.status(400).json({ error: "Missing payment fields" });
//     }

//     const expectedSignature = crypto
//       .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
//       .update(`${razorpay_order_id}|${razorpay_payment_id}`)
//       .digest("hex");

//     if (expectedSignature !== razorpay_signature) {
//       return res.status(400).json({ error: "Invalid signature" });
//     }

//     await connection.beginTransaction();
//     transactionStarted = true;

//     const [rows] = await connection.query(
//       `SELECT * FROM print_jobs WHERE payment_order_id=? FOR UPDATE`,
//       [razorpay_order_id]
//     );

//     if (rows.length === 0) {
//       await connection.rollback();
//       return res.status(400).json({ error: "Job not found" });
//     }

//     const job = rows[0];

//     if (job.status !== "PAYING") {
//       await connection.rollback();
//       return res.status(409).json({ error: "Payment already processed or invalid state" });
//     }

//     const otp    = generateOTP();
//     const qr     = generateQrToken();
//     const expiry = new Date(Date.now() + 5 * 60 * 1000);

//     await connection.query(
//       `UPDATE print_jobs
//        SET status='PAID', payment_id=?, otp=?, otp_expires_at=?,
//            qr_token=?, qr_expires_at=?, otp_verified=0
//        WHERE id=?`,
//       [razorpay_payment_id, otp, expiry, qr, expiry, job.id]
//     );

//     const io = getIO();
//     io.emit("payment_success", {
//       jobId:     job.job_id,
//       machineId: job.machine_id,
//       filePath:  job.file_path,
//     });

//     await connection.commit();
//     res.json({ success: true, otp, qrToken: qr });

//   } catch (err) {
//     if (transactionStarted) await connection.rollback();
//     console.error("VERIFY PAYMENT ERROR:", err);
//     res.status(500).json({ error: "Payment verification failed" });
//   } finally {
//     connection.release();
//   }
// });

// /* =========================================================
//    5️⃣  KIOSK UNLOCK (OTP OR QR)
// ========================================================= */
// app.post("/api/kiosk/unlock", verifyMachine, async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { otp, qrToken } = req.body;
//     const machineId = req.machine.machine_id;

//     if (!machineId)
//       return res.status(400).json({ error: "Machine ID required" });

//     const [[machine]] = await db.query(
//       `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`, [machineId]
//     );

//     if (!machine)
//       return res.status(403).json({ error: "Invalid machine" });

//     await connection.beginTransaction();
//     const now = new Date();

//     const [rows] = await connection.query(
//       `SELECT * FROM print_jobs
//        WHERE machine_id=?
//          AND status='PAID'
//          AND otp_verified=0
//          AND (
//            (otp IS NOT NULL AND otp=? AND otp_expires_at>?)
//            OR
//            (qr_token IS NOT NULL AND qr_token=? AND qr_expires_at>?)
//          )
//        FOR UPDATE`,
//       [machineId, otp || null, now, qrToken || null, now]
//     );

//     if (!rows.length) {
//       await connection.rollback();
//       await logAudit(machineId, null, "UNLOCK_FAILED", { otp, qrToken });
//       return res.status(401).json({ error: "Invalid or expired OTP / QR" });
//     }

//     const job = rows[0];

//     await connection.query(
//       `UPDATE print_jobs SET status='PRINTING', otp_verified=1 WHERE id=?`,
//       [job.id]
//     );

//     await connection.commit();
//     await logAudit(machineId, job.job_id, "JOB_UNLOCKED");

//     return res.json({
//       jobId:     job.job_id,
//       filePath:  job.file_path,
//       copies:    job.copies,
//       color:     job.color,
//       paperSize: job.paper_size,
//       printSide: job.print_side,
//     });

//   } catch (err) {
//     await connection.rollback();
//     console.error("KIOSK UNLOCK ERROR:", err);
//     return res.status(500).json({ error: "Internal server error" });
//   } finally {
//     connection.release();
//   }
// });

// /* =========================================================
//    MARK PRINTED
// ========================================================= */
// app.post("/api/kiosk/mark-printed", verifyMachine, async (req, res) => {
//   try {
//     const { jobId }    = req.body;
//     const machineId    = req.machine.machine_id;

//     if (!jobId) return res.status(400).json({ error: "Job ID required" });

//     const [[job]] = await db.query(
//       `SELECT file_path, status FROM print_jobs WHERE job_id=?`, [jobId]
//     );

//     if (!job)             return res.status(404).json({ error: "Job not found" });
//     if (job.status !== "PRINTING")
//       return res.status(400).json({ error: "Invalid job state" });

//     const [result] = await db.query(
//       `UPDATE print_jobs SET status='PRINTED', printed_at=NOW()
//        WHERE job_id=? AND status='PRINTING'`,
//       [jobId]
//     );

//     if (result.affectedRows === 0)
//       return res.status(404).json({ error: "State transition failed" });

//     await logAudit(machineId, jobId, "JOB_PRINTED");

//     if (job.file_path && fs.existsSync(job.file_path)) {
//       try { fs.unlinkSync(job.file_path); console.log("File deleted:", job.file_path); }
//       catch (err) { console.error("FILE DELETE ERROR:", err.message); }
//     }

//     const io = getIO();
//     io.emit("job_printed", { jobId });

//     res.json({ success: true });
//   } catch (err) {
//     console.error("MARK PRINTED ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

// /* =========================================================
//    MARK FAILED
// ========================================================= */
// // app.post("/api/kiosk/mark-failed", verifyMachine, async (req, res) => {
// //   try {
// //     const { jobId }  = req.body;
// //     const machineId  = req.machine.machine_id;

// //     const [result] = await db.query(
// //       `UPDATE print_jobs SET status='FAILED' WHERE job_id=? AND status='PRINTING'`,
// //       [jobId]
// //     );

// //     if (!result.affectedRows)
// //       return res.status(400).json({ error: "Invalid state transition" });

// //     await logAudit(machineId, jobId, "JOB_FAILED");
// //     res.json({ success: true });
// //   } catch (err) {
// //     console.error("MARK FAILED ERROR:", err);
// //     res.status(500).json({ error: "Internal server error" });
// //   }
// // });

// app.post("/api/kiosk/mark-failed", verifyMachine, async (req, res) => {
//   try {
//     const { jobId } = req.body;
//     const machineId = req.machine.machine_id;

//     // Get payment_id before updating status
//     const [[job]] = await db.query(
//       `SELECT payment_id, amount FROM print_jobs 
//        WHERE job_id=? AND status='PRINTING'`,
//       [jobId]
//     );

//     if (!job) return res.status(400).json({ error: "Invalid state" });

//     const [result] = await db.query(
//       `UPDATE print_jobs SET status='FAILED' 
//        WHERE job_id=? AND status='PRINTING'`,
//       [jobId]
//     );

//     if (!result.affectedRows)
//       return res.status(400).json({ error: "Invalid state transition" });

//     // Trigger Razorpay refund
//     if (job.payment_id) {
//       try {
//         await razorpay.payments.refund(job.payment_id, {
//           amount: Math.round(job.amount * 100), // paise
//         });
//         console.log("Refund triggered for", jobId);
//       } catch (refundErr) {
//         // Log but don't fail the request — job is already marked failed
//         console.error("REFUND ERROR:", refundErr.message);
//         // TODO: add to a manual_refunds table for follow-up
//       }
//     }

//     await logAudit(machineId, jobId, "JOB_FAILED");
//     res.json({ success: true });

//   } catch (err) {
//     console.error("MARK FAILED ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

// /* =========================================================
//    JOB STATUS
// ========================================================= */
// app.get("/api/job-status/:jobId", async (req, res) => {
//   try {
//     const { jobId } = req.params;
//     const [[job]] = await db.query(
//       `SELECT status FROM print_jobs WHERE job_id=?`, [jobId]
//     );

//     if (!job) return res.status(404).json({ error: "Job not found" });
//     res.json({ status: job.status });
//   } catch (err) {
//     console.error("JOB STATUS ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

// /* =========================================================
//    PENDING JOBS
// ========================================================= */
// app.get("/api/kiosk/pending-jobs", verifyMachine, async (req, res) => {
//   try {
//     const machineId = req.machine.machine_id;
//     const [jobs] = await db.query(
//       `SELECT job_id, file_path
//        FROM print_jobs
//        WHERE machine_id=? AND status='PAID' AND otp_verified=0 AND otp_expires_at>NOW()`,
//       [machineId]
//     );
//     res.json({ jobs });
//   } catch (err) {
//     console.error("PENDING JOBS ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

/* =========================================================
   REGISTER MACHINE
========================================================= */
// app.post("/api/register-machine", async (req, res) => {

//   try {
//     const { deviceSerial } = req.body;

//     if (!deviceSerial) {
//       return res.status(400).json({ error: "Device serial required" });
//     }

//     const [[existing]] = await db.query(
//       `SELECT * FROM machines WHERE device_serial=?`, [deviceSerial]
//     );

//     // ✅ Re-registration: rotate API key for existing machine
//     if (existing) {
//       const apiKey = crypto.randomBytes(32).toString("hex");
//       const hash   = await bcrypt.hash(apiKey, 10);

//       await db.query(
//         `UPDATE machines SET api_key_hash=? WHERE machine_id=?`,
//         [hash, existing.machine_id]
//       );

//       return res.json({
//         MACHINE_ID: existing.machine_id,   // ✅ fixed key name
//         API_KEY:    apiKey,
//         // API_BASE:   "http://192.168.0.106:5000/api",  // ✅ colon not equals  "http://localhost:5000/api"
//         API_BASE: process.env.API_BASE_URL || "http://192.168.0.104:5000/api"

//       });
//     }

//     // New machine — find an unassigned PENDING slot
//     const [[machine]] = await db.query(
//       `SELECT * FROM machines WHERE assigned=FALSE AND status='PENDING' LIMIT 1`
//     );

//     if (!machine) {
//       return res.status(400).json({
//         error: "No available machines. Create from admin panel first.",
//       });
//     }

//     const apiKey = crypto.randomBytes(32).toString("hex");
//     const hash   = await bcrypt.hash(apiKey, 10);

//     await db.query(
//       `UPDATE machines
//        SET assigned=TRUE, status='ACTIVE', device_serial=?, api_key_hash=?, last_seen=NOW()
//        WHERE machine_id=?`,
//       [deviceSerial, hash, machine.machine_id]
//     );

//     res.json({
//       MACHINE_ID: machine.machine_id,
//       API_KEY:    apiKey,
//       // API_BASE:   "http://192.168.0.106:5000/api",  // ✅ colon not equals   "http://localhost:5000/api"
//       API_BASE: process.env.API_BASE_URL ||"http://192.168.0.104:5000/api"
//     });

//   } catch (err) {
//     console.error("REGISTER ERROR:", err);
//     res.status(500).json({ error: "Registration failed" });
//   }
// });

// app.post("/api/register-machine", async (req, res) => {
//   try {
//     const { deviceSerial } = req.body;

//     if (!deviceSerial) {
//       return res.status(400).json({ error: "Device serial required" });
//     }

//     // ✅ ALWAYS use LAN IP — NEVER localhost
//     // const API_BASE = process.env.API_BASE_URL || "http://192.168.0.104:5000/api";
//     const API_BASE = process.env.API_BASE_URL

//     const [[existing]] = await db.query(
//       `SELECT * FROM machines WHERE device_serial=?`, [deviceSerial]
//     );

//     // ✅ Existing machine → rotate API key
//     if (existing) {
//       const apiKey = crypto.randomBytes(32).toString("hex");
//       const hash   = await bcrypt.hash(apiKey, 10);

//       await db.query(
//         `UPDATE machines SET api_key_hash=? WHERE machine_id=?`,
//         [hash, existing.machine_id]
//       );

//       return res.json({
//         MACHINE_ID: existing.machine_id,
//         API_KEY: apiKey,
//         API_BASE: API_BASE   // ✅ FIXED
//       });
//     }

//     // ✅ Assign new machine
//     const [[machine]] = await db.query(
//       `SELECT * FROM machines WHERE assigned=FALSE AND status='PENDING' LIMIT 1`
//     );

//     if (!machine) {
//       return res.status(400).json({
//         error: "No available machines. Create from admin panel first.",
//       });
//     }

//     const apiKey = crypto.randomBytes(32).toString("hex");
//     const hash   = await bcrypt.hash(apiKey, 10);

//     await db.query(
//       `UPDATE machines
//        SET assigned=TRUE, status='ACTIVE', device_serial=?, api_key_hash=?, last_seen=NOW()
//        WHERE machine_id=?`,
//       [deviceSerial, hash, machine.machine_id]
//     );

//     res.json({
//       MACHINE_ID: machine.machine_id,
//       API_KEY: apiKey,
//       API_BASE: API_BASE   // ✅ FIXED
//     });

//   } catch (err) {
//     console.error("REGISTER ERROR:", err);
//     res.status(500).json({ error: "Registration failed" });
//   }
// });
// /* =========================================================
//    CLEANUP CRON
// ========================================================= */
// cron.schedule("*/5 * * * *", async () => {
//   console.log("Running cleanup...");
//   try {
//     await db.query(`
//       DELETE FROM print_jobs
//       WHERE status='CREATED' AND created_at < NOW() - INTERVAL 30 MINUTE
//     `);
//     await db.query(`
//       UPDATE print_jobs SET status='EXPIRED'
//       WHERE status='PAID' AND otp_expires_at < NOW()
//     `);
//     await db.query(`
//       DELETE FROM print_jobs
//       WHERE status='PRINTED' AND created_at < NOW() - INTERVAL 1 DAY
//     `);
//   } catch (err) {
//     console.error("CLEANUP ERROR:", err);
//   }
// });

// /* ---------------- START ---------------- */
// const http = require("http");
// const { initSocket } = require("./server/socket");

// const server = http.createServer(app);
// initSocket(server);

// // server.listen(5000, "0.0.0.0", () => {    // ✅ bind to all interfaces
// //   console.log("Server running on 5000");
// // });
// const PORT = process.env.PORT || 5000;
// server.listen(PORT, "0.0.0.0", () => {
//   console.log(`Server running on ${PORT}`);
// });

//-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// require("dotenv").config({ path: "./payment.env" });

// const express = require("express");
// const multer = require("multer");
// //const mysql = require("mysql2/promise");
// const db= require("./database/db")
// const cors = require("cors");
// const fs = require("fs");
// const path = require("path");
// const pdfParse = require("pdf-parse");
// const crypto = require("crypto");
// const Razorpay = require("razorpay");
// const cron = require("node-cron");
// const bcrypt = require("bcrypt");
// const { getIO } = require("./server/socket");
// const adminRoutes = require("./routes/admin.routes");


// const app = express();

// /* ---------------- CONFIG ---------------- */
// const razorpay = new Razorpay({
//   key_id: process.env.RAZORPAY_KEY_ID,
//   key_secret: process.env.RAZORPAY_KEY_SECRET,
// });

// /* ---------------- MIDDLEWARE ---------------- */
// app.use(cors());
// app.use(express.json());
// app.use("/api/admin", adminRoutes);

// /* ---------------- MYSQL ---------------- */
// // const db = mysql.createPool({
// //   host: "localhost",
// //   user: "root",
// //   password: "root",
// //   database: "print_kiosk_network",
// // });

// /* ---------------- UPLOAD ---------------- */
// const uploadDir = path.join(__dirname, "uploads");
// if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// const upload = multer({
//   dest: uploadDir,
//   fileFilter: (_, file, cb) =>
//     file.mimetype === "application/pdf"
//       ? cb(null, true)
//       : cb(new Error("Only PDF allowed")),
// });

// /* ---------------- HELPERS ---------------- */
// const generateOTP = () =>
//   Math.floor(1000 + Math.random() * 9000).toString();

// const generateQrToken = () =>
//   crypto.randomBytes(32).toString("hex");

// function calculatePrice(job) {
//   let rate;

//   if (job.color === "bw") {
//     rate = job.print_side === "duplex" ? 4 : 2;
//   } else {
//     rate = job.print_side === "duplex" ? 10 : 5;
//   }

//   const units =
//     job.print_side === "duplex"
//       ? Math.ceil(job.total_pages / 2) * job.copies
//       : job.total_pages * job.copies;

//   return {
//     units,
//     rate,
//     total: units * rate,
//     paise: units * rate * 100,
//   };
// }

// /* ---------------- AUDIT LOGGER ---------------- */
// async function logAudit(machineId, jobId, action, details = null) {
//   try {
//     await db.query(
//       `INSERT INTO audit_logs (machine_id, job_id, action, details)
//        VALUES (?, ?, ?, ?)`,
//       [machineId, jobId, action, JSON.stringify(details)]
//     );
//   } catch (err) {
//     console.error("AUDIT LOG ERROR:", err.message);
//   }
// }

// /* ---------------- MACHINE AUTH ---------------- */
// async function verifyMachine(req, res, next) {
//   try {
//     const machineId = req.headers["x-machine-id"];
    
//     const timestamp = req.headers["x-timestamp"];
//     const signature = req.headers["x-signature"];

//     if (!machineId || !timestamp || !signature) {
//       return res.status(401).json({ error: "Missing auth headers" });
//     }

//     const requestTime = parseInt(timestamp);
//     const now = Date.now();

//     if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
//       return res.status(401).json({ error: "Request expired" });
//     }

//     const [[machine]] = await db.query(
//       `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`,
//       [machineId]
//     );

//     if (!machine) {
//       return res.status(403).json({ error: "Invalid machine" });
//     }

//     // 🔑 You must define this in .env
//    const apiKey = req.headers["x-api-key"];

// if (!apiKey) {
//   return res.status(401).json({ error: "Missing API key" });
// }

//     const valid = await bcrypt.compare(apiKey, machine.api_key_hash);
//     if (!valid) {
//       return res.status(403).json({ error: "Key mismatch" });
//     }

//     const bodyString = JSON.stringify(req.body || {});

//     const expectedSignature = crypto
//       .createHmac("sha256", apiKey)
//       .update(machineId + timestamp + bodyString)
//       .digest("hex");

//     if (expectedSignature !== signature) {
//       return res.status(403).json({ error: "Invalid signature" });
//     }

//     req.machine = machine;
//     next();
//   } catch (err) {
//     console.error("AUTH ERROR:", err);
//     res.status(500).json({ error: "Auth failed" });
//   }
// }
// /* ================= MACHINE STATUS API ================= */
// app.get("/api/machines/:machineId/status", async (req, res) => {
//   try {
//     const { machineId } = req.params;

//     const [[machine]] = await db.query(
//       `SELECT machine_id, is_print_locked, last_seen
//        FROM machines WHERE machine_id=?`,
//       [machineId]
//     );

//     if (!machine) {
//       return res.status(404).json({ error: "Machine not found" });
//     }

//     const [heartbeat] = await db.query(
//       `SELECT paper_level, created_at
//        FROM machine_heartbeat_logs
//        WHERE machine_id=?
//        ORDER BY created_at DESC
//        LIMIT 1`,
//       [machineId]
//     );

//     let isOnline = false;
//     let paperLevel = null;

//     if (heartbeat.length > 0) {
//       const lastPing = new Date(heartbeat[0].created_at);
//       const diff = (Date.now() - lastPing.getTime()) / 1000;
//       isOnline = diff < 120;
//       paperLevel = heartbeat[0].paper_level;
//     }

//     res.json({
//       machine_id: machine.machine_id,
//       is_online: isOnline,
//       paper_level: paperLevel,
//       is_print_locked: machine.is_print_locked,
//     });

//   } catch (err) {
//     res.status(500).json({ error: "Internal error" });
//   }
// });
// /* =========================================================
//    HEARTBEAT
// ========================================================= */
// app.post("/api/kiosk/heartbeat", verifyMachine, async (req, res) => {
//   try{
//   const machineId = req.machine.machine_id;
//   const { cpu_usage, paper_level, ink_level, status } = req.body;

//    await db.query(
//       `INSERT INTO machine_heartbeat_logs
//        (machine_id, cpu_usage, paper_level, ink_level, status)
//        VALUES (?, ?, ?, ?, ?)`,
//       [
//         machineId,
//         cpu_usage || null,
//         paper_level || null,
//         ink_level || null,
//         status || "ONLINE"
//       ]
//     );

//   await db.query(
//     `UPDATE machines SET last_seen=NOW(), last_ip=? WHERE machine_id=?`,
//     [req.ip, machineId]
//   );
//   const [[machine]] = await db.query(
//       `SELECT paper_threshold, critical_paper_threshold, is_print_locked 
//        FROM machines 
//        WHERE machine_id=?`,
//       [machineId]
//     );

//     const lowThreshold = machine.paper_threshold || 10;
//     const criticalThreshold = machine.critical_paper_threshold || 5;
//   // Check low paper
// if (paper_level !== undefined) {

//   const [[machine]] = await db.query(
//     `SELECT paper_threshold FROM machines WHERE machine_id=?`,
//     [machineId]
//   );

//   const threshold = machine.paper_threshold || 10;
//    await db.query(
//       `INSERT INTO machine_heartbeat_logs
//        (machine_id, paper_level)
//        VALUES (?, ?)`,
//       [machineId, paper_level]
//     );

//     // AUTO LOCK IF CRITICAL
//     if (paper_level <= criticalThreshold) {
//       await db.query(
//         `UPDATE machines SET is_print_locked=TRUE WHERE machine_id=?`,
//         [machineId]
//       );
//     }
//   if (paper_level <= lowThreshold) {

//     // Check if unresolved alert already exists
//     const [[existing]] = await db.query(
//       `SELECT id FROM machine_alerts
//        WHERE machine_id=? 
//        AND alert_type='LOW_PAPER'
//        AND is_resolved=FALSE`,
//       [machineId]
//     );

//     if (!existing) {
//       await db.query(
//         `INSERT INTO machine_alerts 
//          (machine_id, alert_type, message)
//          VALUES (?, 'LOW_PAPER', ?)`,
//         [
//           machineId,
//           `Paper level is ${paper_level}%`
//         ]
//       );

//       console.log("LOW PAPER ALERT CREATED");
//     }
//   }
// }
// // Auto resolve if paper refilled
// if (paper_level > lowThreshold) {
//   await db.query(
//     `UPDATE machine_alerts
//      SET is_resolved=TRUE,
//          resolved_at=NOW()
//      WHERE machine_id=?
//      AND alert_type='LOW_PAPER'
//      AND is_resolved=FALSE`,
//     [machineId]
//   );
// }

//   await logAudit(machineId, null, "HEARTBEAT");
//   const io = getIO();

// io.emit("machine_update", {
//   machineId,
//   paper_level,
//   status
// });

//   res.json({ status: "alive" });
// } catch(err){
//   console.error("HEARTBEAT ERROR:", err);
//     res.status(500).json({ error: "Heartbeat failed" });
// }
// });


// /* =========================================================
//    1️⃣ UPLOAD JOB
// ========================================================= */
// app.post("/api/upload-job", upload.single("pdf"), async (req, res) => {
//   const { machineId, color, copies, paperSize, printSide } = req.body;

//   const pdf = await pdfParse(fs.readFileSync(req.file.path));
//   const jobId = "JOB_" + Date.now();

//   await db.query(
//     `INSERT INTO print_jobs
//      (job_id, machine_id, file_name, file_path, color, copies,
//       paper_size, print_side, total_pages, status)
//      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')`,
//     [
//       jobId,
//       machineId,
//       req.file.originalname,
//       req.file.path,
//       color,
//       copies,
//       paperSize,
//       printSide,
//       pdf.numpages,
//     ]
//   );
// const io = getIO();

// io.emit("job_created", {
//   jobId,
//   machineId,
//   pages: pdf.numpages
// });

//   res.json({ jobId });
// });

// /* =========================================================
//    2️⃣ JOB SUMMARY (PRICE PREVIEW)
// ========================================================= */
// app.get("/api/job-summary/:jobId", async (req, res) => {
//   const { jobId } = req.params;

//   const [[job]] = await db.query(
//     `SELECT * FROM print_jobs WHERE job_id=?`,
//     [jobId]
//   );

//   if (!job) return res.status(404).json({ error: "Job not found" });

//   const price = calculatePrice(job);

//   res.json({
//     pages: job.total_pages,
//     totalPages: job.total_pages,
//     copies: job.copies,
//     printSide: job.print_side,
//     color: job.color,
//     units: price.units,
//     rate: price.rate,
//     totalAmount: price.total,
//   });
// });
// /* =========================================================
//    2️⃣ UPDATE JOB (RESET PAYMENT)
// ========================================================= */
// app.patch("/api/job/:jobId", async (req, res) => {
//   const { jobId } = req.params;
//   const { color, copies, paperSize, printSide } = req.body;

//   const [r] = await db.query(
//     `UPDATE print_jobs
//      SET color=?, copies=?, paper_size=?, print_side=?,
//          amount=NULL, payment_order_id=NULL, status='CREATED'
//      WHERE job_id=? AND status IN ('CREATED','PAYING')`,
//     [color, copies, paperSize, printSide, jobId]
//   );

//   if (!r.affectedRows)
//     return res.status(409).json({ error: "Job locked" });

//   res.json({ success: true });
// });

// /* =========================================================
//    3️⃣ CREATE PAYMENT
// ========================================================= */
// app.post("/api/create-payment", async (req, res) => {
//   const { jobId } = req.body;

//   const [[job]] = await db.query(
//     `SELECT * FROM print_jobs WHERE job_id=? AND status='CREATED'`,
//     [jobId]
//   );

//   if (!job)
//     return res.status(409).json({ error: "Finish or cancel current payment" });

//     // 🚫 BLOCK IF MACHINE LOCKED
//   const [[machine]] = await db.query(
//     `SELECT is_print_locked FROM machines WHERE machine_id=?`,
//     [job.machine_id]
//   );

//   if (machine.is_print_locked) {
//     return res.status(400).json({
//       error: "Machine out of paper. Payment disabled."
//     });
//   }
//   const price = calculatePrice(job);
//   const amount= Math.round(price.paise);

//   const order = await razorpay.orders.create({
//     amount,
//     currency: "INR",
//     receipt: jobId + "_" + Date.now(),
//   });

//   await db.query(
//     `UPDATE print_jobs
//      SET amount=?, payment_order_id=?, status='PAYING'
//      WHERE job_id=?`,
//     [price.total, order.id, jobId]
//   );

//   res.json({
//     key: process.env.RAZORPAY_KEY_ID,
//     amount,
//     orderId: order.id,
//   });
// });

// /* =========================================================
//    4️⃣ VERIFY PAYMENT (FINAL & FIXED)
// ========================================================= */

// app.post("/api/verify-payment", async (req, res) => {
//   const connection = await db.getConnection();
//   let transactionStarted = false;

//   try {
//     const {
//       razorpay_order_id,
//       razorpay_payment_id,
//       razorpay_signature,
//     } = req.body;

//     if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
//       return res.status(400).json({ error: "Missing payment fields" });
//     }

//     const expectedSignature = crypto
//       .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
//       .update(`${razorpay_order_id}|${razorpay_payment_id}`)
//       .digest("hex");

//     if (expectedSignature !== razorpay_signature) {
//       return res.status(400).json({ error: "Invalid signature" });
//     }

//     await connection.beginTransaction();
//     transactionStarted = true;

//     const [rows] = await connection.query(
//       `SELECT * FROM print_jobs
//        WHERE payment_order_id = ?
//        FOR UPDATE`,
//       [razorpay_order_id]
//     );

//     if (rows.length === 0) {
//       await connection.rollback();
//       return res.status(400).json({ error: "Job not found" });
//     }

//     const job = rows[0];

//     if (job.status !== "PAYING") {
//       await connection.rollback();
//       return res.status(409).json({
//         error: "Payment already processed or invalid state"
//       });
//     }

//     const otp = generateOTP();
//     const qr = generateQrToken();
//     const expiry = new Date(Date.now() + 5 * 60 * 1000);

//     await connection.query(
//       `UPDATE print_jobs
//        SET status = 'PAID',
//            payment_id = ?,
//            otp = ?,
//            otp_expires_at = ?,
//            qr_token = ?,
//            qr_expires_at = ?,
//            otp_verified = 0
//        WHERE id = ?`,
//       [razorpay_payment_id, otp, expiry, qr, expiry, job.id]
//     );

//     const io = getIO();

// io.emit("payment_success", {
//   jobId: job.job_id,
//   machineId: job.machine_id,   
//   filePath:  job.file_path,  
// });

//     await connection.commit();

//     res.json({ success: true, otp, qrToken: qr });

//   } catch (err) {
//     if (transactionStarted) {
//       await connection.rollback();
//     }
//     console.error("VERIFY PAYMENT ERROR:", err);
//     res.status(500).json({ error: "Payment verification failed" });
//   } finally {
//     connection.release();
//   }
// });


// /* =========================================================
//    5️⃣ KIOSK UNLOCK (OTP OR QR)
// ========================================================= */


// // app.post("/api/kiosk/unlock",verifyMachine, async (req, res) => {
// //   try {
// //     const { otp, qrToken } = req.body;
// //     const machineId=req.machine.machine_id;

// //     if (!machineId)
// //       return res.status(400).json({ error: "Machine ID required" });

// //     // 1️⃣ Check machine exists & active
// //     const [[machine]] = await db.query(
// //       `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`,
// //       [machineId]
// //     );

// //     if (!machine)
// //       return res.status(403).json({ error: "Invalid machine" });

    
// //     const now = new Date();

// //     // 2️⃣ LOCK JOB TO MACHINE
// //     const [result] = await db.query(
// //       `
// //       UPDATE print_jobs
// //       SET status='PRINTING',
// //           otp_verified=1
// //       WHERE machine_id=?
// //         AND status='PAID'
// //         AND otp_verified=0
// //         AND (
// //           (otp IS NOT NULL AND otp=? AND otp_expires_at>?)
// //           OR
// //           (qr_token IS NOT NULL AND qr_token=? AND qr_expires_at>?)
// //         )
// //       `,
// //       [machineId, otp || null, now, qrToken || null, now]
// //     );

// //      if (!result.affectedRows) {
// //       await logAudit(machineId, null, "UNLOCK_FAILED", { otp, qrToken });
// //       return res.status(401).json({ error: "Invalid or expired OTP / QR" });
// //     }

// //     const [[job]] = await db.query(
// //       `SELECT * FROM print_jobs
// //        WHERE machine_id=? AND status='PRINTING'
// //        ORDER BY id DESC LIMIT 1`,
// //       [machineId]
// //     );

// //      await logAudit(machineId, job.job_id, "JOB_UNLOCKED");

// //     res.json({
// //       jobId: job.job_id,
// //       filePath: job.file_path,
// //       copies: job.copies,
// //       color: job.color,
// //       paperSize: job.paper_size,
// //       printSide: job.print_side
// //     });

// //   } catch (err) {
// //     console.error("KIOSK UNLOCK ERROR:", err);
// //     res.status(500).json({ error: "Internal server error" });
// //   }
// // });
// app.post("/api/kiosk/unlock", verifyMachine, async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { otp, qrToken } = req.body;
//     const machineId = req.machine.machine_id;

//     if (!machineId)
//       return res.status(400).json({ error: "Machine ID required" });

//     const [[machine]] = await db.query(
//       `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`,
//       [machineId]
//     );

//     if (!machine)
//       return res.status(403).json({ error: "Invalid machine" });

//     await connection.beginTransaction();
//     const now = new Date();

//     const [rows] = await connection.query(
//       `
//       SELECT * FROM print_jobs
//       WHERE machine_id=?
//         AND status='PAID'
//         AND otp_verified=0
//         AND (
//           (otp IS NOT NULL AND otp=? AND otp_expires_at>?)
//           OR
//           (qr_token IS NOT NULL AND qr_token=? AND qr_expires_at>?)
//         )
//       FOR UPDATE
//       `,
//       [machineId, otp || null, now, qrToken || null, now]
//     );

//     // ✅ FIXED CONDITION
//     if (!rows.length) {
//       await connection.rollback();
//       return res.status(401).json({ error: "Invalid or expired OTP / QR" });
//     }

//     const job = rows[0];

//     await connection.query(
//       `
//       UPDATE print_jobs
//       SET status='PRINTING',
//           otp_verified=1
//       WHERE id=?
//       `,
//       [job.id]
//     );

//     await connection.commit();

//     return res.json({
//       jobId: job.job_id,
//       filePath: job.file_path,
//       copies: job.copies,
//       color: job.color,
//       paperSize: job.paper_size,
//       printSide: job.print_side,
//     });

//   } catch (err) {
//     await connection.rollback();
//     console.error("KIOSK UNLOCK ERROR:", err);
//     return res.status(500).json({ error: "Internal server error" });
//   } finally {
//     connection.release();
//   }
// });



// /* =========================================================
//    7️⃣ MARK PRINTED
// ========================================================= */
// app.post("/api/kiosk/mark-printed", verifyMachine,async (req, res) => {
//   try {
//     const { jobId } = req.body;
//     const machineId = req.machine.machine_id;
//     if (!jobId) {
//       return res.status(400).json({ error: "Job ID required" });
//     }

//     const [[job]] = await db.query(
//       `SELECT file_path, status 
//        FROM print_jobs 
//        WHERE job_id=?`,
//       [jobId]
//     );

//     if (!job) {
//       return res.status(404).json({ error: "Job not found" });
//     }

//     if (job.status !== "PRINTING") {
//       return res.status(400).json({ error: "Invalid job state" });
//     }

//     const [result] = await db.query(
//        `
//       UPDATE print_jobs
//       SET status='PRINTED',
//       printed_at=NOW()
//       WHERE job_id=? AND status='PRINTING'
//       `,
//       [jobId]
//     );

//     if (result.affectedRows === 0) {
//       return res.status(404).json({ error: "State transition failed"});
//     }
//     await logAudit(machineId, jobId, "JOB_PRINTED");
//   if (job.file_path && fs.existsSync(job.file_path)) {
//   try {
//     fs.unlinkSync(job.file_path);   // ✅ NO CALLBACK
//     console.log("File deleted:", job.file_path);
//   } catch (err) {
//     console.error("FILE DELETE ERROR:", err.message);
//   }
// }
// const io = getIO();

// io.emit("job_printed", {
//   jobId
// });      

//     res.json({ success: true });
//   } catch (err) {
//     console.error("MARK PRINTED ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

// /* =========================================================
//   MARK FAILED (Printer Error)
// ========================================================= */

// app.post("/api/kiosk/mark-failed",verifyMachine, async (req, res) => {
//   try {
//     const { jobId } = req.body;
//     const machineId = req.machine.machine_id;

//     const [result] = await db.query(
//       `
//       UPDATE print_jobs
//       SET status='FAILED'
//       WHERE job_id=? AND status='PRINTING'
//       `,
//       [jobId]
//     );

//     if (!result.affectedRows) {
//       return res.status(400).json({ error: "Invalid state transition" });
//     }
//     await logAudit(machineId, jobId, "JOB_FAILED");
//     res.json({ success: true });

//   } catch (err) {
//     console.error("MARK FAILED ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });
// /* =========================================================
//    8️⃣ GET JOB STATUS (FOR AUTO REDIRECT)
// ========================================================= */
// app.get("/api/job-status/:jobId", async (req, res) => {
//   try {
//     const { jobId } = req.params;

//     const [[job]] = await db.query(
//       `SELECT status FROM print_jobs WHERE job_id=?`,
//       [jobId]
//     );

//     if (!job) {
//       return res.status(404).json({ error: "Job not found" });
//     }

//     res.json({ status: job.status });

//   } catch (err) {
//     console.error("JOB STATUS ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

// /* =========================================================
//    PENDING JOBS — Pi polls this on startup + every 30s
//    Returns all PAID jobs for this machine that haven't
//    been printed yet and haven't expired
// ========================================================= */
// app.get("/api/kiosk/pending-jobs", verifyMachine, async (req, res) => {
//   try {
//     const machineId = req.machine.machine_id;

//     const [jobs] = await db.query(
//       `SELECT job_id, file_path
//        FROM print_jobs
//        WHERE machine_id = ?
//          AND status = 'PAID'
//          AND otp_verified = 0
//          AND otp_expires_at > NOW()`,
//       [machineId]
//     );

//     res.json({ jobs });
//   } catch (err) {
//     console.error("PENDING JOBS ERROR:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

//   /* =========================================================
//    CLEANUP OLD CREATED JOBS (30 MIN EXPIRY)
// ========================================================= */

// cron.schedule("*/5 * * * *", async () => {
//   console.log("Running cleanup...");

//   try {
//     // Delete old CREATED jobs
//     await db.query(`
//       DELETE FROM print_jobs
//       WHERE status='CREATED'
//       AND created_at < NOW() - INTERVAL 30 MINUTE
//     `);

//     // Expire PAID but unused OTP jobs
//     await db.query(`
//       UPDATE print_jobs
//       SET status='EXPIRED'
//       WHERE status='PAID'
//       AND otp_expires_at < NOW()
//     `);

//     // Delete old PRINTED jobs (24h retention)
//     await db.query(`
//       DELETE FROM print_jobs
//       WHERE status='PRINTED'
//       AND created_at < NOW() - INTERVAL 1 DAY
//     `);

//   } catch (err) {
//     console.error("CLEANUP ERROR:", err);
//   }
// });


// app.post("/api/register-machine", async (req, res) => {
//   try{
//   const { deviceSerial } = req.body
//   if  (!deviceSerial) {
//       return res.status(400).json({ error: "Device serial required" });
//     } 

//   const [[existing]] = await db.query(
//     `SELECT * FROM machines WHERE device_serial=?`,
//     [deviceSerial]
//   )

//   // if (existing) {
//   //   return res.json({
//   //     MACHINE_ID: existing.machine_id,
//   //     API_KEY: null, 
//   //   message:"Machine already registered. Contact admin."
//   //   })
//   // }
//   if (existing) {
//   const apiKey = crypto.randomBytes(32).toString("hex");
//   const hash = await bcrypt.hash(apiKey, 10);

//   await db.query(
//     `UPDATE machines SET api_key_hash=? WHERE machine_id=?`,
//     [hash, existing.machine_id]
//   );

//   return res.json({
//     MACHINE_ID: existing.machine_id,
//     API_KEY: apiKey,
//     // API_BASE: "http://192.168.0.108:5000/api"
//      API_BASE= "http://192.168.0.106:5000/api"
//   });
// }

//   // const [rows] = await db.query(
//   //     "SELECT machine_id FROM machines ORDER BY machine_id DESC LIMIT 1"
//   //   );

//   //   let machineId;
//   //   if (rows.length === 0) {
//   //     machineId = "MH1000";
//   //   } else {
//   //     const lastId = rows[0].machine_id;
//   //     const lastNumber = parseInt(lastId.replace("MH", ""), 10);
//   //     machineId = "MH" + (lastNumber + 1);
//   //   }

//   // const [[machine]] = await db.query(`
//   //     SELECT * FROM machines
//   //     WHERE assigned = FALSE
//   //     ORDER BY machine_id ASC
//   //     LIMIT 1
//   //   `);

//     const [[machine]] = await db.query(`
//       SELECT * FROM machines
//       WHERE assigned = FALSE
//       AND status = 'PENDING'
//       LIMIT 1
//     `);

//     if (!machine) {
//       return res.status(400).json({
//         error:"No available machines. Create from admin panel first."
//       });
//     }
//   const apiKey = crypto.randomBytes(32).toString("hex")
//   const hash = await bcrypt.hash(apiKey, 10)

//   // await db.query(
//   //   `INSERT INTO machines 
//   //    (machine_id, device_serial, api_key_hash, status)
//   //    VALUES (?, ?, ?, 'ACTIVE')`,
//   //   [machineId, deviceSerial, hash]
//   // )
//   await db.query(
//       `UPDATE machines
//        SET assigned = TRUE,
//            status = 'ACTIVE',
//            device_serial = ?,
//            api_key_hash = ?,
//            last_seen = NOW()
//        WHERE machine_id = ?`,
//       [deviceSerial, hash, machine.machine_id]
//     );

//   res.json({
//     MACHINE_ID: machine.machine_id,
//     API_KEY: apiKey,
//     // API_BASE: "http://192.168.0.108:5000/api"
//      API_BASE= "http://192.168.0.106:5000/api"
//   })
//    } catch (err) {
//     console.error("REGISTER ERROR:", err);
//     res.status(500).json({ error: "Registration failed" });
//   }
// })


// /* ---------------- START ---------------- */
// //app.listen(5000, () => console.log("Server running on 5000"));
// const http = require("http");
// const { initSocket } = require("./server/socket");

// const server = http.createServer(app);

// initSocket(server);

// server.listen(5000, () => {
//   console.log("Server running on 5000");
// });
