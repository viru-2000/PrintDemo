// kioskCore.js — Raspberry Pi Ready — Option C (Hybrid: Socket + Disk Cache)
const axios        = require("axios");
const fs           = require("fs");
const path         = require("path");
const { exec }     = require("child_process");
const crypto       = require("crypto");
const os           = require("os");
const readline     = require("readline");
const { io: socketIO } = require("socket.io-client");

/* ===============================
   CONFIG
=============================== */
const IS_PI      = process.platform === "linux";
const IS_WINDOWS = process.platform === "win32";

const PROJECT_ROOT = IS_PI
  ? "/home/pi/kiosk"
  : path.resolve(__dirname);

const FALLBACK_API_BASE  = "https://printdemo-production.up.railway.app/api";
const CONFIG_FILE        = path.join(PROJECT_ROOT, "config.json");
const DOWNLOAD_DIR       = path.join(PROJECT_ROOT, "kiosk", "files");
const CACHE_FILE         = path.join(PROJECT_ROOT, "kiosk", "jobs.json");
const HEARTBEAT_INTERVAL = 30000;
const POLL_INTERVAL      = 30000;

/* ===============================
   LOAD API_BASE FROM CONFIG FIRST
=============================== */
function getApiBase() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
      if (raw) {
        const config = JSON.parse(raw);
        if (config.API_BASE) {
          console.log("🌐 API_BASE loaded from config:", config.API_BASE);
          return config.API_BASE;
        }
      }
    }
  } catch (err) {
    console.warn("⚠️  Could not read API_BASE from config, using fallback:", err.message);
  }
  console.log("🌐 API_BASE using fallback (first boot):", FALLBACK_API_BASE);
  return FALLBACK_API_BASE;
}

let API_BASE = getApiBase();

/* ===============================
   GLOBALS
=============================== */
let MACHINE_ID   = null;
let API_KEY      = null;
let PRINTER_NAME = null;
let fileCache    = {};

/* ===============================
   CACHE HELPERS
=============================== */
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, "utf-8").trim();
    if (!raw) return;
    fileCache = JSON.parse(raw);
    const now = Date.now();
    for (const jobId of Object.keys(fileCache)) {
      if (fileCache[jobId].expires < now) {
        safeDelete(fileCache[jobId].filePath);
        delete fileCache[jobId];
      }
    }
    console.log(`📦 Cache loaded: ${Object.keys(fileCache).length} job(s)`);
  } catch (err) {
    console.error("Cache load error:", err.message);
    fileCache = {};
  }
}

function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(fileCache, null, 2)); }
  catch (err) { console.error("Cache save error:", err.message); }
}

function addToCache(jobId, filePath, expiresAt) {
  fileCache[jobId] = { filePath, expires: new Date(expiresAt).getTime() };
  saveCache();
}

function getFromCache(jobId) {
  const entry = fileCache[jobId];
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    safeDelete(entry.filePath);
    delete fileCache[jobId];
    saveCache();
    return null;
  }
  return entry.filePath;
}

function removeFromCache(jobId) {
  delete fileCache[jobId];
  saveCache();
}

function safeDelete(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/* ===============================
   ENSURE DIRS
=============================== */
function ensureDir() {
  [DOWNLOAD_DIR, path.dirname(CACHE_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

/* ===============================
   DEVICE SERIAL  (MAC address)
=============================== */
function getDeviceSerial() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        return iface.mac;
      }
    }
  }
  return os.hostname();
}

/* ===============================
   REGISTER MACHINE
   ✅ FIX: Server now returns the SAME api_key for an already-registered
   device serial (see server fix below). Pi always saves whatever the
   server returns — so both sides are always in sync.
=============================== */
async function registerMachine() {
  console.log("🔄 Registering machine...");
  const deviceSerial = getDeviceSerial();
  console.log("🔑 Device serial (MAC):", deviceSerial);

  const res = await axios.post(`${API_BASE}/register-machine`, { deviceSerial });
  console.log("📡 Server registration response:", JSON.stringify(res.data));

  const machineId = res.data.MACHINE_ID || res.data.machine_id || res.data.machineId;
  if (!machineId) {
    throw new Error(
      `Server did not return MACHINE_ID. Got keys: ${Object.keys(res.data).join(", ")}. ` +
      `Full response: ${JSON.stringify(res.data)}`
    );
  }

  const apiKey  = res.data.API_KEY  || res.data.api_key  || res.data.apiKey;
  const apiBase = res.data.API_BASE || res.data.api_base || res.data.apiBase || API_BASE;

  if (!apiKey) {
    throw new Error(`Server did not return API_KEY. Got keys: ${Object.keys(res.data).join(", ")}`);
  }

  const fullConfig = {
    MACHINE_ID:    machineId,
    DEVICE_SERIAL: deviceSerial,
    API_KEY:       apiKey,
    API_BASE:      apiBase,
    PRINTER_NAME:  null,
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(fullConfig, null, 2));
  console.log("✅ Machine registered — MACHINE_ID:", machineId);
  console.log("💾 Config saved to:", CONFIG_FILE);
  return fullConfig;
}

/* ===============================
   LOAD CONFIG
=============================== */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
    if (!data) return null;
    return JSON.parse(data);
  } catch {
    try { fs.unlinkSync(CONFIG_FILE); } catch {}
    return null;
  }
}

function saveConfig(updates) {
  const current = loadConfig() || {};
  const merged  = { ...current, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

/* ===============================
   VERIFY KEY WITH SERVER
   ✅ NEW: Before using saved credentials, ping the server
   to confirm the key is still valid. If rejected, re-register.
=============================== */
async function verifyKeyWithServer(machineId, apiKey, apiBase) {
  try {
    console.log("🔍 Verifying saved API key with server...");
    // We do a lightweight heartbeat-style check
    const body = { status: "CHECK" };
    const timestamp  = Date.now().toString();
    const bodyString = JSON.stringify(body);
    const signature  = crypto
      .createHmac("sha256", apiKey)
      .update(machineId + timestamp + bodyString)
      .digest("hex");

    await axios.post(`${apiBase}/kiosk/heartbeat`, body, {
      headers: {
        "X-Machine-Id": machineId,
        "X-Api-Key":    apiKey,
        "X-Timestamp":  timestamp,
        "X-Signature":  signature,
      },
      timeout: 10000,
    });

    console.log("✅ API key verified — credentials are valid");
    return true;
  } catch (err) {
    const status = err.response?.status;
    console.warn(`⚠️  Key verification failed — HTTP ${status}: ${err.response?.data?.error || err.message}`);
    return false;
  }
}

/* ===============================
   INIT MACHINE
   ✅ FIX: After loading config, verify the key is still accepted
   by the server. Re-register if rejected (403/401).
=============================== */
async function initMachine() {
  try {
    let config = loadConfig();

    // Re-register if config is missing or has old MAC-based MACHINE_ID
    const isMacAddress = config?.MACHINE_ID &&
      /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(config.MACHINE_ID);

    const hasValidConfig = config
      && config.API_KEY
      && config.MACHINE_ID
      && !isMacAddress;

    if (!hasValidConfig) {
      if (isMacAddress) {
        console.log("⚠️  Old config — MACHINE_ID is a MAC address. Re-registering...");
      } else {
        console.log("⚠️  Config missing or incomplete — registering...");
      }
      try { fs.unlinkSync(CONFIG_FILE); } catch {}
      config = await registerMachine();
    } else {
      // ✅ Config looks valid — but verify the key is still accepted by server
      const keyOk = await verifyKeyWithServer(config.MACHINE_ID, config.API_KEY, config.API_BASE || API_BASE);
      if (!keyOk) {
        console.log("🔄 Key rejected by server — re-registering to get fresh credentials...");
        try { fs.unlinkSync(CONFIG_FILE); } catch {}
        config = await registerMachine();
      }
    }

    MACHINE_ID = config.MACHINE_ID;
    API_KEY    = config.API_KEY;
    if (config.API_BASE) API_BASE = config.API_BASE;
    if (config.PRINTER_NAME) PRINTER_NAME = config.PRINTER_NAME;

    console.log("✅ Machine Ready");
    console.log("   MACHINE_ID :", MACHINE_ID);
    console.log("   API_BASE   :", API_BASE);
    console.log("   Platform   :", process.platform, IS_PI ? "(Raspberry Pi)" : "(Laptop/Dev)");
    console.log("   Config     :", CONFIG_FILE);
  } catch (err) {
    console.error("❌ Init failed:", err.message);
    process.exit(1);
  }
}

/* ===============================
   SECURITY — SIGN REQUEST
=============================== */
function signRequest(body) {
  const timestamp  = Date.now().toString();
  const bodyString = JSON.stringify(body || {});
  const signature  = crypto
    .createHmac("sha256", API_KEY)
    .update(MACHINE_ID + timestamp + bodyString)
    .digest("hex");
  return { timestamp, signature };
}

function getHeaders(body) {
  const auth = signRequest(body);
  return {
    "X-Machine-Id": MACHINE_ID,
    "X-Api-Key":    API_KEY,
    "X-Timestamp":  auth.timestamp,
    "X-Signature":  auth.signature,
  };
}

/* ===============================
   PRINTER DETECTION
=============================== */
function detectPrinter() {
  return new Promise((resolve, reject) => {
    exec("lpstat -p", (err, stdout) => {
      if (err) return reject(new Error(`lpstat failed: ${err.message}`));
      const match = stdout.match(/printer\s+(\S+)/);
      if (match) return resolve(match[1]);
      reject(new Error("No printer found in lpstat output"));
    });
  });
}

async function ensurePrinter() {
  const config = loadConfig();
  if (config?.PRINTER_NAME) {
    PRINTER_NAME = config.PRINTER_NAME;
    console.log("✅ Printer loaded from config:", PRINTER_NAME);
    return;
  }
  if (IS_WINDOWS) {
    console.log("⚠️  Windows detected — skipping printer detection");
    return;
  }
  try {
    PRINTER_NAME = await detectPrinter();
    console.log("✅ Printer detected:", PRINTER_NAME);
    saveConfig({ PRINTER_NAME });
  } catch (err) {
    console.log("⚠️  No printer detected:", err.message);
    console.log("🔄 Retrying in 5s...");
    setTimeout(ensurePrinter, 5000);
  }
}

/* ===============================
   DOWNLOAD FILE
=============================== */
async function downloadFile(fileUrl, jobId = null) {
  let url;
  if (fileUrl.startsWith("http")) {
    url = fileUrl;
  } else {
    const filename = fileUrl.includes("\\")
      ? fileUrl.split("\\").pop()
      : fileUrl.split("/").pop();
    url = `${API_BASE.replace("/api", "")}/uploads/${filename}`;
  }
  console.log("⬇️  Downloading from URL:", url);
  const filename = jobId ? `${jobId}.pdf` : `${Date.now()}.pdf`;
  const filePath = path.join(DOWNLOAD_DIR, filename);
  const response = await axios({ url, method: "GET", responseType: "arraybuffer", timeout: 30000 });
  fs.writeFileSync(filePath, Buffer.from(response.data));
  console.log("✅ File written to:", filePath);
  return filePath;
}

/* ===============================
   PRE-FETCH
=============================== */
async function preFetchJob(jobId, filePath, expiresAt) {
  const cached = getFromCache(jobId);
  if (cached && fs.existsSync(cached)) {
    console.log(`📦 Already cached: ${jobId}`);
    return;
  }
  try {
    console.log(`⬇️  Pre-fetching: ${jobId}`);
    const localPath = await downloadFile(filePath, jobId);
    addToCache(jobId, localPath, expiresAt);
    console.log(`✅ Cached: ${jobId} → ${localPath}`);
  } catch (err) {
    console.error(`❌ Pre-fetch failed for ${jobId}:`, err.message);
  }
}

/* ===============================
   SOCKET
=============================== */
function connectSocket() {
  const serverBase = API_BASE.replace("/api", "");
  const socket = socketIO(serverBase, {
    reconnection: true, reconnectionDelay: 3000, reconnectionDelayMax: 10000,
  });
  socket.on("connect", () => {
    console.log("🔌 Socket connected to", serverBase);
    if (typeof global.onSocketStatus === "function") global.onSocketStatus("connected");
  });
  socket.on("payment_success", ({ jobId, machineId, filePath }) => {
    if (machineId !== MACHINE_ID) return;
    const expiresAt = Date.now() + 5 * 60 * 1000;
    console.log(`💳 Payment received for ${jobId} — pre-fetching...`);
    preFetchJob(jobId, filePath, expiresAt);
  });
  socket.on("disconnect", (reason) => {
    console.log("🔌 Socket disconnected:", reason);
    if (typeof global.onSocketStatus === "function") global.onSocketStatus("disconnected");
  });
  socket.on("connect_error", (err) => console.log("🔌 Socket connect error:", err.message));
}

/* ===============================
   POLLER
=============================== */
async function startPoller() {
  async function poll() {
    try {
      const body = {};
      const res = await axios.get(`${API_BASE}/kiosk/pending-jobs`, {
        headers: getHeaders(body), timeout: 15000,
      });
      const { jobs } = res.data;
      if (jobs.length > 0) console.log(`🔍 Poller found ${jobs.length} pending job(s)`);
      for (const job of jobs) {
        const expiresAt = Date.now() + 5 * 60 * 1000;
        await preFetchJob(job.job_id, job.file_path, expiresAt);
      }
    } catch (err) {
      console.log("🔍 Poller error:", err.response?.data?.error || err.message);
    }
  }
  await poll();
  setInterval(poll, POLL_INTERVAL);
}

/* ===============================
   PRINT FILE
=============================== */
function printFile(filePath, job) {
  if (!PRINTER_NAME) throw new Error("Printer not ready — not detected yet");
  const copies = job.copies || 1;
  let command;
  if (IS_WINDOWS) {
    const sumatraPath   = `C:\\Program Files\\SumatraPDF\\SumatraPDF.exe`;
    const sumatraPath86 = `C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe`;
    const sumatra = fs.existsSync(sumatraPath) ? sumatraPath
                  : fs.existsSync(sumatraPath86) ? sumatraPath86 : null;
    if (sumatra) {
      const duplexSetting = job.printSide === "duplex" ? ",duplexlong" : "";
      const colorSetting  = job.color === "bw" ? ",monochrome" : ",color";
      command = `"${sumatra}" -print-to "${PRINTER_NAME}" -print-settings "${copies}x${duplexSetting}${colorSetting}" -silent "${filePath}"`;
    } else {
      const adobePath = `C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe`;
      command = fs.existsSync(adobePath)
        ? `"${adobePath}" /t "${filePath}" "${PRINTER_NAME}"`
        : `rundll32 mshtml.dll,PrintHTML "${filePath}"`;
    }
  } else {
    const sides = job.printSide === "duplex" ? "-o sides=two-sided-long-edge" : "-o sides=one-sided";
    const color = job.color === "bw" ? "-o ColorModel=Gray" : "";
    const media = job.paperSize === "A3" ? "-o media=A3" : "-o media=A4";
    command = ["lp", `-d "${PRINTER_NAME}"`, `-n ${copies}`, sides, color, media, `"${filePath}"`].filter(Boolean).join(" ");
  }
  console.log("🖨 Print command:", command);
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err) { console.error("🖨 Print exec error:", err.message); return reject(err); }
      if (stderr) console.log("🖨 Print stderr:", stderr);
      console.log("🖨 Print stdout:", stdout);
      resolve(stdout);
    });
  });
}

