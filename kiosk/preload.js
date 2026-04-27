// const { contextBridge } = require("electron");
// const kiosk = require("./kioskCore");

// contextBridge.exposeInMainWorld("kioskAPI", {
//   sendOtp: kiosk.handleInput
// });

// preload.js
const { contextBridge } = require("electron");
const path = require("path");
const kiosk = require(path.join(__dirname, "kioskCore"));

contextBridge.exposeInMainWorld("kioskAPI", {
  sendOtp:   (input)  => kiosk.handleInput(input),
  getStatus: ()       => kiosk.getStatus(),   
});