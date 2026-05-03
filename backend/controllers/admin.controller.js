const crypto = require("crypto");
const bcrypt  = require("bcrypt");
const db      = require("../database/db");

// ✅ Use the same env var as server.js so Pi devices get the correct Railway URL
const SERVER_API_BASE = process.env.API_BASE_URL || "https://print-production-524d.up.railway.app";

/* ===========================
   DASHBOARD STATS
=========================== */
exports.getStats = async (req, res) => {
  try {
    const [[jobsToday]] = await db.query(`
      SELECT COUNT(*) as total
      FROM print_jobs
      WHERE DATE(created_at)=CURDATE()
    `);

    const [[revenueToday]] = await db.query(`
      SELECT SUM(amount) as total
      FROM print_jobs
      WHERE status='PRINTED'
      AND DATE(created_at)=CURDATE()
    `);

    const [[machinesOnline]] = await db.query(`
      SELECT COUNT(*) as total
      FROM machines
      WHERE last_seen > NOW() - INTERVAL 2 MINUTE
    `);

    const [[machinesTotal]] = await db.query(`
      SELECT COUNT(*) as total
      FROM machines
    `);

    res.json({
      jobsToday:      jobsToday.total      || 0,
      revenueToday:   revenueToday.total   || 0,
      machinesOnline: machinesOnline.total || 0,
      machinesTotal:  machinesTotal.total  || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dashboard error" });
  }
};

/* ===========================
   CREATE MACHINE
=========================== */
exports.createMachine = async (req, res) => {
  try {
    const { name, location } = req.body;

    const [rows] = await db.query(
      "SELECT machine_id FROM machines ORDER BY machine_id DESC Limit 1"
    );

    let machineId;
    if (rows.length === 0) {
      machineId = "MH1000";
    } else {
      const lastId     = rows[0].machine_id;
      const lastNumber = parseInt(lastId.slice(2), 10);
      machineId        = "MH" + (lastNumber + 1).toString().padStart(4, "0");
    }

    const apiKey = crypto.randomBytes(32).toString("hex");
    const hash   = await bcrypt.hash(apiKey, 10);

    await db.query(
      `INSERT INTO machines
       (machine_id, name, location, status, assigned, api_key_hash)
       VALUES (?, ?, ?, 'PENDING', FALSE, ?)`,
      [machineId, name, location, hash]
    );

    res.json({
      success: true,
      message: "Machine created. Waiting for device registration.",
      credentials: {
        MACHINE_ID: machineId,
        API_KEY:    apiKey,
        // ✅ Fixed: was hardcoded to localhost — now uses Railway public URL
        API_BASE:   SERVER_API_BASE,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create machine" });
  }
};

/* ===========================
   MACHINES LIST
=========================== */
exports.getMachines = async (req, res) => {
  try {
    const [machines] = await db.query(`
      SELECT machine_id, last_seen, is_print_locked
      FROM machines
    `);
    res.json(machines);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch machines" });
  }
};

/* ===========================
   ALERTS
=========================== */
exports.getAlerts = async (req, res) => {
  try {
    const [alerts] = await db.query(`
      SELECT *
      FROM machine_alerts
      WHERE is_resolved=FALSE
      ORDER BY created_at DESC
    `);
    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
};

/* ===========================
   LIVE JOBS
=========================== */
exports.getLiveJobs = async (req, res) => {
  try {
    const [jobs] = await db.query(`
      SELECT job_id, machine_id, status, created_at
      FROM print_jobs
      WHERE status IN ('CREATED','PAYING','PAID','PRINTING')
      ORDER BY created_at DESC
      LIMIT 20
    `);
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch live jobs" });
  }
};

/* ===========================
   REVENUE CHART
=========================== */
exports.getRevenue = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DATE(created_at) as day,
             SUM(amount) as revenue
      FROM print_jobs
      WHERE status='PRINTED'
      GROUP BY DATE(created_at)
      ORDER BY day DESC
      LIMIT 7
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch revenue" });
  }
};

/* ===========================
   MACHINE INFO
=========================== */
exports.getMachineInfo = async (req, res) => {
  try {
    const [machines] = await db.query(`
      SELECT
        m.machine_id,
        m.name,
        m.status,
        m.is_print_locked,
        m.last_seen,
        COUNT(p.id) as total_jobs,
        COALESCE(SUM(p.amount), 0) as revenue
      FROM machines m
      LEFT JOIN print_jobs p
        ON p.machine_id = m.machine_id
        AND p.status='PRINTED'
      GROUP BY m.machine_id
      ORDER BY m.created_at DESC
    `);

    const now = Date.now();

    const result = machines.map((m) => {
      let isOnline = false;
      if (m.last_seen) {
        const diff = (now - new Date(m.last_seen).getTime()) / 1000;
        isOnline = diff < 120;
      }
      return { ...m, is_online: isOnline };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch machine info" });
  }
};

/* ===========================
   MACHINE REPORT
=========================== */
exports.machineReport = async (req, res) => {
  try {
    const { machineId } = req.params;
    const { period }    = req.query;

    // Whitelist interval to prevent any SQL injection
    const intervalMap = { "1": "1 MONTH", "3": "3 MONTH", "6": "6 MONTH", "12": "1 YEAR" };
    const interval = intervalMap[period] || "1 MONTH";

    const [rows] = await db.query(`
      SELECT
        DATE(created_at) as date,
        SUM(amount) as revenue
      FROM print_jobs
      WHERE machine_id = ?
        AND status = 'PRINTED'
        AND created_at > NOW() - INTERVAL ${interval}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [machineId]);

    res.json(rows);
  } catch (err) {
    console.error("REPORT ERROR:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
};



// const crypto = require("crypto")
// const bcrypt = require("bcrypt")
// const db = require("../database/db");

// /* ===========================
//    DASHBOARD STATS
// =========================== */
// exports.getStats = async (req, res) => {
//   try {

//     const [[jobsToday]] = await db.query(`
//       SELECT COUNT(*) as total
//       FROM print_jobs
//       WHERE DATE(created_at)=CURDATE()
//     `);

//     const [[revenueToday]] = await db.query(`
//       SELECT SUM(amount) as total
//       FROM print_jobs
//       WHERE status='PRINTED'
//       AND DATE(created_at)=CURDATE()
//     `);

//     const [[machinesOnline]] = await db.query(`
//       SELECT COUNT(*) as total
//       FROM machines
//       WHERE last_seen > NOW() - INTERVAL 2 MINUTE
//     `);

//     const [[machinesTotal]] = await db.query(`
//       SELECT COUNT(*) as total
//       FROM machines
//     `);

//     res.json({
//       jobsToday: jobsToday.total || 0,
//       revenueToday: revenueToday.total || 0,
//       machinesOnline: machinesOnline.total || 0,
//       machinesTotal: machinesTotal.total || 0
//     });

//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Dashboard error" });
//   }
// };

// /* ===========================
//    CREATE MACHINES 
// =========================== */
// exports.createMachine = async (req, res) => {

//   try {

//     const { name, location } = req.body

//     const [rows] = await db.query(
//       "SELECT machine_id FROM machines ORDER BY machine_id DESC LIMIT 1"
//     );

//     let machineId;
//     if (rows.length === 0) {
//       machineId = "MH1000";
//     } else {
//       const lastId = rows[0].machine_id;
//       const lastNumber = parseInt(lastId.slice(2), 10);
//       const nextNumber = lastNumber + 1;
//       machineId = "MH" + nextNumber.toString().padStart(4, "0");
//     }

//     const apiKey = crypto.randomBytes(32).toString("hex")

//     const hash = await bcrypt.hash(apiKey, 10)

//     // await db.query(
//     //   `INSERT INTO machines 
//     //    (machine_id, name, location, api_key_hash, status,assigned)
//     //    VALUES (?, ?, ?, ?, 'ACTIVE',FALSE)`,
//     //   [machineId, name, location, hash]
//     // )
//     await db.query(
//       `INSERT INTO machines 
//        (machine_id, name, location, status, assigned,api_key_hash)
//        VALUES (?, ?, ?, 'PENDING', FALSE,?)`,
//       [machineId, name, location, hash]
//     );

//     res.json({
//       success: true,
//        message: "Machine created. Waiting for device registration.",
//       // ⚠️ RETURN ONLY ONCE
//       credentials: {
//         MACHINE_ID: machineId,
//         API_KEY: apiKey,
//         API_BASE: "http://localhost:5000/api"
//       }
//     })

//   } catch (err) {
//     console.error(err)
//     res.status(500).json({ error: "Failed to create machine" })
//   }
// }
// /* ===========================
//    MACHINES LIST
// =========================== */
// exports.getMachines = async (req, res) => {

//   const [machines] = await db.query(`
//     SELECT machine_id,last_seen,is_print_locked
//     FROM machines
//   `);

//   res.json(machines);
// };

// /* ===========================
//    ALERTS
// =========================== */
// exports.getAlerts = async (req, res) => {

//   const [alerts] = await db.query(`
//     SELECT *
//     FROM machine_alerts
//     WHERE is_resolved=FALSE
//     ORDER BY created_at DESC
//   `);

//   res.json(alerts);
// };

// /* ===========================
//    LIVE JOBS
// =========================== */
// exports.getLiveJobs = async (req, res) => {

//   const [jobs] = await db.query(`
//     SELECT job_id,machine_id,status,created_at
//     FROM print_jobs
//     WHERE status IN ('CREATED','PAYING','PAID','PRINTING')
//     ORDER BY created_at DESC
//     LIMIT 20
//   `);

//   res.json(jobs);
// };

// /* ===========================
//    REVENUE CHART
// =========================== */
// exports.getRevenue = async (req, res) => {

//   const [rows] = await db.query(`
//     SELECT DATE(created_at) as day,
//            SUM(amount) as revenue
//     FROM print_jobs
//     WHERE status='PRINTED'
//     GROUP BY DATE(created_at)
//     ORDER BY day DESC
//     LIMIT 7
//   `);

//   res.json(rows);
// };

// exports.getMachineInfo = async (req, res) => {

//   const [machines] = await db.query(`
//    SELECT 
//       m.machine_id,
//       m.name,
//       m.status,
//       m.is_print_locked,
//       m.last_seen,

//       COUNT(p.id) as total_jobs,
//       COALESCE(SUM(p.amount), 0) as revenue

//     FROM machines m
//     LEFT JOIN print_jobs p
//       ON p.machine_id = m.machine_id
//       AND p.status='PRINTED'

//     GROUP BY m.machine_id
//     ORDER BY m.created_at DESC
//   `)
    
// const now = Date.now()

//   const result = machines.map(m => {
//     let isOnline = false

//     if (m.last_seen) {
//       const diff = (now - new Date(m.last_seen).getTime()) / 1000
//       isOnline = diff < 120
//     }

//     return {
//       ...m,
//       is_online: isOnline
//     }
//   })

//   res.json(result)

// }

// exports.machineReport = async (req, res) => {
//   try {
//     const { machineId } = req.params;
//     const { period } = req.query;

//     // 1. Set a default and validate
//     let interval;
//     switch (period) {
//       case "1": interval = "1 MONTH"; break;
//       case "3": interval = "3 MONTH"; break;
//       case "6": interval = "6 MONTH"; break;
//       case "12": interval = "1 YEAR"; break;
//       default: interval = "1 MONTH"; // Default fallback
//     }

//     // 2. Use the validated interval in the query
//     const [rows] = await db.query(`
//       SELECT 
//         DATE(created_at) as date,
//         SUM(amount) as revenue
//       FROM print_jobs
//       WHERE machine_id = ?
//         AND status = 'PRINTED'
//         AND created_at > NOW() - INTERVAL ${interval}
//       GROUP BY DATE(created_at)
//       ORDER BY date ASC
//     `, [machineId]);

//     res.json(rows);
//   } catch (err) {
//     console.error("REPORT ERROR:", err);
//     res.status(500).json({ error: "Failed to generate report" });
//   }
// };