/* ===============================
   HEARTBEAT
=============================== */
function startHeartbeat() {
  async function beat() {
    try {
      const body = {
        cpu_usage:   os.loadavg()[0],
        paper_level: 80,
        ink_level:   60,
        status:      "ONLINE",
        printer:     PRINTER_NAME || "NOT_DETECTED",
      };
      await axios.post(`${API_BASE}/kiosk/heartbeat`, body, {
        headers: getHeaders(body), timeout: 10000,
      });
      console.log("💓 Heartbeat sent");
    } catch (err) {
      const status = err.response?.status;
      console.log(`❌ Heartbeat failed (HTTP ${status}):`, err.response?.data || err.message);

      // ✅ FIX: If the server returns 403 Key mismatch during heartbeat,
      // re-register immediately so the next cycle works.
      if (status === 403 || status === 401) {
        console.log("🔄 Auth failure during heartbeat — re-registering...");
        try {
          try { fs.unlinkSync(CONFIG_FILE); } catch {}
          const config = await registerMachine();
          MACHINE_ID = config.MACHINE_ID;
          API_KEY    = config.API_KEY;
          if (config.API_BASE) API_BASE = config.API_BASE;
          console.log("✅ Re-registered successfully — heartbeat will resume next cycle");
        } catch (regErr) {
          console.error("❌ Re-registration during heartbeat failed:", regErr.message);
        }
      }
    }
  }
  beat();
  setInterval(beat, HEARTBEAT_INTERVAL);
}

/* ===============================
   INPUT PARSER
=============================== */
function isOtp(input)     { return /^\d{4}$/.test(input); }
function isQrToken(input) { return /^[a-f0-9]{64}$/i.test(input); }

function parseInput(input) {
  input = input.trim();
  if (input.startsWith("PRINTJOB:")) {
    const token = input.replace("PRINTJOB:", "").trim();
    if (isQrToken(token)) return { qrToken: token };
  }
  if (isOtp(input))     return { otp: input };
  if (isQrToken(input)) return { qrToken: input };
  return null;
}

/* ===============================
   MAIN PRINT FLOW
=============================== */
async function handleInput(input) {
  console.log("📥 Input received:", JSON.stringify(input));
  const payload = parseInput(input);
  if (!payload) {
    console.log("❌ Invalid format — OTP must be 4 digits or 64-char QR token");
    return "❌ Invalid OTP (must be 4 digits)";
  }
  console.log("📤 Parsed payload:", payload);

  let localFilePath = null;
  let jobId         = null;

  try {
    console.log("🔐 Sending unlock request...");
    const unlockRes = await axios.post(
      `${API_BASE}/kiosk/unlock`, payload,
      { headers: getHeaders(payload), timeout: 15000 }
    );
    const job = unlockRes.data;
    jobId = job.jobId;
    console.log("🔓 Job unlocked:", jobId, "| Details:", JSON.stringify(job));

    const cached = getFromCache(jobId);
    if (cached && fs.existsSync(cached)) {
      localFilePath = cached;
      console.log("⚡ Using pre-cached file:", localFilePath);
    } else {
      console.log("⬇️  Cache miss — downloading...");
      localFilePath = await downloadFile(job.filePath, jobId);
      console.log("✅ Downloaded to:", localFilePath);
    }

    if (!fs.existsSync(localFilePath))
      throw new Error(`File not found at: ${localFilePath}`);
    console.log("📄 File ready, size:", fs.statSync(localFilePath).size, "bytes");

    console.log("🖨 Starting print...");
    await printFile(localFilePath, job);
    console.log("🖨 Print job sent successfully");

    const markBody = { jobId };
    await axios.post(`${API_BASE}/kiosk/mark-printed`, markBody, {
      headers: getHeaders(markBody), timeout: 10000,
    });
    console.log("✅ All done:", jobId);
    return "✅ Printed Successfully";

  } catch (err) {
    console.error("❌ HANDLE INPUT ERROR:");
    console.error("   HTTP status :", err.response?.status);
    console.error("   Server msg  :", JSON.stringify(err.response?.data));
    console.error("   Local msg   :", err.message);

    if (jobId) {
      try {
        const failBody = { jobId };
        await axios.post(`${API_BASE}/kiosk/mark-failed`, failBody, {
          headers: getHeaders(failBody), timeout: 10000,
        });
        console.log("⚠️  Job marked FAILED on server");
      } catch (markErr) {
        console.error("❌ Could not mark job failed:", markErr.message);
      }
    }

    const msg = err.response?.data?.error || err.message || "Unknown error";
    return `❌ ${msg}`;

  } finally {
    if (jobId) removeFromCache(jobId);
    if (localFilePath && fs.existsSync(localFilePath)) {
      try { fs.unlinkSync(localFilePath); console.log("🗑️  Local file deleted"); } catch {}
    }
  }
}

/* ===============================
   STATUS
=============================== */
function getStatus() {
  return {
    machineId:    MACHINE_ID,
    apiBase:      API_BASE,
    printer:      PRINTER_NAME || null,
    printerReady: !!PRINTER_NAME,
    cacheSize:    Object.keys(fileCache).length,
    platform:     process.platform,
  };
}

/* ===============================
   MAIN LOOP  (CLI only)
=============================== */
async function mainLoop() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  function ask(q) { return new Promise((resolve) => rl.question(q, resolve)); }
  console.log("\n📟 Ready — enter OTP or scan QR code\n");
  while (true) {
    try {
      const input = await ask("OTP / QR > ");
      if (!input.trim()) continue;
      const result = await handleInput(input.trim());
      console.log("→", result, "\n");
    } catch (err) {
      console.log("❌ Loop error:", err.message);
    }
  }
}

/* ===============================
   START
=============================== */
if (require.main === module) {
  (async () => {
    ensureDir(); loadCache();
    await initMachine();
    await ensurePrinter();
    startHeartbeat();
    connectSocket();
    await startPoller();
    mainLoop();
  })();
} else {
  (async () => {
    ensureDir(); loadCache();
    await initMachine();
    await ensurePrinter();
    startHeartbeat();
    connectSocket();
    await startPoller();
  })();
}

module.exports = { handleInput, getStatus };
// =================================================================================================================================================================================
// // kioskCore.js — Raspberry Pi Ready — Option C (Hybrid: Socket + Disk Cache)
// const axios        = require("axios");
// const fs           = require("fs");
// const path         = require("path");
// const { exec }     = require("child_process");
// const crypto       = require("crypto");
// const os           = require("os");
// const readline     = require("readline");
// const { io: socketIO } = require("socket.io-client");

// /* ===============================
//    CONFIG
//    ✅ Pi-ready: absolute paths used so the app works
//    regardless of which directory you launch it from.
//    Change PROJECT_ROOT if your folder name is different.
// =============================== */
// const IS_PI      = process.platform === "linux";
// const IS_WINDOWS = process.platform === "win32";

// // ✅ Set this to your actual project folder on the Pi
// const PROJECT_ROOT = IS_PI
//   ? "/home/pi/kiosk"          // ← Pi path  (change if folder name differs)
//   : path.resolve(__dirname);     // ← Laptop: use wherever the file actually is

// const FALLBACK_API_BASE  = "https://printdemo-production.up.railway.app/api"; // laptop server IP — first boot only
// const CONFIG_FILE        = path.join(PROJECT_ROOT, "config.json");
// const DOWNLOAD_DIR       = path.join(PROJECT_ROOT, "kiosk", "files");
// const CACHE_FILE         = path.join(PROJECT_ROOT, "kiosk", "jobs.json");
// const HEARTBEAT_INTERVAL = 30000;
// const POLL_INTERVAL      = 30000;

// /* ===============================
//    LOAD API_BASE FROM CONFIG FIRST
//    ✅ Reads saved IP from config.json before anything else.
//    Falls back to FALLBACK_API_BASE only on very first boot
//    when config.json does not exist yet.
//    After first registration, correct IP is saved automatically
//    and used on every future boot — no hardcoding needed.
// =============================== */
// function getApiBase() {
//   try {
//     if (fs.existsSync(CONFIG_FILE)) {
//       const raw = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//       if (raw) {
//         const config = JSON.parse(raw);
//         if (config.API_BASE) {
//           console.log("🌐 API_BASE loaded from config:", config.API_BASE);
//           return config.API_BASE;
//         }
//       }
//     }
//   } catch (err) {
//     console.warn("⚠️  Could not read API_BASE from config, using fallback:", err.message);
//   }
//   console.log("🌐 API_BASE using fallback (first boot):", FALLBACK_API_BASE);
//   return FALLBACK_API_BASE;
// }

// // ✅ API_BASE is resolved immediately — correct on every boot
// let API_BASE = getApiBase();

// /* ===============================
//    GLOBALS
// =============================== */
// let MACHINE_ID   = null;
// let API_KEY      = null;
// let PRINTER_NAME = null;

// let fileCache = {};

// /* ===============================
//    CACHE HELPERS  (disk-persisted)
// =============================== */
// function loadCache() {
//   try {
//     if (!fs.existsSync(CACHE_FILE)) return;
//     const raw = fs.readFileSync(CACHE_FILE, "utf-8").trim();
//     if (!raw) return;
//     fileCache = JSON.parse(raw);
//     const now = Date.now();
//     for (const jobId of Object.keys(fileCache)) {
//       if (fileCache[jobId].expires < now) {
//         safeDelete(fileCache[jobId].filePath);
//         delete fileCache[jobId];
//       }
//     }
//     console.log(`📦 Cache loaded: ${Object.keys(fileCache).length} job(s)`);
//   } catch (err) {
//     console.error("Cache load error:", err.message);
//     fileCache = {};
//   }
// }

// function saveCache() {
//   try {
//     fs.writeFileSync(CACHE_FILE, JSON.stringify(fileCache, null, 2));
//   } catch (err) {
//     console.error("Cache save error:", err.message);
//   }
// }

// function addToCache(jobId, filePath, expiresAt) {
//   fileCache[jobId] = { filePath, expires: new Date(expiresAt).getTime() };
//   saveCache();
// }

// function getFromCache(jobId) {
//   const entry = fileCache[jobId];
//   if (!entry) return null;
//   if (entry.expires < Date.now()) {
//     safeDelete(entry.filePath);
//     delete fileCache[jobId];
//     saveCache();
//     return null;
//   }
//   return entry.filePath;
// }

// function removeFromCache(jobId) {
//   delete fileCache[jobId];
//   saveCache();
// }

// function safeDelete(filePath) {
//   if (filePath && fs.existsSync(filePath)) {
//     try { fs.unlinkSync(filePath); } catch {}
//   }
// }

// /* ===============================
//    ENSURE DIRS
// =============================== */
// function ensureDir() {
//   [DOWNLOAD_DIR, path.dirname(CACHE_FILE)].forEach(dir => {
//     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
//   });
// }

// /* ===============================
//    DEVICE SERIAL  (MAC address)
//    ✅ Sent to server during registration.
//    Server uses this to look up machine_id (e.g. "MH1000").
//    NOT used as MACHINE_ID in API requests — server's ID is used.
// =============================== */
// function getDeviceSerial() {
//   const interfaces = os.networkInterfaces();
//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
//         return iface.mac;
//       }
//     }
//   }
//   return os.hostname(); // fallback if no valid MAC found
// }

// /* ===============================
//    REGISTER MACHINE
//    ✅ Sends MAC to server → server returns MACHINE_ID ("MH1000"),
//    API_KEY, and API_BASE. We save all of them to config.json.
//    MACHINE_ID comes from server — never the MAC address.

//    Server response: { MACHINE_ID: "MH1000", API_KEY: "...", API_BASE: "..." }
// =============================== */
// async function registerMachine() {
//   console.log("🔄 Registering machine...");
//   const deviceSerial = getDeviceSerial();
//   console.log("🔑 Device serial (MAC):", deviceSerial);

//   const res = await axios.post(`${API_BASE}/register-machine`, { deviceSerial });
//   console.log("📡 Server registration response:", JSON.stringify(res.data));

