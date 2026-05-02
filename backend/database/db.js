// const mysql = require("mysql2/promise");

// const db = mysql.createPool({
//   host: "localhost",
//   user: "root",
//   password: "root",
//   database: "print_kiosk_network",
// });

// module.exports=db;

// const mysql = require("mysql2/promise");

// const db = mysql.createPool({
//   host:     process.env.DB_HOST,
//   user:     process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,
//   port:     parseInt(process.env.DB_PORT || "3306"),
//   ssl:      { rejectUnauthorized: false },  // needed for PlanetScale/remote MySQL
//   waitForConnections: true,
//   connectionLimit: 10,
// });

// module.exports = db;
const mysql = require("mysql2/promise");

// ✅ Only proven valid mysql2 pool options — no connectTimeout/acquireTimeout
const db = mysql.createPool({
  host:     process.env.DB_HOST     || process.env.MYSQLHOST     || "localhost",
  user:     process.env.DB_USER     || process.env.MYSQLUSER     || "root",
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || "",
  database: process.env.DB_NAME     || process.env.MYSQLDATABASE || "railway",
  port:     parseInt(process.env.DB_PORT || process.env.MYSQLPORT || "3306"),
  ssl:             { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

// Test on startup — non-fatal so server always starts
(async () => {
  try {
    const conn = await db.getConnection();
    console.log("✅ DB Connected:", process.env.DB_HOST || process.env.MYSQLHOST);
    conn.release();
  } catch (err) {
    console.error("❌ DB Connection Failed:", err.message);
  }
})();

module.exports = db;
// mysql://root:ruxfBOwHLuhmlTpJtQuRpDVgxBArrRUw@interchange.proxy.rlwy.net:19751/railway