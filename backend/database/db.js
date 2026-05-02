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

// ✅ Railway MySQL provides variables in two formats — support both
// Railway auto-injects: MYSQLHOST, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE, MYSQLPORT
// Your custom vars:     DB_HOST,   DB_USER,   DB_PASSWORD,   DB_NAME,        DB_PORT
const db = mysql.createPool({
  host:     process.env.DB_HOST       || process.env.MYSQLHOST,
  user:     process.env.DB_USER       || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD   || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME       || process.env.MYSQLDATABASE,
  port:     parseInt(process.env.DB_PORT || process.env.MYSQLPORT || "3306"),
  ssl:      { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    10,
  connectTimeout:     30000,   // ✅ 30s — Railway internal network can be slow on cold start
});

// TEST CONNECTION ON START
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