//   // ✅ Accept all casing variants — server sends UPPERCASE
//   const machineId = res.data.MACHINE_ID    // ← your server sends this
//                  || res.data.machine_id    // snake_case fallback
//                  || res.data.machineId;    // camelCase fallback

//   if (!machineId) {
//     throw new Error(
//       `Server did not return MACHINE_ID. Got keys: ${Object.keys(res.data).join(", ")}. ` +
//       `Full response: ${JSON.stringify(res.data)}`
//     );
//   }

//   const apiKey  = res.data.API_KEY  || res.data.api_key  || res.data.apiKey;
//   const apiBase = res.data.API_BASE || res.data.api_base || res.data.apiBase || API_BASE;

//   if (!apiKey) {
//     throw new Error(
//       `Server did not return API_KEY. Got keys: ${Object.keys(res.data).join(", ")}`
//     );
//   }

//   const fullConfig = {
//     MACHINE_ID:    machineId,     // ✅ "MH1000" — used in all API requests
//     DEVICE_SERIAL: deviceSerial,  // MAC — reference only
//     API_KEY:       apiKey,
//     API_BASE:      apiBase,       // ✅ saved so next boot reads correct IP
//     PRINTER_NAME:  null,          // filled later by ensurePrinter()
//   };

//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(fullConfig, null, 2));
//   console.log("✅ Machine registered — MACHINE_ID:", machineId);
//   console.log("💾 Config saved to:", CONFIG_FILE);
//   return fullConfig;
// }

// /* ===============================
//    LOAD CONFIG
// =============================== */
// function loadConfig() {
//   try {
//     if (!fs.existsSync(CONFIG_FILE)) return null;
//     const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//     if (!data) return null;
//     return JSON.parse(data);
//   } catch {
//     try { fs.unlinkSync(CONFIG_FILE); } catch {}
//     return null;
//   }
// }

// /* ===============================
//    SAVE CONFIG HELPER
//    ✅ Always merges into existing config — never loses fields.
// =============================== */
// function saveConfig(updates) {
//   const current = loadConfig() || {};
//   const merged  = { ...current, ...updates };
//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
// }

// /* ===============================
//    INIT MACHINE
// =============================== */
// async function initMachine() {
//   try {
//     let config = loadConfig();

//     // ✅ Re-register if config is missing, incomplete, or has old MAC-based MACHINE_ID
//     const isMacAddress = config?.MACHINE_ID &&
//       /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(config.MACHINE_ID);

//     const isValid = config
//       && config.API_KEY
//       && config.MACHINE_ID
//       && !isMacAddress;

//     if (!isValid) {
//       if (isMacAddress) {
//         console.log("⚠️  Old config — MACHINE_ID is a MAC address. Re-registering to get server ID...");
//       } else {
//         console.log("⚠️  Config missing or incomplete — registering...");
//       }
//       try { fs.unlinkSync(CONFIG_FILE); } catch {}
//       config = await registerMachine();
//     }

//     MACHINE_ID = config.MACHINE_ID;
//     API_KEY    = config.API_KEY;

//     if (config.API_BASE) {
//       API_BASE = config.API_BASE;
//     }

//     console.log("✅ Machine Ready");
//     console.log("   MACHINE_ID :", MACHINE_ID);
//     console.log("   API_BASE   :", API_BASE);
//     console.log("   Platform   :", process.platform, IS_PI ? "(Raspberry Pi)" : "(Laptop/Dev)");
//     console.log("   Config     :", CONFIG_FILE);
//   } catch (err) {
//     console.error("❌ Init failed:", err.message);
//     process.exit(1);
//   }
// }

// /* ===============================
//    SECURITY — SIGN REQUEST
// =============================== */
// function signRequest(body) {
//   const timestamp  = Date.now().toString();
//   const bodyString = JSON.stringify(body || {});
//   const signature  = crypto
//     .createHmac("sha256", API_KEY)
//     .update(MACHINE_ID + timestamp + bodyString)
//     .digest("hex");
//   return { timestamp, signature };
// }

// function getHeaders(body) {
//   const auth = signRequest(body);
//   return {
//     "X-Machine-Id": MACHINE_ID,
//     "X-Api-Key":    API_KEY,
//     "X-Timestamp":  auth.timestamp,
//     "X-Signature":  auth.signature,
//   };
// }

// /* ===============================
//    PRINTER DETECTION
//    ✅ lpstat -p is Linux/CUPS — works on Raspberry Pi.
//    On Windows (laptop dev) it is skipped gracefully.
//    Printer is auto-detected and saved to config on Pi.
// =============================== */
// function detectPrinter() {
//   return new Promise((resolve, reject) => {
//     exec("lpstat -p", (err, stdout) => {
//       if (err) return reject(new Error(`lpstat failed: ${err.message}`));
//       const match = stdout.match(/printer\s+(\S+)/);
//       if (match) return resolve(match[1]);
//       reject(new Error("No printer found in lpstat output"));
//     });
//   });
// }

// async function ensurePrinter() {
//   const config = loadConfig();

//   // ✅ If already saved in config, use it — no detection needed
//   if (config?.PRINTER_NAME) {
//     PRINTER_NAME = config.PRINTER_NAME;
//     console.log("✅ Printer loaded from config:", PRINTER_NAME);
//     return;
//   }

//   // ✅ Skip on Windows — lpstat not available, Pi will handle it
//   if (IS_WINDOWS) {
//     console.log("⚠️  Windows detected — skipping printer detection");
//     console.log("💡 Printer auto-detected when running on Raspberry Pi");
//     return;
//   }

//   // ✅ On Pi / Linux — detect and save
//   try {
//     PRINTER_NAME = await detectPrinter();
//     console.log("✅ Printer detected:", PRINTER_NAME);
//     saveConfig({ PRINTER_NAME });   // merges into config — no other fields lost
//     console.log("💾 Printer saved to config");
//   } catch (err) {
//     console.log("⚠️  No printer detected:", err.message);
//     console.log("🔄 Retrying in 5s...");
//     setTimeout(ensurePrinter, 5000);
//   }
// }

// /* ===============================
//    DOWNLOAD FILE
// =============================== */
// async function downloadFile(fileUrl, jobId = null) {
//   let url;

//   if (fileUrl.startsWith("http")) {
//     url = fileUrl;
//   } else {
//     const filename = fileUrl.includes("\\")
//       ? fileUrl.split("\\").pop()
//       : fileUrl.split("/").pop();
//     url = `${API_BASE.replace("/api", "")}/uploads/${filename}`;
//   }

//   console.log("⬇️  Downloading from URL:", url);

//   const filename = jobId ? `${jobId}.pdf` : `${Date.now()}.pdf`;
//   const filePath = path.join(DOWNLOAD_DIR, filename);

//   const response = await axios({
//     url,
//     method:       "GET",
//     responseType: "arraybuffer",
//     timeout:      30000,   // 30s — important for slow Pi connections
//   });

//   fs.writeFileSync(filePath, Buffer.from(response.data));
//   console.log("✅ File written to:", filePath);

//   return filePath;
// }

// /* ===============================
//    PRE-FETCH
// =============================== */
// async function preFetchJob(jobId, filePath, expiresAt) {
//   const cached = getFromCache(jobId);
//   if (cached && fs.existsSync(cached)) {
//     console.log(`📦 Already cached: ${jobId}`);
//     return;
//   }

//   try {
//     console.log(`⬇️  Pre-fetching: ${jobId}`);
//     const localPath = await downloadFile(filePath, jobId);
//     addToCache(jobId, localPath, expiresAt);
//     console.log(`✅ Cached: ${jobId} → ${localPath}`);
//   } catch (err) {
//     console.error(`❌ Pre-fetch failed for ${jobId}:`, err.message);
//   }
// }

// /* ===============================
//    SOCKET
// =============================== */
// function connectSocket() {
//   const serverBase = API_BASE.replace("/api", "");
//   const socket = socketIO(serverBase, {
//     reconnection:         true,
//     reconnectionDelay:    3000,
//     reconnectionDelayMax: 10000,
//   });

//   socket.on("connect", () => {
//     console.log("🔌 Socket connected to", serverBase);
//     if (typeof global.onSocketStatus === "function") {
//       global.onSocketStatus("connected");
//     }
//   });

//   socket.on("payment_success", ({ jobId, machineId, filePath }) => {
//     if (machineId !== MACHINE_ID) return;
//     const expiresAt = Date.now() + 5 * 60 * 1000;
//     console.log(`💳 Payment received for ${jobId} — pre-fetching...`);
//     preFetchJob(jobId, filePath, expiresAt);
//   });

//   socket.on("disconnect", (reason) => {
//     console.log("🔌 Socket disconnected:", reason);
//     if (typeof global.onSocketStatus === "function") {
//       global.onSocketStatus("disconnected");
//     }
//   });

//   socket.on("connect_error", (err) => {
//     console.log("🔌 Socket connect error:", err.message);
//   });
// }

// /* ===============================
//    POLLER
// =============================== */
// async function startPoller() {
//   async function poll() {
//     try {
//       const body = {};
//       const res = await axios.get(`${API_BASE}/kiosk/pending-jobs`, {
//         headers: getHeaders(body),
//         timeout: 15000,
//       });

//       const { jobs } = res.data;
//       if (jobs.length > 0) {
//         console.log(`🔍 Poller found ${jobs.length} pending job(s)`);
//       }

//       for (const job of jobs) {
//         const expiresAt = Date.now() + 5 * 60 * 1000;
//         await preFetchJob(job.job_id, job.file_path, expiresAt);
//       }
//     } catch (err) {
//       console.log("🔍 Poller error:", err.response?.data?.error || err.message);
//     }
//   }

//   await poll();
//   setInterval(poll, POLL_INTERVAL);
// }

// /* ===============================
//    PRINT FILE — cross-platform
//    ✅ Windows → SumatraPDF (silent print)
//    ✅ Linux/Pi → CUPS lp command
// =============================== */
// function printFile(filePath, job) {
//   if (!PRINTER_NAME) throw new Error("Printer not ready — not detected yet");

//   const copies = job.copies || 1;
//   let command;

//   if (IS_WINDOWS) {
//     // ── WINDOWS ───────────────────────────────────────────────
//     const sumatraPath   = `C:\\Program Files\\SumatraPDF\\SumatraPDF.exe`;
//     const sumatraPath86 = `C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe`;

//     const sumatra = fs.existsSync(sumatraPath)
//       ? sumatraPath
//       : fs.existsSync(sumatraPath86)
//         ? sumatraPath86
//         : null;

//     if (sumatra) {
//       const duplexSetting = job.printSide === "duplex" ? ",duplexlong" : "";
//       const colorSetting  = job.color     === "bw"     ? ",monochrome" : ",color";
//       const printSettings = `${copies}x${duplexSetting}${colorSetting}`;
//       command = `"${sumatra}" -print-to "${PRINTER_NAME}" -print-settings "${printSettings}" -silent "${filePath}"`;
//     } else {
//       console.warn("⚠️  SumatraPDF not found — using Windows built-in fallback");
//       const adobePath = `C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe`;
//       command = fs.existsSync(adobePath)
//         ? `"${adobePath}" /t "${filePath}" "${PRINTER_NAME}"`
//         : `rundll32 mshtml.dll,PrintHTML "${filePath}"`;
//     }

//   } else {
//     // ── LINUX / RASPBERRY PI — CUPS ───────────────────────────
//     const sides = job.printSide === "duplex"
//       ? "-o sides=two-sided-long-edge"
//       : "-o sides=one-sided";
//     const color = job.color     === "bw"  ? "-o ColorModel=Gray" : "";
//     const media = job.paperSize === "A3"  ? "-o media=A3"        : "-o media=A4";

//     command = [
//       "lp",
//       `-d "${PRINTER_NAME}"`,
//       `-n ${copies}`,
//       sides,
//       color,
//       media,
//       `"${filePath}"`,
//     ].filter(Boolean).join(" ");
//   }

//   console.log("🖨 Print command:", command);

//   return new Promise((resolve, reject) => {
//     exec(command, (err, stdout, stderr) => {
//       if (err) {
//         console.error("🖨 Print exec error:", err.message);
//         return reject(err);
//       }
//       if (stderr) console.log("🖨 Print stderr:", stderr);
//       console.log("🖨 Print stdout:", stdout);
//       resolve(stdout);
//     });
//   });
// }

// /* ===============================
//    HEARTBEAT
// =============================== */
// function startHeartbeat() {
//   async function beat() {
//     try {
//       const body = {
//         cpu_usage:   os.loadavg()[0],
//         paper_level: 80,
//         ink_level:   60,
//         status:      "ONLINE",
//         printer:     PRINTER_NAME || "NOT_DETECTED",
//       };
//       await axios.post(`${API_BASE}/kiosk/heartbeat`, body, {
//         headers: getHeaders(body),
//         timeout: 10000,
//       });
//       console.log("💓 Heartbeat sent");
//     } catch (err) {
//       console.log("❌ Heartbeat failed:", err.response?.data || err.message);
//     }
//   }

//   beat(); // send one immediately on start
//   setInterval(beat, HEARTBEAT_INTERVAL);
// }

// /* ===============================
//    INPUT PARSER
// =============================== */
// function isOtp(input)     { return /^\d{4}$/.test(input); }
// function isQrToken(input) { return /^[a-f0-9]{64}$/i.test(input); }

// function parseInput(input) {
//   input = input.trim();
//   if (input.startsWith("PRINTJOB:")) {
//     const token = input.replace("PRINTJOB:", "").trim();
//     if (isQrToken(token)) return { qrToken: token };
//   }
//   if (isOtp(input))     return { otp: input };
//   if (isQrToken(input)) return { qrToken: input };
//   return null;
// }

