// async function submitOtp() {
//   const otp = document.getElementById("otp").value;

//   if (!otp) {
//     alert("Enter OTP");
//     return;
//   }

//   document.getElementById("status").innerText = "Processing...";

//   const res = await window.kioskAPI.sendOtp(otp);

//   document.getElementById("status").innerText = res;
// }

// let otpValue = "";
// let idleTimer;

// /* =========================
//    KEYPAD INPUT
// ========================= */
// function press(num) {
//   if (otpValue.length >= 6) return;

//   otpValue += num;
//   updateDisplay();
//   resetIdleTimer();
// }

// function backspace() {
//   otpValue = otpValue.slice(0, -1);
//   updateDisplay();
//   resetIdleTimer();
// }

// function clearOtp() {
//   otpValue = "";
//   updateDisplay();
//   resetIdleTimer();
// }

// function updateDisplay() {
//   document.getElementById("otp").value = otpValue;
// }

// /* =========================
//    SUBMIT OTP
// ========================= */
// async function submitOtp() {
//   if (!otpValue) {
//     setStatus("❌ Enter OTP");
//     return;
//   }

//   setStatus("⏳ Processing...");

//   try {
//     const res = await window.kioskAPI.sendOtp(otpValue);

//     setStatus(res);

//     /* ✅ AFTER PRINT → RESET */
//     if (res.includes("Printed")) {
//       setTimeout(resetScreen, 3000);
//     }

//   } catch (err) {
//     setStatus("❌ Failed");
//   }
// }

// /* =========================
//    STATUS
// ========================= */
// function setStatus(msg) {
//   document.getElementById("status").innerText = msg;
// }

// /* =========================
//    AUTO RESET
// ========================= */
// function resetScreen() {
//   otpValue = "";
//   updateDisplay();
//   setStatus("");
// }

// /* =========================
//    IDLE TIMER (30 sec)
// ========================= */
// function resetIdleTimer() {
//   clearTimeout(idleTimer);

//   idleTimer = setTimeout(() => {
//     resetScreen();
//   }, 30000);
// }

// /* Start timer initially */
// resetIdleTimer();


// renderer.js — runs in the Electron browser window (renderer process)
// All DOM manipulation lives here. Talks to main process via window.kioskAPI.

let otpValue  = "";
let idleTimer = null;

/* =========================
   INIT — show machine status
========================= */
window.addEventListener("DOMContentLoaded", async () => {
  resetIdleTimer();

  // Show machine/printer status if elements exist in index.html
  if (window.kioskAPI && window.kioskAPI.getStatus) {
    try {
      const status = await window.kioskAPI.getStatus();
      const machineEl = document.getElementById("machine-id");
      const printerEl = document.getElementById("printer-status");

      if (machineEl && status.machineId) {
        machineEl.textContent = "ID: " + status.machineId;
      }

      if (printerEl) {
        printerEl.textContent = status.printerReady
          ? "🖨 " + status.printer
          : "⚠️ Printer not ready";
        printerEl.style.color = status.printerReady ? "" : "orange";
      }
    } catch (err) {
      console.warn("Could not load status:", err.message);
    }
  }
});

/* =========================
   KEYPAD INPUT
========================= */
function press(num) {
  if (otpValue.length >= 6) return;
  otpValue += num;
  updateDisplay();
  resetIdleTimer();
}

function backspace() {
  otpValue = otpValue.slice(0, -1);
  updateDisplay();
  resetIdleTimer();
}

function clearOtp() {
  otpValue = "";
  updateDisplay();
  resetIdleTimer();
}

function updateDisplay() {
  const el = document.getElementById("otp");
  if (el) el.value = otpValue;
}

/* =========================
   SUBMIT OTP
========================= */
async function submitOtp() {
  console.log("🔢 Submitting OTP:", otpValue);

  if (!otpValue) {
    setStatus("❌ Enter OTP first");
    return;
  }

  if (!window.kioskAPI) {
    setStatus("❌ Kiosk API not loaded — preload.js failed");
    console.error("window.kioskAPI is undefined");
    return;
  }

  // Disable button during processing to prevent double-submit
  const submitBtn = document.getElementById("submit-btn");
  if (submitBtn) submitBtn.disabled = true;

  setStatus("⏳ Processing...");

  try {
    const res = await window.kioskAPI.sendOtp(otpValue);
    console.log("📨 Result:", res);
    setStatus(res);

    if (res && res.includes("Printed")) {
      // Auto-reset after success
      setTimeout(resetScreen, 3000);
    } else if (res && res.startsWith("❌")) {
      // On error, allow retry after 2s
      setTimeout(() => {
        if (submitBtn) submitBtn.disabled = false;
      }, 2000);
    }
  } catch (err) {
    console.error("submitOtp error:", err);
    setStatus("❌ Failed: " + err.message);
    if (submitBtn) submitBtn.disabled = false;
  }
}

/* =========================
   STATUS
========================= */
function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) {
    el.innerText = msg;
    // Color-code status messages
    if (msg.startsWith("✅"))      el.style.color = "green";
    else if (msg.startsWith("❌")) el.style.color = "red";
    else if (msg.startsWith("⏳")) el.style.color = "orange";
    else                            el.style.color = "";
  }
}

/* =========================
   AUTO RESET
========================= */
function resetScreen() {
  otpValue = "";
  updateDisplay();
  setStatus("");

  const submitBtn = document.getElementById("submit-btn");
  if (submitBtn) submitBtn.disabled = false;
}

/* =========================
   IDLE TIMER (30 sec)
========================= */
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    resetScreen();
    console.log("⏱ Idle timeout — screen reset");
  }, 30000);
}

// ✅ Also reset idle timer on any touch/click/key event
document.addEventListener("click",    resetIdleTimer);
document.addEventListener("keydown",  resetIdleTimer);
document.addEventListener("touchstart", resetIdleTimer);