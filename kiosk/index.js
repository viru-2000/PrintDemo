
// const axios = require("axios");
// const readline = require("readline");
// const { print } = require("pdf-to-printer");
// const crypto = require("crypto");
// const os = require("os");
// const fs = require("fs");




// /* ===============================
//    CONFIG
// =============================== */
// const API_BASE = "http://192.168.0.106:5000/api"
// const CONFIG_FILE = "./config.json";

// const MAX_ATTEMPTS = 3;

// function getDeviceId() {
//   const interfaces = os.networkInterfaces();

//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (!iface.internal && iface.mac !== "00:00:00:00:00:00") {
//         return iface.mac;
//       }
//     }
//   }

//   return os.hostname(); // fallback
// }

// /* ===============================
//    LOAD / REGISTER MACHINE
// =============================== */
// let MACHINE_ID = null;
// let API_KEY = null;

// // async function registerMachine() {
// //   console.log("Registering machine...");

// //   const deviceSerial = os.hostname(); // or MAC / CPU ID

// //   const res = await axios.post(`${API_BASE}/register-machine`, {
// //     deviceSerial,
// //   });
// //   const data= res.data;
 
// //   if (data.API_KEY) {
// //     fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
// //     console.log("Machine registered successfully.");
// //     return data;
// //   }

  
// //   if (!data.API_KEY && data.MACHINE_ID) {
// //     console.log("Machine already registered. Fetching existing config...");

    
// //     const existingConfig = loadConfig();

// //     if (!existingConfig) {
// //       throw new Error(
// //         "Machine already registered but config missing. Cannot recover API key."
// //       );
// //     }

// //     return existingConfig;
// //   }
// //   fs.writeFileSync(CONFIG_FILE, JSON.stringify(res.data, null, 2));

// //   console.log("Machine registered successfully.");
// //   return res.data;
// // }

// // function loadConfig() {
// //   if (!fs.existsSync(CONFIG_FILE)) {
// //     return null;
// //   }
// //   return JSON.parse(fs.readFileSync(CONFIG_FILE));
// // }

// async function registerMachine() {
//   console.log("Registering machine...");

//   const deviceSerial = getDeviceId();

//   try {
//     const res = await axios.post(`${API_BASE}/register-machine`, {
//       deviceSerial,
//     });

//     const data = res.data;

//     fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));

//     console.log("Machine registered successfully.");
//     return data;

//   } catch (err) {
//     if (err.response?.status === 403) {
//       console.log("❌ Machine already registered. Contact admin.");
//       process.exit(1);
//     }

//     console.log("Registration failed:", err.message);
//     throw err;
//   }
// }

//   function loadConfig() {
//   try {
//     if (!fs.existsSync(CONFIG_FILE)) {
//       return null;
//     }

//     const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();

    
//     if (!data) {
//       console.log("Config file empty. Re-registering...");
//       return null;
//     }

//     return JSON.parse(data);

//   } catch (err) {
//     console.log("Invalid config. Re-registering...");
    
    
//     try {
//       fs.unlinkSync(CONFIG_FILE);
//     } catch (e) {}

//     return null;
//   }
// }
// async function initMachine() {
//   let config = loadConfig();

//   if (!config) {
//     config = await registerMachine();
//   }
//   if (!config.API_KEY || !config.MACHINE_ID) {
//     console.log("Invalid config. Re-registering...");
//     fs.unlinkSync(CONFIG_FILE);
//     config = await registerMachine();
//   }
//   MACHINE_ID = config.MACHINE_ID;
//   API_KEY = config.API_KEY;

//   console.log("Machine Ready:", MACHINE_ID);
// }
// /* ===============================
//    SIGN REQUEST
// =============================== */
// function signRequest(body) {
//   const timestamp = Date.now().toString();
//   const bodyString = JSON.stringify(body || {});

//   const signature = crypto
//     .createHmac("sha256", API_KEY)
//     .update(MACHINE_ID + timestamp + bodyString)
//     .digest("hex");

//   return { timestamp, signature };
// }

// /* ---------------- HEARTBEAT ---------------- */
// function startHeartbeat() {
//   setInterval(async () => {
//     try {
//       const cpuUsage = os.loadavg()[0];

//       const body = {
//         cpu_usage: cpuUsage,
//         paper_level: 80,
//         ink_level: 60,
//         status: "ONLINE"
//       };

//       const auth = signRequest(body);
//       await axios.post(`${API_BASE}/kiosk/heartbeat`, body, {
//         headers: {
//           "X-Machine-Id": MACHINE_ID,
//           "X-Api-Key": API_KEY, 
//           "X-Timestamp": auth.timestamp,
//           "X-Signature": auth.signature,
//         },
//       });
//        console.log("Heartbeat sent");

//     } catch (err) {
//       console.log("Heartbeat failed");
//     }
//   }, 60000);
// }



// /* ===============================
//    CLI SETUP
// =============================== */
// const rl = readline.createInterface({
//   input: process.stdin,
//   output: process.stdout,
// });

