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
const mysql = require("mysql2/promise"); // ✅ was missing in your snippet

const db = mysql.createPool({
  host:     process.env.DB_HOST     || process.env.MYSQLHOST,
  user:     process.env.DB_USER     || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME     || process.env.MYSQLDATABASE,
  port:     parseInt(process.env.DB_PORT || process.env.MYSQLPORT || "3306"),
  ssl: { rejectUnauthorized: false },

  waitForConnections: true,
  connectionLimit:    10,

  // ✅ FIXED: connectTimeout is not a valid mysql2 pool option
  // acquireTimeout controls how long to wait for a free connection from the pool
  acquireTimeout: 30000,

  // ✅ Prevents Railway from dropping idle connections
  enableKeepAlive:       true,
  keepAliveInitialDelay: 0,
});

// Test connection on startup
(async () => {
  try {
    const conn = await db.getConnection();
    console.log("✅ DB Connected to:", process.env.DB_HOST || process.env.MYSQLHOST);
    conn.release();
  } catch (err) {
    console.error("❌ DB Connection Failed:", err.message);
    console.error("   Host:", process.env.DB_HOST || process.env.MYSQLHOST);
    console.error("   User:", process.env.DB_USER || process.env.MYSQLUSER);
    console.error("   DB:  ", process.env.DB_NAME || process.env.MYSQLDATABASE);
    console.error("   Port:", process.env.DB_PORT || process.env.MYSQLPORT);
  }
})();

module.exports = db;
// mysql://root:ruxfBOwHLuhmlTpJtQuRpDVgxBArrRUw@interchange.proxy.rlwy.net:19751/railway