// /* ===============================
//    MAIN PRINT FLOW  ← exported for Electron
// =============================== */
// async function handleInput(input) {
//   console.log("📥 Input received:", JSON.stringify(input));

//   const payload = parseInput(input);
//   if (!payload) {
//     console.log("❌ Invalid format — OTP must be exactly 4 digits or a 64-char QR token");
//     return "❌ Invalid OTP (must be 4 digits)";
//   }

//   console.log("📤 Parsed payload:", payload);

//   let localFilePath = null;
//   let jobId         = null;

//   try {
//     // STEP 1 — Verify OTP/QR with server
//     console.log("🔐 Sending unlock request...");
//     const unlockRes = await axios.post(
//       `${API_BASE}/kiosk/unlock`,
//       payload,
//       { headers: getHeaders(payload), timeout: 15000 }
//     );
//     const job = unlockRes.data;
//     jobId = job.jobId;
//     console.log("🔓 Job unlocked:", jobId, "| Details:", JSON.stringify(job));

//     // STEP 2 — Use cached file or download fresh
//     const cached = getFromCache(jobId);
//     if (cached && fs.existsSync(cached)) {
//       localFilePath = cached;
//       console.log("⚡ Using pre-cached file:", localFilePath);
//     } else {
//       console.log("⬇️  Cache miss — downloading...");
//       localFilePath = await downloadFile(job.filePath, jobId);
//       console.log("✅ Downloaded to:", localFilePath);
//     }

//     if (!fs.existsSync(localFilePath)) {
//       throw new Error(`File not found at: ${localFilePath}`);
//     }
//     console.log("📄 File ready, size:", fs.statSync(localFilePath).size, "bytes");

//     // STEP 3 — Print
//     console.log("🖨 Starting print...");
//     await printFile(localFilePath, job);
//     console.log("🖨 Print job sent successfully");

//     // STEP 4 — Mark printed on server
//     const markBody = { jobId };
//     await axios.post(`${API_BASE}/kiosk/mark-printed`, markBody, {
//       headers: getHeaders(markBody),
//       timeout: 10000,
//     });

//     console.log("✅ All done:", jobId);
//     return "✅ Printed Successfully";

//   } catch (err) {
//     console.error("❌ HANDLE INPUT ERROR:");
//     console.error("   HTTP status :", err.response?.status);
//     console.error("   Server msg  :", JSON.stringify(err.response?.data));
//     console.error("   Local msg   :", err.message);

//     if (jobId) {
//       try {
//         const failBody = { jobId };
//         await axios.post(`${API_BASE}/kiosk/mark-failed`, failBody, {
//           headers: getHeaders(failBody),
//           timeout: 10000,
//         });
//         console.log("⚠️  Job marked FAILED on server");
//       } catch (markErr) {
//         console.error("❌ Could not mark job failed:", markErr.message);
//       }
//     }

//     const msg = err.response?.data?.error || err.message || "Unknown error";
//     return `❌ ${msg}`;

//   } finally {
//     // ✅ Always runs — file deleted whether print succeeded or failed
//     if (jobId) removeFromCache(jobId);
//     if (localFilePath && fs.existsSync(localFilePath)) {
//       try { fs.unlinkSync(localFilePath); console.log("🗑️  Local file deleted"); } catch {}
//     }
//   }
// }

// /* ===============================
//    STATUS — exported for Electron renderer
// =============================== */
// function getStatus() {
//   return {
//     machineId:    MACHINE_ID,
//     apiBase:      API_BASE,
//     printer:      PRINTER_NAME || null,
//     printerReady: !!PRINTER_NAME,
//     cacheSize:    Object.keys(fileCache).length,
//     platform:     process.platform,
//   };
// }

// /* ===============================
//    MAIN LOOP  (CLI only — not used in Electron)
// =============================== */
// async function mainLoop() {
//   const rl = readline.createInterface({
//     input:  process.stdin,
//     output: process.stdout,
//   });

//   function ask(q) {
//     return new Promise((resolve) => rl.question(q, resolve));
//   }

//   console.log("\n📟 Ready — enter OTP or scan QR code\n");

//   while (true) {
//     try {
//       const input = await ask("OTP / QR > ");
//       if (!input.trim()) continue;
//       const result = await handleInput(input.trim());
//       console.log("→", result, "\n");
//     } catch (err) {
//       console.log("❌ Loop error:", err.message);
//     }
//   }
// }

// /* ===============================
//    START
// =============================== */
// if (require.main === module) {
//   // Running directly via: node kioskCore.js
//   (async () => {
//     ensureDir();
//     loadCache();
//     await initMachine();
//     await ensurePrinter();
//     startHeartbeat();
//     connectSocket();
//     await startPoller();
//     mainLoop();
//   })();
// } else {
//   // ✅ Required as a module by Electron (index.js) — mainLoop() NOT called
//   (async () => {
//     ensureDir();
//     loadCache();
//     await initMachine();
//     await ensurePrinter();
//     startHeartbeat();
//     connectSocket();
//     await startPoller();
//   })();
// }

// // ✅ Exports for Electron preload.js
// module.exports = { handleInput, getStatus };


// =======================================================================================================================================================================================
// // kioskCore.js — Laptop/Pi compatible — Option C (Hybrid: Socket + Disk Cache)
// const axios        = require("axios");
// const fs           = require("fs");
// const path         = require("path");
// const { exec }     = require("child_process");
// const crypto       = require("crypto");
// const os           = require("os");
// const readline     = require("readline");
// const { io: socketIO } = require("socket.io-client");

// /* ===============================
//    CONFIG
// =============================== */
// const FALLBACK_API_BASE  = "http://192.168.0.106:5000/api";

// // ✅ FIXED: Absolute paths for Raspberry Pi
// const CONFIG_FILE        = "/home/pi/kiosk/config.json";
// const DOWNLOAD_DIR       = "/home/pi/kiosk/files";
// const CACHE_FILE         = "/home/pi/kiosk/jobs.json";

// const HEARTBEAT_INTERVAL = 30000;
// const POLL_INTERVAL      = 30000;

// /* ===============================
//    LOAD API_BASE FROM CONFIG FIRST
// =============================== */
// function getApiBase() {
//   try {
//     if (fs.existsSync(CONFIG_FILE)) {
//       const raw = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//       if (raw) {
//         const config = JSON.parse(raw);
//         if (config.API_BASE) {
//           console.log("🌐 API_BASE loaded from config:", config.API_BASE);
//           return config.API_BASE;
//         }
//       }
//     }
//   } catch (err) {
//     console.warn("⚠️  Could not read API_BASE from config, using fallback:", err.message);
//   }
//   console.log("🌐 API_BASE using fallback (first boot):", FALLBACK_API_BASE);
//   return FALLBACK_API_BASE;
// }

// let API_BASE = getApiBase();

// /* ===============================
//    GLOBALS
// =============================== */
// let MACHINE_ID   = null;
// let API_KEY      = null;
// let PRINTER_NAME = null;

// let fileCache = {};

// /* ===============================
//    CACHE HELPERS
// =============================== */
// function loadCache() {
//   try {
//     if (!fs.existsSync(CACHE_FILE)) return;
//     const raw = fs.readFileSync(CACHE_FILE, "utf-8").trim();
//     if (!raw) return;
//     fileCache = JSON.parse(raw);
//     const now = Date.now();
//     for (const jobId of Object.keys(fileCache)) {
//       if (fileCache[jobId].expires < now) {
//         safeDelete(fileCache[jobId].filePath);
//         delete fileCache[jobId];
//       }
//     }
//     console.log(`📦 Cache loaded: ${Object.keys(fileCache).length} job(s)`);
//   } catch (err) {
//     console.error("Cache load error:", err.message);
//     fileCache = {};
//   }
// }

// function saveCache() {
//   try {
//     fs.writeFileSync(CACHE_FILE, JSON.stringify(fileCache, null, 2));
//   } catch (err) {
//     console.error("Cache save error:", err.message);
//   }
// }

// function addToCache(jobId, filePath, expiresAt) {
//   fileCache[jobId] = { filePath, expires: new Date(expiresAt).getTime() };
//   saveCache();
// }

// function getFromCache(jobId) {
//   const entry = fileCache[jobId];
//   if (!entry) return null;
//   if (entry.expires < Date.now()) {
//     safeDelete(entry.filePath);
//     delete fileCache[jobId];
//     saveCache();
//     return null;
//   }
//   return entry.filePath;
// }

// function removeFromCache(jobId) {
//   delete fileCache[jobId];
//   saveCache();
// }

// function safeDelete(filePath) {
//   if (filePath && fs.existsSync(filePath)) {
//     try { fs.unlinkSync(filePath); } catch {}
//   }
// }

// /* ===============================
//    ENSURE DIRS
// =============================== */
// function ensureDir() {
//   [DOWNLOAD_DIR, path.dirname(CACHE_FILE)].forEach(dir => {
//     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
//   });
// }

// /* ===============================
//    DEVICE ID
// =============================== */
// function getDeviceId() {
//   const interfaces = os.networkInterfaces();
//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
//         return iface.mac;
//       }
//     }
//   }
//   return os.hostname();
// }

// /* ===============================
//    REGISTER MACHINE
// =============================== */
// async function registerMachine() {
//   console.log("🔄 Registering machine...");
//   const deviceSerial = getDeviceId();
//   console.log("🔑 Device serial (MAC):", deviceSerial);

//   const res = await axios.post(`${API_BASE}/register-machine`, { deviceSerial });

//   const machineId = res.data.MACHINE_ID
//                || res.data.machine_id
//                || res.data.machineId;

//   if (!machineId) {
//     throw new Error(`Server did not return machine_id`);
//   }

//   const apiKey  = res.data.API_KEY  || res.data.api_key  || res.data.apiKey;
//   const apiBase = res.data.API_BASE || API_BASE;

//   const fullConfig = {
//     MACHINE_ID: machineId,
//     DEVICE_SERIAL: deviceSerial,
//     API_KEY: apiKey,
//     API_BASE: apiBase,
//     PRINTER_NAME: null,
//   };

//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(fullConfig, null, 2));
//   return fullConfig;
// }

// /* ===============================
//    LOAD CONFIG
// =============================== */
// function loadConfig() {
//   try {
//     if (!fs.existsSync(CONFIG_FILE)) return null;
//     const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//     if (!data) return null;
//     return JSON.parse(data);
//   } catch {
//     try { fs.unlinkSync(CONFIG_FILE); } catch {}
//     return null;
//   }
// }

// /* ===============================
//    SAVE CONFIG
// =============================== */
// function saveConfig(updates) {
//   const current = loadConfig() || {};
//   const merged  = { ...current, ...updates };
//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
// }

// /* ===============================
//    INIT MACHINE
// =============================== */
// async function initMachine() {
//   try {
//     let config = loadConfig();

//     if (!config || !config.API_KEY || !config.MACHINE_ID) {
//       try { fs.unlinkSync(CONFIG_FILE); } catch {}
//       config = await registerMachine();
//     }

//     MACHINE_ID = config.MACHINE_ID;
//     API_KEY    = config.API_KEY;

//     if (config.API_BASE) {
//       API_BASE = config.API_BASE;
//     }

//     console.log("✅ Machine Ready:", MACHINE_ID);
//   } catch (err) {
//     console.error("❌ Init failed:", err.message);
//     process.exit(1);
//   }
// }

// /* ===============================
//    HEARTBEAT (unchanged except note)
// =============================== */
// function startHeartbeat() {
//   async function beat() {
//     try {
//       const body = {
//         cpu_usage: os.loadavg()[0],
//         paper_level: 80, // TODO: replace with sensor later
//         ink_level: 60,
//         status: "ONLINE",
//         printer: PRINTER_NAME || "NOT_DETECTED",
//       };
//       await axios.post(`${API_BASE}/kiosk/heartbeat`, body, {
//         headers: getHeaders(body),
//         timeout: 10000,
//       });
//       console.log("💓 Heartbeat sent");
//     } catch (err) {
//       console.log("❌ Heartbeat failed:", err.message);
//     }
//   }

//   beat();
//   setInterval(beat, HEARTBEAT_INTERVAL);
// }

// /* ===============================
//    START
// =============================== */
// if (require.main === module) {
//   (async () => {
//     ensureDir();
//     loadCache();
//     await initMachine();
//     await ensurePrinter();
//     startHeartbeat();
//     connectSocket();
//     await startPoller();
//     mainLoop();
//   })();
// } else {
//   (async () => {
//     ensureDir();
//     loadCache();
//     await initMachine();
//     await ensurePrinter();
//     startHeartbeat();
//     connectSocket();
//     await startPoller();
//   })();
// }

// module.exports = { handleInput, getStatus };

// // kioskCore.js — Laptop/Pi compatible — Option C (Hybrid: Socket + Disk Cache)
// const axios        = require("axios");
// const fs           = require("fs");
// const path         = require("path");
// const { exec }     = require("child_process");
// const crypto       = require("crypto");
// const os           = require("os");
// const readline     = require("readline");
// const { io: socketIO } = require("socket.io-client");

// /* ===============================
//    CONFIG
// =============================== */
// const FALLBACK_API_BASE  = "http://192.168.0.106:5000/api"; // ✅ used ONLY on very first boot
// const CONFIG_FILE        = "./config.json";
// const DOWNLOAD_DIR       = "./kiosk/files";
// const CACHE_FILE         = "./kiosk/jobs.json";
// const HEARTBEAT_INTERVAL = 30000;
// const POLL_INTERVAL      = 30000;

