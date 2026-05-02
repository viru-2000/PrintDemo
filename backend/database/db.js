// const mysql = require("mysql2/promise");

// const db = mysql.createPool({
//   host: "localhost",
//   user: "root",
//   password: "root",
//   database: "print_kiosk_network",
// });

// module.exports=db;

const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port:     parseInt(process.env.DB_PORT || "3306"),
  ssl:      { rejectUnauthorized: false },  // needed for PlanetScale/remote MySQL
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = db;

// mysql://root:ruxfBOwHLuhmlTpJtQuRpDVgxBArrRUw@interchange.proxy.rlwy.net:19751/railway