// function ask(question) {
//   return new Promise((resolve) => rl.question(question, resolve));
// }

// /* ===============================
//    HELPERS
// =============================== */
// function isOtp(input) {
//   return /^\d{4}$/.test(input);
// }

// function isQrToken(input) {
//   return /^[a-f0-9]{64}$/i.test(input);
// }

// function parseInput(input) {
//   input = input.trim();

//   if (input.startsWith("PRINTJOB:")) {
//     const token = input.replace("PRINTJOB:", "").trim();
//     if (isQrToken(token)) {
//       return { qrToken: token };
//     }
//   }

//   if (isOtp(input)) {
//     return { otp: input };
//   }

//   if (isQrToken(input)) {
//     return { qrToken: input };
//   }

//   return null;
// }

// /* ===============================
//    MAIN FLOW
// =============================== */
// (async () => {
//   try {
//     await initMachine();
//   } catch (err) {
//     console.error("Failed to initialize machine:", err.message);
//     process.exit(1); // Stop if we can't load the key
//   }
//   startHeartbeat();
//   while(true) {
  
//   let attempts = 0;

//   while (attempts < MAX_ATTEMPTS) {
//     try {
//       const input = await ask(
//         "Enter OTP or Scan QR : "
//       );

//       const payload = parseInput(input);

//       if (!payload) {
//         console.log("Invalid OTP or QR format.\n");
//         attempts++;
//         continue;
//       }

//       const auth = signRequest(payload);
//       /* ===============================
//          UNLOCK JOB
//       =============================== */
//        const unlockRes = await axios.post(
//         `${API_BASE}/kiosk/unlock`,
//         payload,
//         {
//           headers: {
//             "X-Machine-Id": MACHINE_ID,
//             "X-Api-Key": API_KEY, 
//             "X-Timestamp": auth.timestamp,
//             "X-Signature": auth.signature,
//           },
//         }
//       );

//       const job = unlockRes.data;

//       console.log("Job unlocked successfully.");
//       console.log("Job details:", job);

//       /* ===============================
//          PRINT
//       =============================== */
//       console.log("Printing:", job.filePath);

//       try {

//           await print(job.filePath, {
//             copies: job.copies,
//             monochrome: job.color === "bw",
//             paperSize: job.paperSize,
//           });

//         } catch (printErr) {

//           console.log("Printer error:", printErr.message);

          
//           const failBody = { jobId: job.jobId };
//           const failAuth = signRequest(failBody);

//           await axios.post(
//             `${API_BASE}/kiosk/mark-failed`,
//             failBody,
//             {
//               headers: {
//                 "X-Machine-Id": MACHINE_ID,
//                 "X-Api-Key": API_KEY, 
//                 "X-Timestamp": failAuth.timestamp,
//                 "X-Signature": failAuth.signature,
//               },
//             }
//           );

//           console.log("Job marked as FAILED.\n");
//           break;
//         }
//       const markBody = { jobId: job.jobId };
//       const markAuth = signRequest(markBody);

//       /* ===============================
//          MARK PRINTED
//       =============================== */
//       await axios.post(`${API_BASE}/kiosk/mark-printed`,markBody, {
//         headers: {
//             "X-Machine-Id": MACHINE_ID,
//             "X-Api-Key": API_KEY, 
//             "X-Timestamp": markAuth.timestamp,
//             "X-Signature": markAuth.signature,
//           },
//       });

//       console.log("Print completed successfully.");
//       break;

//     } catch (err) {
//       attempts++;

//       const msg =
//         err.response?.data?.error ||
//         err.message ||
//         "Unlock failed";

//       console.log(`Error: ${msg}`);
//       console.log(`Attempts left: ${MAX_ATTEMPTS - attempts}\n`);

//       if (attempts >= MAX_ATTEMPTS) {
//         console.log("Maximum attempts reached.");
//       }
//     }
//   }
// }
// })();



// const { app, BrowserWindow } = require("electron");
// const path = require("path");

// require("./kioskCore");

// function createWindow() {
//   const win = new BrowserWindow({
//     width: 800,
//     height: 480,
//     fullscreen: true,
//     kiosk: true,
//     webPreferences: {
//       preload: path.join(__dirname, "preload.js"),
//     },
//   });

//   win.loadFile("index.html");
// }

// app.whenReady().then(createWindow);




// main.js — Electron main process entry point
const { app, BrowserWindow } = require("electron");
const path = require("path");

// ✅ Boot kioskCore (registers machine, starts heartbeat, socket, poller)
// mainLoop() is NOT called because we're in Electron mode (not CLI)
require("./kioskCore");

function createWindow() {
 const win = new BrowserWindow({
  width:      800,
  height:     480,
  fullscreen: true,
  kiosk:      true,
  webPreferences: {
    preload:          path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration:  false,
    sandbox:          false,   // ✅ ADD THIS — allows require() in preload
  },
});

  win.loadFile("index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