// /* ===============================
//    LOAD API_BASE FROM CONFIG FIRST
//    ✅ Runs before anything else so API_BASE is always correct
//    from the very first line — no more localhost / wrong IP issue.
//    Falls back to FALLBACK_API_BASE only on first ever boot
//    when config.json does not exist yet.
//    After first registration, API_BASE is saved in config.json
//    and loaded automatically on every future boot.
// =============================== */
// function getApiBase() {
//   try {
//     if (fs.existsSync(CONFIG_FILE)) {
//       const raw = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//       if (raw) {
//         const config = JSON.parse(raw);
//         if (config.API_BASE) {
//           console.log("🌐 API_BASE loaded from config:", config.API_BASE);
//           return config.API_BASE;
//         }
//       }
//     }
//   } catch (err) {
//     console.warn("⚠️  Could not read API_BASE from config, using fallback:", err.message);
//   }
//   console.log("🌐 API_BASE using fallback (first boot):", FALLBACK_API_BASE);
//   return FALLBACK_API_BASE;
// }

// // ✅ API_BASE is set once here — correct on every boot automatically
// let API_BASE = getApiBase();

// /* ===============================
//    GLOBALS
// =============================== */
// let MACHINE_ID   = null;
// let API_KEY      = null;
// let PRINTER_NAME = null;

// let fileCache = {};

// /* ===============================
//    CACHE HELPERS  (disk-persisted)
// =============================== */
// function loadCache() {
//   try {
//     if (!fs.existsSync(CACHE_FILE)) return;
//     const raw = fs.readFileSync(CACHE_FILE, "utf-8").trim();
//     if (!raw) return;
//     fileCache = JSON.parse(raw);
//     const now = Date.now();
//     for (const jobId of Object.keys(fileCache)) {
//       if (fileCache[jobId].expires < now) {
//         safeDelete(fileCache[jobId].filePath);
//         delete fileCache[jobId];
//       }
//     }
//     console.log(`📦 Cache loaded: ${Object.keys(fileCache).length} job(s)`);
//   } catch (err) {
//     console.error("Cache load error:", err.message);
//     fileCache = {};
//   }
// }

// function saveCache() {
//   try {
//     fs.writeFileSync(CACHE_FILE, JSON.stringify(fileCache, null, 2));
//   } catch (err) {
//     console.error("Cache save error:", err.message);
//   }
// }

// function addToCache(jobId, filePath, expiresAt) {
//   fileCache[jobId] = { filePath, expires: new Date(expiresAt).getTime() };
//   saveCache();
// }

// function getFromCache(jobId) {
//   const entry = fileCache[jobId];
//   if (!entry) return null;
//   if (entry.expires < Date.now()) {
//     safeDelete(entry.filePath);
//     delete fileCache[jobId];
//     saveCache();
//     return null;
//   }
//   return entry.filePath;
// }

// function removeFromCache(jobId) {
//   delete fileCache[jobId];
//   saveCache();
// }

// function safeDelete(filePath) {
//   if (filePath && fs.existsSync(filePath)) {
//     try { fs.unlinkSync(filePath); } catch {}
//   }
// }

// /* ===============================
//    ENSURE DIRS
// =============================== */
// function ensureDir() {
//   [DOWNLOAD_DIR, path.dirname(CACHE_FILE)].forEach(dir => {
//     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
//   });
// }

// /* ===============================
//    DEVICE ID
// =============================== */
// function getDeviceId() {
//   const interfaces = os.networkInterfaces();
//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
//         return iface.mac;
//       }
//     }
//   }
//   // Fallback: use hostname if no valid MAC found
//   return os.hostname();
// }

// /* ===============================
//    REGISTER MACHINE
//    MACHINE_ID is computed locally from MAC address.
//    Server returns API_KEY + API_BASE.
//    We merge MACHINE_ID into the saved config ourselves.
// =============================== */
// async function registerMachine() {
//   console.log("🔄 Registering machine...");
//   const deviceSerial = getDeviceId();
//   console.log("🔑 Device serial (MAC):", deviceSerial);
 
//   const res = await axios.post(`${API_BASE}/register-machine`, { deviceSerial });
 
//   console.log("📡 Server registration response:", JSON.stringify(res.data));
 
//   // ✅ MACHINE_ID must come from server (e.g. "MH1000"), not the MAC address
//   const machineId = res.data.MACHINE_ID    // ← your server sends THIS
//                || res.data.machine_id
//                || res.data.machineId;
 
//   if (!machineId) {
//     // Log exactly what server sent so you can debug field name easily
//     throw new Error(
//       `Server did not return machine_id. Got keys: ${Object.keys(res.data).join(", ")}. ` +
//       `Full response: ${JSON.stringify(res.data)}`
//     );
//   }
 
//   const apiKey  = res.data.API_KEY  || res.data.api_key  || res.data.apiKey;
//   const apiBase = res.data.API_BASE || res.data.api_base || res.data.apiBase || API_BASE;
 
//   if (!apiKey) {
//     throw new Error(
//       `Server did not return API_KEY. Got keys: ${Object.keys(res.data).join(", ")}`
//     );
//   }
 
//   const fullConfig = {
//     MACHINE_ID:   machineId,    // ✅ "MH1000" from server — used in all API requests
//     DEVICE_SERIAL: deviceSerial, // MAC address — saved for reference only
//     API_KEY:      apiKey,
//     API_BASE:     apiBase,
//     PRINTER_NAME: null,          // filled later by ensurePrinter()
//   };
 
//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(fullConfig, null, 2));
//   console.log("✅ Machine registered — MACHINE_ID:", machineId);
//   console.log("💾 Config saved to:", CONFIG_FILE);
//   return fullConfig;
// }

// /* ===============================
//    LOAD CONFIG
// =============================== */
// function loadConfig() {
//   try {
//     if (!fs.existsSync(CONFIG_FILE)) return null;
//     const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//     if (!data) return null;
//     return JSON.parse(data);
//   } catch {
//     try { fs.unlinkSync(CONFIG_FILE); } catch {}
//     return null;
//   }
// }

// /* ===============================
//    SAVE CONFIG HELPER
//    Always merges — never loses existing fields.
// =============================== */
// function saveConfig(updates) {
//   const current = loadConfig() || {};
//   const merged  = { ...current, ...updates };
//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
// }

// /* ===============================
//    INIT MACHINE
// =============================== */
// async function initMachine() {
//   try {
//     let config = loadConfig();

//     // Validate that config has ALL required fields; re-register if any are missing
//     const isValid = config
//       && config.API_KEY
//       && config.MACHINE_ID;

//     if (!isValid) {
//       console.log("⚠️  Config missing or incomplete — re-registering...");
//       try { fs.unlinkSync(CONFIG_FILE); } catch {}
//       config = await registerMachine();
//     }

//     MACHINE_ID = config.MACHINE_ID;
//     API_KEY    = config.API_KEY;

//     // ✅ Confirm API_BASE in memory matches config (covers edge case of server IP change)
//     if (config.API_BASE) {
//       API_BASE = config.API_BASE;
//       console.log("🌐 API_BASE confirmed from config:", API_BASE);
//     }

//     console.log("✅ Machine Ready:", MACHINE_ID);
//   } catch (err) {
//     console.error("❌ Init failed:", err.message);
//     process.exit(1);
//   }
// }

// /* ===============================
//    SECURITY — SIGN REQUEST
// =============================== */
// function signRequest(body) {
//   const timestamp  = Date.now().toString();
//   const bodyString = JSON.stringify(body || {});
//   const signature  = crypto
//     .createHmac("sha256", API_KEY)
//     .update(MACHINE_ID + timestamp + bodyString)
//     .digest("hex");
//   return { timestamp, signature };
// }

// function getHeaders(body) {
//   const auth = signRequest(body);
//   return {
//     "X-Machine-Id": MACHINE_ID,
//     "X-Api-Key":    API_KEY,
//     "X-Timestamp":  auth.timestamp,
//     "X-Signature":  auth.signature,
//   };
// }

// /* ===============================
//    PRINTER DETECTION
// =============================== */
// function detectPrinter() {
//   return new Promise((resolve, reject) => {
//     exec("lpstat -p", (err, stdout) => {
//       if (err) return reject(err);
//       const match = stdout.match(/printer\s+(\S+)/);
//       if (match) return resolve(match[1]);
//       reject(new Error("No printer found in lpstat output"));
//     });
//   });
// }

// /* ===============================
//    ENSURE PRINTER
//    Uses saveConfig() so PRINTER_NAME is merged into existing
//    config without overwriting any other fields.
// =============================== */
// async function ensurePrinter() {
//   const config = loadConfig();

//   // If printer already saved in config, use it
//   if (config?.PRINTER_NAME) {
//     PRINTER_NAME = config.PRINTER_NAME;
//     console.log("✅ Printer loaded from config:", PRINTER_NAME);
//     return;
//   }

//   try {
//     PRINTER_NAME = await detectPrinter();
//     console.log("✅ Printer detected:", PRINTER_NAME);

//     // saveConfig() merges — preserves all other config fields
//     saveConfig({ PRINTER_NAME });
//     console.log("💾 Printer name saved to config");
//   } catch (err) {
//     console.log("⚠️  No printer detected:", err.message);
//     console.log("🔄 Retrying printer detection in 5s...");
//     setTimeout(ensurePrinter, 5000);
//   }
// }

// /* ===============================
//    DOWNLOAD FILE
// =============================== */
// async function downloadFile(fileUrl, jobId = null) {
//   let url;

//   if (fileUrl.startsWith("http")) {
//     url = fileUrl;
//   } else {
//     const filename = fileUrl.includes("\\")
//       ? fileUrl.split("\\").pop()
//       : fileUrl.split("/").pop();
//     url = `${API_BASE.replace("/api", "")}/uploads/${filename}`;
//   }

//   console.log("⬇️  Downloading from URL:", url);

//   const filename = jobId ? `${jobId}.pdf` : `${Date.now()}.pdf`;
//   const filePath = path.join(DOWNLOAD_DIR, filename);

//   const response = await axios({
//     url,
//     method:       "GET",
//     responseType: "arraybuffer",
//     timeout:      30000,   // 30s timeout — important for slow Pi connections
//   });

//   fs.writeFileSync(filePath, Buffer.from(response.data));
//   console.log("✅ File written to:", filePath);

//   return filePath;
// }

// /* ===============================
//    PRE-FETCH
// =============================== */
// async function preFetchJob(jobId, filePath, expiresAt) {
//   const cached = getFromCache(jobId);
//   if (cached && fs.existsSync(cached)) {
//     console.log(`📦 Already cached: ${jobId}`);
//     return;
//   }

//   try {
//     console.log(`⬇️  Pre-fetching: ${jobId}`);
//     const localPath = await downloadFile(filePath, jobId);
//     addToCache(jobId, localPath, expiresAt);
//     console.log(`✅ Cached: ${jobId} → ${localPath}`);
//   } catch (err) {
//     console.error(`❌ Pre-fetch failed for ${jobId}:`, err.message);
//   }
// }

// /* ===============================
//    SOCKET
// =============================== */
// function connectSocket() {
//   const serverBase = API_BASE.replace("/api", "");
//   const socket = socketIO(serverBase, {
//     reconnection:         true,
//     reconnectionDelay:    3000,
//     reconnectionDelayMax: 10000,
//   });

//   socket.on("connect", () => {
//     console.log("🔌 Socket connected to", serverBase);
//     if (typeof global.onSocketStatus === "function") {
//       global.onSocketStatus("connected");
//     }
//   });

//   socket.on("payment_success", ({ jobId, machineId, filePath }) => {
//     if (machineId !== MACHINE_ID) return;
//     const expiresAt = Date.now() + 5 * 60 * 1000;
//     console.log(`💳 Payment received for ${jobId} — pre-fetching...`);
//     preFetchJob(jobId, filePath, expiresAt);
//   });

//   socket.on("disconnect", (reason) => {
//     console.log("🔌 Socket disconnected:", reason);
//     if (typeof global.onSocketStatus === "function") {
//       global.onSocketStatus("disconnected");
//     }
//   });

//   socket.on("connect_error", (err) => {
//     console.log("🔌 Socket connect error:", err.message);
//   });
// }

// /* ===============================
//    POLLER
// =============================== */
// async function startPoller() {
//   async function poll() {
//     try {
//       const body = {};
//       const res = await axios.get(`${API_BASE}/kiosk/pending-jobs`, {
//         headers: getHeaders(body),
//         timeout: 15000,
//       });

//       const { jobs } = res.data;
//       if (jobs.length > 0) {
//         console.log(`🔍 Poller found ${jobs.length} pending job(s)`);
//       }

//       for (const job of jobs) {
//         const expiresAt = Date.now() + 5 * 60 * 1000;
//         await preFetchJob(job.job_id, job.file_path, expiresAt);
//       }
//     } catch (err) {
//       console.log("🔍 Poller error:", err.response?.data?.error || err.message);
//     }
//   }

//   await poll();
//   setInterval(poll, POLL_INTERVAL);
// }

// /* ===============================
//    PRINT FILE — cross-platform
//    Windows → SumatraPDF (silent print)
//    Linux/Mac → CUPS lp command
// =============================== */
// function printFile(filePath, job) {
//   if (!PRINTER_NAME) throw new Error("Printer not ready — still detecting");

//   const copies    = job.copies || 1;
//   const isWindows = process.platform === "win32";

//   let command;

//   if (isWindows) {
//     const sumatraPath   = `C:\\Program Files\\SumatraPDF\\SumatraPDF.exe`;
//     const sumatraPath86 = `C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe`;

//     const sumatra = fs.existsSync(sumatraPath)
//       ? sumatraPath
//       : fs.existsSync(sumatraPath86)
//         ? sumatraPath86
//         : null;

