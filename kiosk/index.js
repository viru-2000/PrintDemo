

// // main.js — Electron main process entry point
// const { app, BrowserWindow } = require("electron");
// const path = require("path");

// // ✅ Boot kioskCore (registers machine, starts heartbeat, socket, poller)
// // mainLoop() is NOT called because we're in Electron mode (not CLI)
// require("./kioskCore");

// function createWindow() {
//  const win = new BrowserWindow({
//   width:      800,
//   height:     480,
//   fullscreen: true,
//   kiosk:      true,
//   webPreferences: {
//     preload:          path.join(__dirname, "preload.js"),
//     contextIsolation: true,
//     nodeIntegration:  false,
//     sandbox:          false,   // ✅ ADD THIS — allows require() in preload
//   },
// });

//   win.loadFile("index.html");
// }

// app.whenReady().then(createWindow);

// app.on("window-all-closed", () => {
//   if (process.platform !== "darwin") app.quit();
// });

// -------------------------------------------------------------------------------------------------------------------------------------------------------------------
// main.js — Electron main process entry point
// const { app, BrowserWindow } = require("electron");
// const path = require("path");
 
// // ✅ Boot kioskCore (registers machine, starts heartbeat, socket, poller)
// require("./kioskCore");
 
// function createWindow() {
//   const win = new BrowserWindow({
//     // Portrait 480×800 — matches your vertically mounted 7" display
//     width:      480,
//     height:     800,
//     fullscreen: true,
//     kiosk:      true,
//     webPreferences: {
//       preload:          path.join(__dirname, "preload.js"),
//       contextIsolation: true,
//       nodeIntegration:  false,
//       sandbox:          false,
//     },
//   });
 
//   win.loadFile("index.html");
 
//   // 👇 Rotate the display 90° clockwise so portrait HTML fills the
//   // landscape-mounted panel correctly. Adjust angle if your screen
//   // is mounted the other way (try 270 if content appears upside-down).
//   win.webContents.on("did-finish-load", () => {
//     win.webContents.executeJavaScript(`
//       document.body.style.transform = 'rotate(90deg)';
//       document.body.style.transformOrigin = '240px 240px';
//       document.body.style.width  = '800px';
//       document.body.style.height = '480px';
//       document.documentElement.style.overflow = 'hidden';
//     `);
//   });
// }
 
// app.whenReady().then(createWindow);
 
// app.on("window-all-closed", () => {
//   if (process.platform !== "darwin") app.quit();
// });
 
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

// ===================================
// main.js — Electron main process entry point
// const { app, BrowserWindow } = require("electron");
// const path = require("path");

// // ✅ Disable GPU acceleration on Raspberry Pi
// app.disableHardwareAcceleration();

// app.commandLine.appendSwitch("disable-gpu");
// app.commandLine.appendSwitch("disable-software-rasterizer");
// app.commandLine.appendSwitch("disable-gpu-compositing");  // ✅ add this
// app.commandLine.appendSwitch("no-sandbox"); 

// // ✅ Boot kioskCore
// require("./kioskCore");

// function createWindow() {
//   const win = new BrowserWindow({
//     width: 800,
//     height: 480,
//     fullscreen: true,
//     kiosk: true,
//     webPreferences: {
//       preload: path.join(__dirname, "preload.js"),
//       contextIsolation: true,
//       nodeIntegration: false,
//       sandbox: false,
//     },
//   });

//   win.loadFile("index.html");
// }

// app.whenReady().then(createWindow);

// app.on("window-all-closed", () => {
//   if (process.platform !== "darwin") app.quit();
// });

const { app, BrowserWindow } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();

// GPU flags (keep only if you really need stability on low-end hardware)
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

// IMPORTANT: kiosk apps should prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

require("./kioskCore");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 480,

    kiosk: true,              // kiosk already implies fullscreen
    autoHideMenuBar: true,

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,         // OK if you need kiosk APIs
    },
  });

  win.loadFile("index.html");

  // Optional: auto-reload on crash (useful for kiosk stability)
  win.webContents.on("render-process-gone", () => {
    app.relaunch();
    app.exit();
  });
}

// Prevent multiple windows
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(createWindow);

// macOS support
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});