//     if (sumatra) {
//       const duplexSetting = job.printSide === "duplex" ? ",duplexlong" : "";
//       const colorSetting  = job.color     === "bw"     ? ",monochrome" : ",color";
//       const printSettings = `${copies}x${duplexSetting}${colorSetting}`;
//       command = `"${sumatra}" -print-to "${PRINTER_NAME}" -print-settings "${printSettings}" -silent "${filePath}"`;
//     } else {
//       console.warn("⚠️  SumatraPDF not found — using Windows built-in fallback");
//       const adobePath = `C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe`;
//       command = fs.existsSync(adobePath)
//         ? `"${adobePath}" /t "${filePath}" "${PRINTER_NAME}"`
//         : `rundll32 mshtml.dll,PrintHTML "${filePath}"`;
//     }

//   } else {
//     // ── LINUX / MAC (Raspberry Pi) — CUPS ─────────────────────
//     const sides = job.printSide === "duplex"
//       ? "-o sides=two-sided-long-edge"
//       : "-o sides=one-sided";
//     const color = job.color     === "bw"  ? "-o ColorModel=Gray" : "";
//     const media = job.paperSize === "A3"  ? "-o media=A3"        : "-o media=A4";

//     command = [
//       "lp",
//       `-d "${PRINTER_NAME}"`,
//       `-n ${copies}`,
//       sides,
//       color,
//       media,
//       `"${filePath}"`,
//     ].filter(Boolean).join(" ");
//   }

//   console.log("🖨 Print command:", command);

//   return new Promise((resolve, reject) => {
//     exec(command, (err, stdout, stderr) => {
//       if (err) {
//         console.error("🖨 Print exec error:", err.message);
//         return reject(err);
//       }
//       if (stderr) console.log("🖨 Print stderr:", stderr);
//       console.log("🖨 Print stdout:", stdout);
//       resolve(stdout);
//     });
//   });
// }

// /* ===============================
//    HEARTBEAT
// =============================== */
// function startHeartbeat() {
//   async function beat() {
//     try {
//       const body = {
//         cpu_usage:   os.loadavg()[0],
//         paper_level: 80,
//         ink_level:   60,
//         status:      "ONLINE",
//         printer:     PRINTER_NAME || "NOT_DETECTED",
//       };
//       await axios.post(`${API_BASE}/kiosk/heartbeat`, body, {
//         headers: getHeaders(body),
//         timeout: 10000,
//       });
//       console.log("💓 Heartbeat sent");
//     } catch (err) {
//       console.log("❌ Heartbeat failed:", err.response?.data || err.message);
//     }
//   }

//   beat(); // send one immediately on start
//   setInterval(beat, HEARTBEAT_INTERVAL);
// }

// /* ===============================
//    INPUT PARSER
// =============================== */
// function isOtp(input)     { return /^\d{4}$/.test(input); }
// function isQrToken(input) { return /^[a-f0-9]{64}$/i.test(input); }

// function parseInput(input) {
//   input = input.trim();
//   if (input.startsWith("PRINTJOB:")) {
//     const token = input.replace("PRINTJOB:", "").trim();
//     if (isQrToken(token)) return { qrToken: token };
//   }
//   if (isOtp(input))     return { otp: input };
//   if (isQrToken(input)) return { qrToken: input };
//   return null;
// }

// /* ===============================
//    MAIN PRINT FLOW  ← exported for Electron
// =============================== */
// async function handleInput(input) {
//   console.log("📥 Input received:", JSON.stringify(input));

//   const payload = parseInput(input);
//   if (!payload) {
//     console.log("❌ Invalid format — OTP must be exactly 4 digits or a 64-char QR token");
//     return "❌ Invalid OTP (must be 4 digits)";
//   }

//   console.log("📤 Parsed payload:", payload);

//   let localFilePath = null;
//   let jobId         = null;

//   try {
//     // STEP 1 — Verify OTP/QR with server
//     console.log("🔐 Sending unlock request to server...");
//     const unlockRes = await axios.post(
//       `${API_BASE}/kiosk/unlock`,
//       payload,
//       {
//         headers: getHeaders(payload),
//         timeout: 15000,
//       }
//     );
//     const job = unlockRes.data;
//     jobId = job.jobId;
//     console.log("🔓 Job unlocked:", jobId, "| Details:", JSON.stringify(job));

//     // STEP 2 — Use cached file or download
//     const cached = getFromCache(jobId);
//     if (cached && fs.existsSync(cached)) {
//       localFilePath = cached;
//       console.log("⚡ Using pre-cached file:", localFilePath);
//     } else {
//       console.log("⬇️  Cache miss — downloading now...");
//       localFilePath = await downloadFile(job.filePath, jobId);
//       console.log("✅ Downloaded to:", localFilePath);
//     }

//     if (!fs.existsSync(localFilePath)) {
//       throw new Error(`File not found at: ${localFilePath}`);
//     }
//     console.log("📄 File ready, size:", fs.statSync(localFilePath).size, "bytes");

//     // STEP 3 — Print
//     console.log("🖨 Starting print...");
//     await printFile(localFilePath, job);
//     console.log("🖨 Print job sent successfully");

//     // STEP 4 — Mark printed on server
//     const markBody = { jobId };
//     await axios.post(`${API_BASE}/kiosk/mark-printed`, markBody, {
//       headers: getHeaders(markBody),
//       timeout: 10000,
//     });

//     console.log("✅ All done:", jobId);
//     return "✅ Printed Successfully";

//   } catch (err) {
//     console.error("❌ HANDLE INPUT ERROR:");
//     console.error("   HTTP status :", err.response?.status);
//     console.error("   Server msg  :", JSON.stringify(err.response?.data));
//     console.error("   Local msg   :", err.message);

//     if (jobId) {
//       try {
//         const failBody = { jobId };
//         await axios.post(`${API_BASE}/kiosk/mark-failed`, failBody, {
//           headers: getHeaders(failBody),
//           timeout: 10000,
//         });
//         console.log("⚠️  Job marked FAILED on server");
//       } catch (markErr) {
//         console.error("❌ Could not mark job failed:", markErr.message);
//       }
//     }

//     const msg = err.response?.data?.error || err.message || "Unknown error";
//     return `❌ ${msg}`;

//   } finally {
//     // ✅ Always runs — file deleted whether print succeeded or failed
//     if (jobId) removeFromCache(jobId);
//     if (localFilePath && fs.existsSync(localFilePath)) {
//       try { fs.unlinkSync(localFilePath); console.log("🗑️  Local file deleted"); } catch {}
//     }
//   }
// }

// /* ===============================
//    STATUS — exported for Electron
//    Lets renderer check machine/printer health
// =============================== */
// function getStatus() {
//   return {
//     machineId:    MACHINE_ID,
//     apiBase:      API_BASE,
//     printer:      PRINTER_NAME || null,
//     printerReady: !!PRINTER_NAME,
//     cacheSize:    Object.keys(fileCache).length,
//   };
// }

// /* ===============================
//    MAIN LOOP  (CLI only)
// =============================== */
// async function mainLoop() {
//   const rl = readline.createInterface({
//     input:  process.stdin,
//     output: process.stdout,
//   });

//   function ask(q) {
//     return new Promise((resolve) => rl.question(q, resolve));
//   }

//   console.log("\n📟 Ready — enter OTP or scan QR code\n");

//   while (true) {
//     try {
//       const input = await ask("OTP / QR > ");
//       if (!input.trim()) continue;
//       const result = await handleInput(input.trim());
//       console.log("→", result, "\n");
//     } catch (err) {
//       console.log("❌ Loop error:", err.message);
//     }
//   }
// }

// /* ===============================
//    START  (only when run directly)
// =============================== */
// if (require.main === module) {
//   (async () => {
//     ensureDir();
//     loadCache();
//     await initMachine();
//     await ensurePrinter();
//     startHeartbeat();
//     connectSocket();
//     await startPoller();
//     mainLoop();
//   })();
// } else {
//   // ✅ Required as a module by Electron — boot everything except mainLoop
//   (async () => {
//     ensureDir();
//     loadCache();
//     await initMachine();
//     await ensurePrinter();
//     startHeartbeat();
//     connectSocket();
//     await startPoller();
//   })();
// }

// // ✅ Exports for Electron preload
// module.exports = { handleInput, getStatus };
//---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// const axios = require("axios");
// const { print } = require("pdf-to-printer");
// const crypto = require("crypto");
// const os = require("os");
// const fs = require("fs");

// /* ===============================
//    CONFIG
// =============================== */
// let API_BASE = "http://192.168.0.108:5000/api"; // default
// const CONFIG_FILE = "./config.json";

// /* ===============================
//    DEVICE ID
// =============================== */
// function getDeviceId() {
//   const interfaces = os.networkInterfaces();

//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (!iface.internal && iface.mac !== "00:00:00:00:00:00") {
//         return iface.mac;
//       }
//     }
//   }
//   return os.hostname();
// }

// /* ===============================
//    GLOBALS
// =============================== */
// let MACHINE_ID = null;
// let API_KEY = null;

// /* ===============================
//    REGISTER MACHINE
// =============================== */
// async function registerMachine() {
//   console.log("Registering machine...");

//   const deviceSerial = getDeviceId();

//   try {
//     const res = await axios.post(`${API_BASE}/register-machine`, {
//       deviceSerial,
//     });

//     const data = res.data;

//     fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));

//     console.log("✅ Machine registered:", data.MACHINE_ID);
//     return data;

//   } catch (err) {
//     console.error("❌ Registration failed:", err.response?.data || err.message);
//     throw err;
//   }
// }

// /* ===============================
//    LOAD CONFIG
// =============================== */
// function loadConfig() {
//   try {
//     if (!fs.existsSync(CONFIG_FILE)) return null;

//     const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//     if (!data) return null;

//     return JSON.parse(data);

//   } catch (err) {
//     try { fs.unlinkSync(CONFIG_FILE); } catch {}
//     return null;
//   }
// }

// /* ===============================
//    INIT MACHINE
// =============================== */
// async function initMachine() {
//   try {
//     let config = loadConfig();

//     if (!config) {
//       config = await registerMachine();
//     }

//     if (!config.API_KEY || !config.MACHINE_ID) {
//       fs.unlinkSync(CONFIG_FILE);
//       config = await registerMachine();
//     }

//     MACHINE_ID = config.MACHINE_ID;
//     API_KEY = config.API_KEY;

//     // dynamic API base
//     if (config.API_BASE) {
//       API_BASE = config.API_BASE;
//     }

//     console.log(" Machine Ready:", MACHINE_ID);

//   } catch (err) {
//     console.error("❌ Init failed:", err.message);
//     process.exit(1);
//   }
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

// /* ===============================
//    HEARTBEAT
// =============================== */
// function startHeartbeat() {
//   setInterval(async () => {
//     try {
//       const body = {
//         cpu_usage: os.loadavg()[0],
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

//       console.log(" Heartbeat sent");

//     } catch (err) {
//       console.log(" Heartbeat failed:", err.response?.data || err.message);
//     }
//   }, 60000);
// }

// /* ===============================
//    INPUT PARSER
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
//     if (isQrToken(token)) return { qrToken: token };
//   }

//   if (isOtp(input)) return { otp: input };
//   if (isQrToken(input)) return { qrToken: input };

//   return null;
// }

// /* ===============================
//    MAIN PRINT FLOW
// =============================== */
// async function handleInput(input) {
//   try {
//     await initMachine(); // ✅ IMPORTANT

//     const payload = parseInput(input);
//     if (!payload) return "❌ Invalid OTP/QR";

//     const auth = signRequest(payload);

//     /* ===== UNLOCK ===== */
//     const unlockRes = await axios.post(
//       `${API_BASE}/kiosk/unlock`,
//       payload,
//       {
//         headers: {
//           "X-Machine-Id": MACHINE_ID,
//           "X-Api-Key": API_KEY,
//           "X-Timestamp": auth.timestamp,
//           "X-Signature": auth.signature,
//         },
//       }
//     );

//     const job = unlockRes.data;

//     console.log("🖨 Printing:", job.filePath);

//     /* ===== PRINT ===== */
//     try {
//       await print(job.filePath, {
//         copies: job.copies,
//         monochrome: job.color === "bw",
//         paperSize: job.paperSize,
//       });
//     } catch (printErr) {
//       console.error("❌ Printer error:", printErr.message);

//       const failBody = { jobId: job.jobId };
//       const failAuth = signRequest(failBody);

//       await axios.post(`${API_BASE}/kiosk/mark-failed`, failBody, {
//         headers: {
//           "X-Machine-Id": MACHINE_ID,
//           "X-Api-Key": API_KEY,
//           "X-Timestamp": failAuth.timestamp,
//           "X-Signature": failAuth.signature,
//         },
//       });

//       return "❌ Printer Error";
//     }

//     /* ===== MARK PRINTED ===== */
//     const markBody = { jobId: job.jobId };
//     const markAuth = signRequest(markBody);

//     await axios.post(`${API_BASE}/kiosk/mark-printed`, markBody, {
//       headers: {
//         "X-Machine-Id": MACHINE_ID,
//         "X-Api-Key": API_KEY,
//         "X-Timestamp": markAuth.timestamp,
//         "X-Signature": markAuth.signature,
//       },
//     });

//     return "✅ Printed Successfully";

//   } catch (err) {
//     console.error("❌ ERROR:", err.response?.data || err.message);
//     return err.response?.data?.error || err.message;
//   }
// }

// /* ===============================
//    START
// =============================== */
// initMachine().then(() => {
//   startHeartbeat();
// });

// module.exports = { handleInput };

// New Code------------------------------------------------------------------

// kiosk.js — Raspberry Pi compatible
// const axios = require("axios");
// const fs = require("fs");
// const path = require("path");
// const { exec } = require("child_process");
// const crypto = require("crypto");
// const os = require("os");
// const readline = require("readline");

// /* ===============================
//    CONFIG
// =============================== */
// let API_BASE = "http://192.168.0.108:5000/api";
// const CONFIG_FILE = "./config.json";
// const DOWNLOAD_DIR = "/home/pi/kiosk";
// const HEARTBEAT_INTERVAL = 30000;

// /* ===============================
//    GLOBALS
// =============================== */
// let MACHINE_ID = null;
// let API_KEY = null;
// let PRINTER_NAME = null;

// /* ===============================
//    ENSURE DOWNLOAD DIR
// =============================== */
// function ensureDir() {
//   if (!fs.existsSync(DOWNLOAD_DIR)) {
//     fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
//   }
// }

// /* ===============================
//    DEVICE ID
// =============================== */
// function getDeviceId() {
//   const interfaces = os.networkInterfaces();
//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (!iface.internal && iface.mac !== "00:00:00:00:00:00") {
//         return iface.mac;
//       }
//     }
//   }
//   return os.hostname();
// }

// /* ===============================
//    REGISTER MACHINE
// =============================== */
// async function registerMachine() {
//   console.log("Registering machine...");
//   const deviceSerial = getDeviceId();

//   const res = await axios.post(`${API_BASE}/register-machine`, {
//     deviceSerial,
//   });

//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(res.data, null, 2));
//   console.log("✅ Machine registered:", res.data.MACHINE_ID);
//   return res.data;
// }

// /* ===============================
//    LOAD CONFIG
// =============================== */
// function loadConfig() {
//   try {
//     if (!fs.existsSync(CONFIG_FILE)) return null;
//     const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//     if (!data) return null;
//     return JSON.parse(data);
//   } catch {
//     try { fs.unlinkSync(CONFIG_FILE); } catch {}
//     return null;
//   }
// }

// /* ===============================
//    INIT MACHINE
// =============================== */
// async function initMachine() {
//   try {
//     let config = loadConfig();

//     if (!config || !config.API_KEY || !config.MACHINE_ID) {
//       try { fs.unlinkSync(CONFIG_FILE); } catch {}
//       config = await registerMachine();
//     }

//     MACHINE_ID = config.MACHINE_ID;
//     API_KEY = config.API_KEY;

//     if (config.API_BASE) {
//       API_BASE = config.API_BASE;
//     }

//     console.log("✅ Machine Ready:", MACHINE_ID);
//   } catch (err) {
//     console.error("❌ Init failed:", err.message);
//     process.exit(1);
//   }
// }

// /* ===============================
//    SECURITY — SIGN REQUEST
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

// function getHeaders(body) {
//   const auth = signRequest(body);
//   return {
//     "X-Machine-Id": MACHINE_ID,
//     "X-Api-Key": API_KEY,
//     "X-Timestamp": auth.timestamp,
//     "X-Signature": auth.signature,
//   };
// }

// /* ===============================
//    PRINTER DETECTION (CUPS/Linux)
// =============================== */
// function detectPrinter() {
//   return new Promise((resolve, reject) => {
//     exec("lpstat -p", (err, stdout) => {
//       if (err) return reject(err);
//       const match = stdout.match(/printer\s+(\S+)/);
//       if (match) return resolve(match[1]);
//       reject(new Error("No printer found"));
//     });
//   });
// }

// // async function ensurePrinter() {
// //   try {
// //     PRINTER_NAME = await detectPrinter();
// //     console.log("✅ Printer detected:", PRINTER_NAME);
// //   } catch {
// //     console.log("❌ No printer detected, retrying in 5s...");
// //     setTimeout(ensurePrinter, 5000);
// //   }
// // }


// async function ensurePrinter() {
//   const config = loadConfig();

//   // Use saved printer name if available
//   if (config?.PRINTER_NAME) {
//     PRINTER_NAME = config.PRINTER_NAME;
//     console.log("✅ Printer loaded from config:", PRINTER_NAME);
//     return;
//   }

//   // Fallback — auto detect if not in config
//   try {
//     PRINTER_NAME = await detectPrinter();
//     console.log("✅ Printer detected:", PRINTER_NAME);

//     // Save it to config so next restart uses it directly
//     const updatedConfig = { ...config, PRINTER_NAME };
//     fs.writeFileSync(CONFIG_FILE, JSON.stringify(updatedConfig, null, 2));
//     console.log("💾 Printer name saved to config");

//   } catch {
//     console.log("❌ No printer detected, retrying in 5s...");
//     setTimeout(ensurePrinter, 5000);
//   }
// }
// /* ===============================
//    DOWNLOAD FILE FROM SERVER
// =============================== */
// async function downloadFile(fileUrl) {
//   // If it's a local server path (not a URL), build full URL
//   const url = fileUrl.startsWith("http")
//     ? fileUrl
//     : `${API_BASE.replace("/api", "")}/${fileUrl.replace(/^\//, "")}`;

//   const filePath = path.join(DOWNLOAD_DIR, `${Date.now()}.pdf`);

//   const response = await axios({
//     url,
//     method: "GET",
//     responseType: "stream",
//   });

//   await new Promise((resolve, reject) => {
//     const writer = fs.createWriteStream(filePath);
//     response.data.pipe(writer);
//     writer.on("finish", resolve);
//     writer.on("error", reject);
//   });

//   return filePath;
// }

// /* ===============================
//    PRINT FILE via CUPS (lp command)
// =============================== */
// function printFile(filePath, job) {
//   if (!PRINTER_NAME) throw new Error("Printer not ready");

//   // Build lp options
//   const sides = job.printSide === "duplex"
//     ? "-o sides=two-sided-long-edge"
//     : "-o sides=one-sided";

//   const color = job.color === "bw"
//     ? "-o ColorModel=Gray"
//     : "";

//   const media = job.paperSize === "A3"
//     ? "-o media=A3"
//     : "-o media=A4";

//   const command = [
//     "lp",
//     `-d ${PRINTER_NAME}`,
//     `-n ${job.copies || 1}`,
//     sides,
//     color,
//     media,
//     `"${filePath}"`,
//   ].filter(Boolean).join(" ");

//   console.log("🖨 Print command:", command);

//   return new Promise((resolve, reject) => {
//     exec(command, (err, stdout, stderr) => {
//       if (err) return reject(err);
//       if (stderr) console.log("lp stderr:", stderr);
//       resolve(stdout);
//     });
//   });
// }

// /* ===============================
//    HEARTBEAT
// =============================== */
// function startHeartbeat() {
//   setInterval(async () => {
//     try {
//       const body = {
//         cpu_usage: os.loadavg()[0],
//         paper_level: 80,
//         ink_level: 60,
//         status: "ONLINE",
//       };

//       await axios.post(`${API_BASE}/kiosk/heartbeat`, body, {
//         headers: getHeaders(body),
//       });

//       console.log("💓 Heartbeat sent");
//     } catch (err) {
//       console.log("❌ Heartbeat failed:", err.response?.data || err.message);
//     }
//   }, HEARTBEAT_INTERVAL);
// }

// /* ===============================
//    INPUT PARSER (OTP + QR support)
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
//     if (isQrToken(token)) return { qrToken: token };
//   }

//   if (isOtp(input)) return { otp: input };
//   if (isQrToken(input)) return { qrToken: input };

//   return null;
// }

// /* ===============================
//    MAIN PRINT FLOW
// =============================== */
// async function handleInput(input) {
//   const payload = parseInput(input);
//   if (!payload) {
//     console.log("❌ Invalid OTP/QR format");
//     return "❌ Invalid OTP/QR";
//   }

//   let localFilePath = null;

//   try {
//     // ── STEP 1: Unlock job on backend ──
//     const unlockRes = await axios.post(
//       `${API_BASE}/kiosk/unlock`,
//       payload,
//       { headers: getHeaders(payload) }
//     );

//     const job = unlockRes.data;
//     console.log("🔓 Job unlocked:", job.jobId);

//     // ── STEP 2: Download file to Pi ──
//     console.log("⬇️  Downloading file...");
//     localFilePath = await downloadFile(job.filePath);
//     console.log("✅ Downloaded to:", localFilePath);

//     // ── STEP 3: Print via CUPS ──
//     await printFile(localFilePath, job);
//     console.log("🖨 Print job sent to CUPS");

//     // ── STEP 4: Mark printed on backend ──
//     const markBody = { jobId: job.jobId };
//     await axios.post(`${API_BASE}/kiosk/mark-printed`, markBody, {
//       headers: getHeaders(markBody),
//     });

//     console.log("✅ Printed Successfully:", job.jobId);
//     return "✅ Printed Successfully";

//   } catch (err) {
//     console.error("❌ ERROR:", err.response?.data || err.message);

//     // If unlock succeeded but print failed — mark failed on backend
//     try {
//       const input_payload = parseInput(input);
//       // We need jobId — try to get it from error context if available
//       if (err.jobId) {
//         const failBody = { jobId: err.jobId };
//         await axios.post(`${API_BASE}/kiosk/mark-failed`, failBody, {
//           headers: getHeaders(failBody),
//         });
//       }
//     } catch {}

//     return err.response?.data?.error || err.message;

//   } finally {
//     // ── Always clean up downloaded file ──
//     if (localFilePath && fs.existsSync(localFilePath)) {
//       try {
//         fs.unlinkSync(localFilePath);
//         console.log("🗑️  Temp file deleted");
//       } catch {}
//     }
//   }
// }

// /* ===============================
//    MAIN LOOP — reads from stdin
//    (works with keyboard, barcode scanner, QR reader)
// =============================== */
// async function mainLoop() {
//   const rl = readline.createInterface({
//     input: process.stdin,
//     output: process.stdout,
//   });

//   function ask(q) {
//     return new Promise((resolve) => rl.question(q, resolve));
//   }

//   console.log("\n📟 Ready — enter OTP or scan QR code\n");

//   while (true) {
//     try {
//       const input = await ask("OTP / QR > ");
//       if (!input.trim()) continue;

//       const result = await handleInput(input.trim());
//       console.log("→", result, "\n");

//     } catch (err) {
//       console.log("❌ Loop error:", err.message);
//     }
//   }
// }

// /* ===============================
//    START
// =============================== */
// (async () => {
//   ensureDir();
//   await initMachine();
//   await ensurePrinter();
//   startHeartbeat();
//   mainLoop();
// })();

//------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// // kiosk.js — Raspberry Pi compatible — Option C (Hybrid: Socket + Disk Cache)
// const axios   = require("axios");
// const fs      = require("fs");
// const path    = require("path");
// const { exec }    = require("child_process");
// const crypto      = require("crypto");
// const os          = require("os");
// const readline    = require("readline");
// const { io: socketIO } = require("socket.io-client"); // npm install socket.io-client

// /* ===============================
//    CONFIG
// =============================== */
// // let API_BASE          = "http://192.168.0.108:5000/api";
// let API_BASE= "http://192.168.0.106:5000/api";
// const CONFIG_FILE     = "./config.json";
// const DOWNLOAD_DIR    = "/home/pi/kiosk/files";
// const CACHE_FILE      = "/home/pi/kiosk/jobs.json";   // survives reboots
// const HEARTBEAT_INTERVAL = 30000;
// const POLL_INTERVAL      = 30000; // fallback poller every 30s

// /* ===============================
//    GLOBALS
// =============================== */
// let MACHINE_ID   = null;
// let API_KEY      = null;
// let PRINTER_NAME = null;

// /*
//   fileCache — in-memory index of pre-downloaded files
//   shape: { [jobId]: { filePath: string, expires: number } }
//   Persisted to CACHE_FILE so Pi restarts don't lose it.
// */
// let fileCache = {};

// /* ===============================
//    CACHE HELPERS  (disk-persisted)
// =============================== */
// function loadCache() {
//   try {
//     if (!fs.existsSync(CACHE_FILE)) return;
//     const raw = fs.readFileSync(CACHE_FILE, "utf-8").trim();
//     if (!raw) return;
//     fileCache = JSON.parse(raw);
//     // Drop entries that already expired
//     const now = Date.now();
//     for (const jobId of Object.keys(fileCache)) {
//       if (fileCache[jobId].expires < now) {
//         safeDelete(fileCache[jobId].filePath);
//         delete fileCache[jobId];
//       }
//     }
//     console.log(`📦 Cache loaded: ${Object.keys(fileCache).length} job(s)`);
//   } catch (err) {
//     console.error("Cache load error:", err.message);
//     fileCache = {};
//   }
// }

// function saveCache() {
//   try {
//     fs.writeFileSync(CACHE_FILE, JSON.stringify(fileCache, null, 2));
//   } catch (err) {
//     console.error("Cache save error:", err.message);
//   }
// }

// function addToCache(jobId, filePath, expiresAt) {
//   fileCache[jobId] = { filePath, expires: new Date(expiresAt).getTime() };
//   saveCache();
// }

// function getFromCache(jobId) {
//   const entry = fileCache[jobId];
//   if (!entry) return null;
//   if (entry.expires < Date.now()) {
//     safeDelete(entry.filePath);
//     delete fileCache[jobId];
//     saveCache();
//     return null;
//   }
//   return entry.filePath;
// }

// function removeFromCache(jobId) {
//   delete fileCache[jobId];
//   saveCache();
// }

// function safeDelete(filePath) {
//   if (filePath && fs.existsSync(filePath)) {
//     try { fs.unlinkSync(filePath); } catch {}
//   }
// }

// /* ===============================
//    ENSURE DIRS
// =============================== */
// function ensureDir() {
//   [DOWNLOAD_DIR, path.dirname(CACHE_FILE)].forEach(dir => {
//     if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
//   });
// }

// /* ===============================
//    DEVICE ID
// =============================== */
// function getDeviceId() {
//   const interfaces = os.networkInterfaces();
//   for (const name of Object.keys(interfaces)) {
//     for (const iface of interfaces[name]) {
//       if (!iface.internal && iface.mac !== "00:00:00:00:00:00") {
//         return iface.mac;
//       }
//     }
//   }
//   return os.hostname();
// }

// /* ===============================
//    REGISTER MACHINE
// =============================== */
// async function registerMachine() {
//   console.log("Registering machine...");
//   const deviceSerial = getDeviceId();
//   const res = await axios.post(`${API_BASE}/register-machine`, { deviceSerial });
//   fs.writeFileSync(CONFIG_FILE, JSON.stringify(res.data, null, 2));
//   console.log("✅ Machine registered:", res.data.MACHINE_ID);
//   return res.data;
// }

// /* ===============================
//    LOAD CONFIG
// =============================== */
// function loadConfig() {
//   try {
//     if (!fs.existsSync(CONFIG_FILE)) return null;
//     const data = fs.readFileSync(CONFIG_FILE, "utf-8").trim();
//     if (!data) return null;
//     return JSON.parse(data);
//   } catch {
//     try { fs.unlinkSync(CONFIG_FILE); } catch {}
//     return null;
//   }
// }

// /* ===============================
//    INIT MACHINE
// =============================== */
// async function initMachine() {
//   try {
//     let config = loadConfig();
//     if (!config || !config.API_KEY || !config.MACHINE_ID) {
//       try { fs.unlinkSync(CONFIG_FILE); } catch {}
//       config = await registerMachine();
//     }
//     MACHINE_ID = config.MACHINE_ID;
//     API_KEY    = config.API_KEY;
//     if (config.API_BASE) API_BASE = config.API_BASE;
//     console.log("✅ Machine Ready:", MACHINE_ID);
//   } catch (err) {
//     console.error("❌ Init failed:", err.message);
//     process.exit(1);
//   }
// }

// /* ===============================
//    SECURITY — SIGN REQUEST
// =============================== */
// function signRequest(body) {
//   const timestamp  = Date.now().toString();
//   const bodyString = JSON.stringify(body || {});
//   const signature  = crypto
//     .createHmac("sha256", API_KEY)
//     .update(MACHINE_ID + timestamp + bodyString)
//     .digest("hex");
//   return { timestamp, signature };
// }

// function getHeaders(body) {
//   const auth = signRequest(body);
//   return {
//     "X-Machine-Id": MACHINE_ID,
//     "X-Api-Key":    API_KEY,
//     "X-Timestamp":  auth.timestamp,
//     "X-Signature":  auth.signature,
//   };
// }

// /* ===============================
//    PRINTER DETECTION
// =============================== */
// function detectPrinter() {
//   return new Promise((resolve, reject) => {
//     exec("lpstat -p", (err, stdout) => {
//       if (err) return reject(err);
//       const match = stdout.match(/printer\s+(\S+)/);
//       if (match) return resolve(match[1]);
//       reject(new Error("No printer found"));
//     });
//   });
// }

// async function ensurePrinter() {
//   const config = loadConfig();
//   if (config?.PRINTER_NAME) {
//     PRINTER_NAME = config.PRINTER_NAME;
//     console.log("✅ Printer loaded from config:", PRINTER_NAME);
//     return;
//   }
//   try {
//     PRINTER_NAME = await detectPrinter();
//     console.log("✅ Printer detected:", PRINTER_NAME);
//     const updatedConfig = { ...config, PRINTER_NAME };
//     fs.writeFileSync(CONFIG_FILE, JSON.stringify(updatedConfig, null, 2));
//   } catch {
//     console.log("❌ No printer detected, retrying in 5s...");
//     setTimeout(ensurePrinter, 5000);
//   }
// }

// /* ===============================
//    DOWNLOAD FILE
//    jobId is optional — if provided, names the file by jobId
//    so we never get duplicate downloads of the same job
// =============================== */
// async function downloadFile(fileUrl, jobId = null) {
//   const url = fileUrl.startsWith("http")
//     ? fileUrl
//     : `${API_BASE.replace("/api", "")}/${fileUrl.replace(/^\//, "")}`;

//   // Use jobId as filename so re-download of same job overwrites rather than duplicates
//   const filename = jobId ? `${jobId}.pdf` : `${Date.now()}.pdf`;
//   const filePath = path.join(DOWNLOAD_DIR, filename);

//   const response = await axios({ url, method: "GET", responseType: "stream" });

//   await new Promise((resolve, reject) => {
//     const writer = fs.createWriteStream(filePath);
//     response.data.pipe(writer);
//     writer.on("finish", resolve);
//     writer.on("error", reject);
//   });

//   return filePath;
// }

// /* ===============================
//    PRE-FETCH — downloads a PAID job
//    and stores it in the disk cache.
//    Safe to call multiple times for
//    the same jobId (idempotent).
// =============================== */
// async function preFetchJob(jobId, filePath, expiresAt) {
//   // Already cached and file still on disk?
//   const cached = getFromCache(jobId);
//   if (cached && fs.existsSync(cached)) {
//     console.log(`📦 Already cached: ${jobId}`);
//     return;
//   }

//   try {
//     console.log(`⬇️  Pre-fetching: ${jobId}`);
//     const localPath = await downloadFile(filePath, jobId);
//     addToCache(jobId, localPath, expiresAt);
//     console.log(`✅ Cached: ${jobId} → ${localPath}`);
//   } catch (err) {
//     console.error(`❌ Pre-fetch failed for ${jobId}:`, err.message);
//     // Non-fatal — handleInput will fall back to download at OTP time
//   }
// }

// /* ===============================
//    SOCKET — instant payment notifications
// =============================== */
// function connectSocket() {
//   const serverBase = API_BASE.replace("/api", "");
//   const socket = socketIO(serverBase, {
//     reconnection: true,
//     reconnectionDelay: 3000,
//     reconnectionDelayMax: 10000,
//   });

//   socket.on("connect", () => {
//     console.log("🔌 Socket connected to", serverBase);
//   });

//   socket.on("payment_success", ({ jobId, machineId, filePath }) => {
//     // Only handle jobs for THIS machine
//     if (machineId !== MACHINE_ID) return;

//     // OTP expiry is 5 min from now (matches server: Date.now() + 5 * 60 * 1000)
//     const expiresAt = Date.now() + 5 * 60 * 1000;

//     console.log(`💳 Payment received for ${jobId} — pre-fetching...`);
//     preFetchJob(jobId, filePath, expiresAt);
//     // preFetchJob is intentionally not awaited — we don't want to block anything
//   });

//   socket.on("disconnect", (reason) => {
//     console.log("🔌 Socket disconnected:", reason);
//   });

//   socket.on("connect_error", (err) => {
//     console.log("🔌 Socket connect error:", err.message);
//   });
// }

// /* ===============================
//    POLLER — recovery safety net
//    Runs every 30s. Catches:
//    - Jobs paid while Pi was offline
//    - Missed socket events
//    - Pi restart after payment
// =============================== */
// async function startPoller() {
//   async function poll() {
//     try {
//       const body = {};
//       const res = await axios.get(`${API_BASE}/kiosk/pending-jobs`, {
//         headers: getHeaders(body),
//       });

//       const { jobs } = res.data;

//       if (jobs.length > 0) {
//         console.log(`🔍 Poller found ${jobs.length} pending job(s)`);
//       }

//       for (const job of jobs) {
//         // otp_expires_at isn't returned by the endpoint but we know
//         // server sets it to NOW() + 5min, so add 5min from now as
//         // a conservative expiry for any jobs we discover via polling
//         const expiresAt = Date.now() + 5 * 60 * 1000;
//         await preFetchJob(job.job_id, job.file_path, expiresAt);
//       }
//     } catch (err) {
//       // Poller failure is silent — it'll retry in 30s
//       console.log("🔍 Poller error:", err.response?.data?.error || err.message);
//     }
//   }

//   // Run immediately on startup (catches jobs paid while Pi was off)
//   await poll();

//   // Then on interval
//   setInterval(poll, POLL_INTERVAL);
// }

// /* ===============================
//    PRINT FILE via CUPS
// =============================== */
// function printFile(filePath, job) {
//   if (!PRINTER_NAME) throw new Error("Printer not ready");

//   const sides = job.printSide === "duplex"
//     ? "-o sides=two-sided-long-edge"
//     : "-o sides=one-sided";

//   const color = job.color === "bw" ? "-o ColorModel=Gray" : "";
//   const media  = job.paperSize === "A3" ? "-o media=A3" : "-o media=A4";

//   const command = [
//     "lp",
//     `-d "${PRINTER_NAME}"`,
//     `-n ${job.copies || 1}`,
//     sides,
//     color,
//     media,
//     `"${filePath}"`,
//   ].filter(Boolean).join(" ");

//   console.log("🖨 Print command:", command);

//   return new Promise((resolve, reject) => {
//     exec(command, (err, stdout, stderr) => {
//       if (err) return reject(err);
//       if (stderr) console.log("lp stderr:", stderr);
//       resolve(stdout);
//     });
//   });
// }

// /* ===============================
//    HEARTBEAT
// =============================== */
// function startHeartbeat() {
//   setInterval(async () => {
//     try {
//       const body = {
//         cpu_usage:  os.loadavg()[0],
//         paper_level: 80,
//         ink_level:   60,
//         status:      "ONLINE",
//       };
//       await axios.post(`${API_BASE}/kiosk/heartbeat`, body, {
//         headers: getHeaders(body),
//       });
//       console.log("💓 Heartbeat sent");
//     } catch (err) {
//       console.log("❌ Heartbeat failed:", err.response?.data || err.message);
//     }
//   }, HEARTBEAT_INTERVAL);
// }

// /* ===============================
//    INPUT PARSER
// =============================== */
// function isOtp(input)     { return /^\d{4}$/.test(input); }
// function isQrToken(input) { return /^[a-f0-9]{64}$/i.test(input); }

// function parseInput(input) {
//   input = input.trim();
//   if (input.startsWith("PRINTJOB:")) {
//     const token = input.replace("PRINTJOB:", "").trim();
//     if (isQrToken(token)) return { qrToken: token };
//   }
//   if (isOtp(input))     return { otp: input };
//   if (isQrToken(input)) return { qrToken: input };
//   return null;
// }

// /* ===============================
//    MAIN PRINT FLOW
// =============================== */
// async function handleInput(input) {
//   const payload = parseInput(input);
//   if (!payload) {
//     console.log("❌ Invalid OTP/QR format");
//     return "❌ Invalid OTP/QR";
//   }

//   let localFilePath = null;
//   let fromCache     = false;
//   let jobId         = null;

//   try {
//     // ── STEP 1: Verify OTP with server (fast — just a DB check) ──
//     const unlockRes = await axios.post(
//       `${API_BASE}/kiosk/unlock`,
//       payload,
//       { headers: getHeaders(payload) }
//     );
//     const job = unlockRes.data;
//     jobId = job.jobId;
//     console.log("🔓 Job unlocked:", jobId);

//     // ── STEP 2: Use cached file if available ──
//     const cached = getFromCache(jobId);

//     if (cached && fs.existsSync(cached)) {
//       // ⚡ Fast path — file already on disk
//       localFilePath = cached;
//       fromCache     = true;
//       console.log("⚡ Using pre-cached file:", localFilePath);
//     } else {
//       // 🐢 Slow path — download now (fallback, should be rare)
//       console.log("⬇️  Cache miss — downloading now...");
//       localFilePath = await downloadFile(job.filePath, jobId);
//       console.log("✅ Downloaded:", localFilePath);
//     }

//     // ── STEP 3: Print ──
//     await printFile(localFilePath, job);
//     console.log("🖨 Print job sent to CUPS");

//     // ── STEP 4: Mark printed on server ──
//     const markBody = { jobId };
//     await axios.post(`${API_BASE}/kiosk/mark-printed`, markBody, {
//       headers: getHeaders(markBody),
//     });

//     console.log("✅ Done:", jobId);
//     return "✅ Printed Successfully";

//   } catch (err) {
//     console.error("❌ ERROR:", err.response?.data || err.message);

//     // Mark failed on server if we know the jobId
//     if (jobId) {
//       try {
//         const failBody = { jobId };
//         await axios.post(`${API_BASE}/kiosk/mark-failed`, failBody, {
//           headers: getHeaders(failBody),
//         });
//       } catch {}
//     }

//     return err.response?.data?.error || err.message;

//   } finally {
//     // Remove from cache index regardless of success/failure
//     if (jobId) removeFromCache(jobId);

//     // Delete the local file
//     // (for cache-hit files we delete here; for downloads server also deletes on mark-printed)
//     if (localFilePath && fs.existsSync(localFilePath)) {
//       try {
//         fs.unlinkSync(localFilePath);
//         console.log("🗑️  Local file deleted");
//       } catch {}
//     }
//   }
// }

// /* ===============================
//    MAIN LOOP
// =============================== */
// async function mainLoop() {
//   const rl = readline.createInterface({
//     input:  process.stdin,
//     output: process.stdout,
//   });

//   function ask(q) {
//     return new Promise((resolve) => rl.question(q, resolve));
//   }

//   console.log("\n📟 Ready — enter OTP or scan QR code\n");

//   while (true) {
//     try {
//       const input = await ask("OTP / QR > ");
//       if (!input.trim()) continue;
//       const result = await handleInput(input.trim());
//       console.log("→", result, "\n");
//     } catch (err) {
//       console.log("❌ Loop error:", err.message);
//     }
//   }
// }

// /* ===============================
//    START
// =============================== */
// (async () => {
//   ensureDir();
//   loadCache();            // restore any pre-fetched files from before last restart
//   await initMachine();
//   await ensurePrinter();
//   startHeartbeat();
//   connectSocket();        // instant path: socket event → download
//   await startPoller();    // recovery path: poll on startup, then every 30s
//   mainLoop();
// })();
