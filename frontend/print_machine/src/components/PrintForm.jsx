"use client"

import { useState, useEffect, useCallback } from "react";
import { QRCodeCanvas } from "qrcode.react";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const API_BASE = process.env.REACT_APP_API_BASE || "http://192.168.0.108:5000/api";

/* ─── INJECT FONTS ─── */
if (typeof document !== "undefined") {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;600&display=swap";
  document.head.appendChild(link);
}

/* ─── THEME TOKENS ─── */
const C = {
  bg:       "#050816",
  bg2:      "#071122",
  surface:  "rgba(255,255,255,0.04)",
  surface2: "rgba(0,194,255,0.07)",
  border:   "rgba(255,255,255,0.10)",
  border2:  "rgba(0,194,255,0.30)",
  primary:  "#007BFF",
  cyan:     "#00C2FF",
  ink:      "#FFFFFF",
  ink2:     "#B8E6FF",
  ink3:     "#6E7C91",
  success:  "#00C2FF",
  error:    "#FF6B6B",
  warning:  "#FFC857",
};

/* ─── INJECT GLOBAL CSS ─── */
const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

  .pf-root *, .pf-root *::before, .pf-root *::after { box-sizing: border-box; }

  .pf-root {
    font-family: 'Syne', sans-serif;
    background: linear-gradient(180deg, #050816 0%, #071122 100%);
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 32px 16px 48px;
    color: #fff;
  }

  /* scrollbar */
  .pf-root ::-webkit-scrollbar { width: 4px; }
  .pf-root ::-webkit-scrollbar-track { background: transparent; }
  .pf-root ::-webkit-scrollbar-thumb { background: rgba(0,194,255,0.3); border-radius: 4px; }

  /* card */
  .pf-card {
    width: 100%;
    max-width: 520px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(0,194,255,0.18);
    border-radius: 20px;
    padding: 32px 28px 36px;
    backdrop-filter: blur(20px);
    box-shadow:
      0 0 40px rgba(0,194,255,0.08),
      0 0 80px rgba(0,123,255,0.06),
      inset 0 1px 0 rgba(255,255,255,0.06);
  }

  /* header */
  .pf-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid rgba(0,194,255,0.12);
  }
  .pf-header-icon {
    width: 44px; height: 44px;
    background: rgba(0,194,255,0.08);
    border: 1px solid rgba(0,194,255,0.30);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
    box-shadow: 0 0 16px rgba(0,194,255,0.18);
  }
  .pf-header-title {
    font-size: 1.35rem; font-weight: 800;
    letter-spacing: -0.5px; color: #fff;
    text-shadow: 0 0 12px rgba(0,194,255,0.15);
    margin: 0;
  }
  .pf-header-title em { font-style: normal; color: #007BFF; }
  .pf-header-sub {
    font-size: 0.65rem;
    font-family: 'JetBrains Mono', monospace;
    color: #6E7C91; letter-spacing: 1px; text-transform: uppercase;
    margin: 0;
  }

  /* step badge */
  .pf-step-badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.6rem;
    font-family: 'JetBrains Mono', monospace;
    color: #00C2FF; letter-spacing: 1px; text-transform: uppercase;
    background: rgba(0,194,255,0.08);
    border: 1px solid rgba(0,194,255,0.25);
    border-radius: 999px; padding: 4px 10px;
    margin-bottom: 16px;
    box-shadow: 0 0 10px rgba(0,194,255,0.12);
  }
  .pf-step-badge-dot {
    width: 5px; height: 5px; border-radius: 50%;
    background: #00C2FF;
    box-shadow: 0 0 6px #00C2FF;
  }

  /* section label */
  .pf-label {
    font-size: 0.68rem;
    font-family: 'JetBrains Mono', monospace;
    color: #6E7C91;
    letter-spacing: 1.5px; text-transform: uppercase;
    margin-bottom: 8px; display: block;
  }

  /* form group */
  .pf-group { margin-bottom: 18px; }

  /* row */
  .pf-row { display: flex; gap: 12px; margin-bottom: 18px; }
  .pf-col { flex: 1; }

  /* input / select */
  .pf-input, .pf-select {
    width: 100%; padding: 12px 14px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 10px;
    color: #fff;
    font-size: 0.88rem;
    font-family: 'Syne', sans-serif;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    appearance: none;
  }
  .pf-input::placeholder { color: #6E7C91; }
  .pf-input:focus, .pf-select:focus {
    border-color: rgba(0,194,255,0.45);
    box-shadow: 0 0 0 3px rgba(0,194,255,0.10), 0 0 16px rgba(0,194,255,0.12);
  }
  .pf-select option { background: #071122; color: #fff; }

  /* file drop zone */
  .pf-dropzone {
    border: 1.5px dashed rgba(0,194,255,0.25);
    border-radius: 12px;
    padding: 22px 16px;
    text-align: center;
    cursor: pointer;
    background: rgba(0,194,255,0.03);
    transition: all 0.2s;
    position: relative;
  }
  .pf-dropzone:hover {
    border-color: rgba(0,194,255,0.50);
    background: rgba(0,194,255,0.06);
    box-shadow: 0 0 20px rgba(0,194,255,0.10);
  }
  .pf-dropzone input[type=file] {
    position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
  }
  .pf-dropzone-icon { font-size: 28px; margin-bottom: 8px; }
  .pf-dropzone-text {
    font-size: 0.78rem; color: #B8E6FF;
    font-family: 'JetBrains Mono', monospace; letter-spacing: 0.3px;
  }
  .pf-dropzone-sub { font-size: 0.62rem; color: #6E7C91; margin-top: 4px; }
  .pf-file-pill {
    display: inline-flex; align-items: center; gap: 8px;
    margin-top: 10px; padding: 6px 12px;
    background: rgba(0,194,255,0.08);
    border: 1px solid rgba(0,194,255,0.25);
    border-radius: 8px;
    font-size: 0.72rem; font-family: 'JetBrains Mono', monospace; color: #B8E6FF;
  }

  /* radio toggle group */
  .pf-toggle-group { display: flex; gap: 8px; }
  .pf-toggle-btn {
    flex: 1; padding: 10px 8px;
    background: rgba(255,255,255,0.04);
    border: 1.5px solid rgba(255,255,255,0.10);
    border-radius: 10px;
    color: #6E7C91;
    font-size: 0.78rem; font-weight: 600; font-family: 'Syne', sans-serif;
    cursor: pointer; text-align: center;
    transition: all 0.18s;
  }
  .pf-toggle-btn.active {
    background: rgba(0,194,255,0.10);
    border-color: rgba(0,194,255,0.45);
    color: #00C2FF;
    box-shadow: 0 0 14px rgba(0,194,255,0.15);
  }

  /* divider */
  .pf-divider {
    height: 1px; background: rgba(0,194,255,0.10);
    margin: 22px 0;
  }

  /* summary box */
  .pf-summary {
    background: rgba(0,194,255,0.05);
    border: 1px solid rgba(0,194,255,0.18);
    border-radius: 14px; padding: 18px 20px;
    margin-bottom: 20px;
    box-shadow: 0 0 20px rgba(0,194,255,0.06);
  }
  .pf-summary-title {
    font-size: 0.62rem;
    font-family: 'JetBrains Mono', monospace;
    color: #6E7C91; letter-spacing: 1.5px; text-transform: uppercase;
    margin-bottom: 14px;
  }
  .pf-summary-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-size: 0.82rem;
  }
  .pf-summary-row:last-child { border-bottom: none; }
  .pf-summary-row-key { color: #B8E6FF; }
  .pf-summary-row-val { color: #fff; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
  .pf-summary-total {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 14px; padding-top: 14px;
    border-top: 1px solid rgba(0,194,255,0.18);
    font-size: 1rem; font-weight: 800;
  }
  .pf-summary-total-key { color: #B8E6FF; }
  .pf-summary-total-val {
    color: #00C2FF;
    text-shadow: 0 0 10px rgba(0,194,255,0.4);
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.1rem;
  }

  /* buttons */
  .pf-btn {
    width: 100%; padding: 15px;
    border: none; border-radius: 12px;
    font-size: 0.88rem; font-weight: 700; font-family: 'Syne', sans-serif;
    letter-spacing: 2px; text-transform: uppercase;
    cursor: pointer; transition: all 0.2s;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .pf-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .pf-btn-primary {
    background: linear-gradient(135deg, #007BFF, #0066DD);
    color: #fff;
    box-shadow: 0 0 20px rgba(0,123,255,0.30), 0 4px 15px rgba(0,123,255,0.25);
  }
  .pf-btn-primary:not(:disabled):hover {
    box-shadow: 0 0 30px rgba(0,123,255,0.45), 0 4px 20px rgba(0,123,255,0.35);
    transform: translateY(-1px);
  }
  .pf-btn-primary:not(:disabled):active { transform: scale(0.98); }

  .pf-btn-pay {
    background: linear-gradient(135deg, #00C2FF, #007BFF);
    color: #050816;
    font-weight: 800;
    box-shadow: 0 0 24px rgba(0,194,255,0.35), 0 4px 15px rgba(0,194,255,0.20);
    animation: payGlow 2s ease-in-out infinite;
  }
  @keyframes payGlow {
    0%,100% { box-shadow: 0 0 20px rgba(0,194,255,0.30), 0 4px 15px rgba(0,194,255,0.20); }
    50%      { box-shadow: 0 0 36px rgba(0,194,255,0.55), 0 4px 24px rgba(0,194,255,0.35); }
  }
  .pf-btn-pay:not(:disabled):hover { transform: translateY(-1px); }
  .pf-btn-pay:not(:disabled):active { transform: scale(0.98); }

  /* alerts */
  .pf-alert {
    padding: 12px 14px; border-radius: 10px; margin-bottom: 16px;
    font-size: 0.78rem; font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.3px; line-height: 1.5;
    display: flex; align-items: flex-start; gap: 8px;
  }
  .pf-alert-error {
    background: rgba(255,107,107,0.10);
    border: 1px solid rgba(255,107,107,0.30);
    color: #FF6B6B;
  }
  .pf-alert-success {
    background: rgba(0,194,255,0.08);
    border: 1px solid rgba(0,194,255,0.25);
    color: #00C2FF;
  }
  .pf-alert-warning {
    background: rgba(255,200,87,0.10);
    border: 1px solid rgba(255,200,87,0.25);
    color: #FFC857;
  }

  /* OTP box */
  .pf-otp-box {
    background: rgba(0,194,255,0.06);
    border: 1px solid rgba(0,194,255,0.25);
    border-radius: 16px; padding: 28px 20px;
    text-align: center;
    box-shadow: 0 0 30px rgba(0,194,255,0.10);
  }
  .pf-otp-label {
    font-size: 0.62rem;
    font-family: 'JetBrains Mono', monospace;
    color: #6E7C91; letter-spacing: 2px; text-transform: uppercase;
    margin-bottom: 12px;
  }
  .pf-otp-digits {
    display: flex; justify-content: center; gap: 10px; margin-bottom: 20px;
  }
  .pf-otp-digit {
    width: 58px; height: 68px; border-radius: 12px;
    background: rgba(0,194,255,0.08);
    border: 1.5px solid rgba(0,194,255,0.35);
    display: flex; align-items: center; justify-content: center;
    font-size: 2rem; font-weight: 700;
    font-family: 'JetBrains Mono', monospace; color: #00C2FF;
    box-shadow: 0 0 14px rgba(0,194,255,0.18), inset 0 1px 0 rgba(255,255,255,0.05);
    text-shadow: 0 0 10px rgba(0,194,255,0.5);
  }
  .pf-otp-instruct {
    font-size: 0.72rem; color: #B8E6FF;
    font-family: 'JetBrains Mono', monospace;
    margin-bottom: 20px; line-height: 1.6;
  }
  .pf-qr-wrap {
    display: inline-flex; flex-direction: column; align-items: center; gap: 10px;
    padding: 16px;
    background: #fff; border-radius: 12px;
    box-shadow: 0 0 24px rgba(0,194,255,0.20);
  }
  .pf-qr-label {
    font-size: 0.6rem;
    font-family: 'JetBrains Mono', monospace;
    color: #050816; letter-spacing: 1px;
  }

  /* machine status pill */
  .pf-machine-pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.62rem;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.8px;
    padding: 4px 10px; border-radius: 999px;
    margin-bottom: 20px;
  }
  .pf-machine-pill.online {
    color: #00C2FF; background: rgba(0,194,255,0.08);
    border: 1px solid rgba(0,194,255,0.28);
    box-shadow: 0 0 10px rgba(0,194,255,0.12);
  }
  .pf-machine-pill.offline {
    color: #FF6B6B; background: rgba(255,107,107,0.08);
    border: 1px solid rgba(255,107,107,0.28);
  }
  .pf-machine-dot {
    width: 5px; height: 5px; border-radius: 50%;
  }
  .online .pf-machine-dot { background: #00C2FF; box-shadow: 0 0 6px #00C2FF; }
  .offline .pf-machine-dot { background: #FF6B6B; }

  /* success final state */
  .pf-success-state {
    text-align: center; padding: 32px 20px;
  }
  .pf-success-icon {
    width: 68px; height: 68px; border-radius: 50%;
    background: rgba(0,194,255,0.08);
    border: 1.5px solid rgba(0,194,255,0.35);
    display: flex; align-items: center; justify-content: center;
    font-size: 30px; margin: 0 auto 20px;
    box-shadow: 0 0 24px rgba(0,194,255,0.25);
    animation: popIn 0.5s cubic-bezier(.34,1.56,.64,1) both;
  }
  @keyframes popIn { from{transform:scale(0);opacity:0;} to{transform:scale(1);opacity:1;} }
  .pf-success-title {
    font-size: 1.5rem; font-weight: 800; color: #fff;
    letter-spacing: -1px; margin-bottom: 8px;
  }
  .pf-success-sub {
    font-size: 0.75rem; color: #B8E6FF;
    font-family: 'JetBrains Mono', monospace; letter-spacing: 0.3px;
  }

  /* number input arrows */
  .pf-input[type=number]::-webkit-inner-spin-button,
  .pf-input[type=number]::-webkit-outer-spin-button { opacity: 0.4; }
`;

if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.textContent = globalCSS;
  document.head.appendChild(style);
}

/* ─── TOGGLE COMPONENT ─── */
function Toggle({ options, value, onChange }) {
  return (
    <div className="pf-toggle-group">
      {options.map(o => (
        <button
          key={o.value}
          className={`pf-toggle-btn${value === o.value ? " active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ─── MAIN COMPONENT ─── */
export default function PrintForm() {
  const [machineId, setMachineId]       = useState("");
  const [machineStatus, setMachineStatus] = useState(null);
  const [file, setFile]                 = useState(null);
  const [color, setColor]               = useState("bw");
  const [copies, setCopies]             = useState(1);
  const [printSide, setPrintSide]       = useState("single");
  const [paperSize, setPaperSize]       = useState("A4");
  const [jobId, setJobId]               = useState(null);
  const [summary, setSummary]           = useState(null);
  const [otp, setOtp]                   = useState(null);
  const [qrToken, setQrToken]           = useState(null);
  const [error, setError]               = useState("");
  const [success, setSuccess]           = useState("");
  const [printDone, setPrintDone]       = useState(false);
  const [loading, setLoading]           = useState(false);

  /* machine from URL */
  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const machine = params.get("machine");
    if (machine) { setMachineId(machine); fetchStatus(machine); }
    else setError("Invalid kiosk link. Machine not specified.");
  }, []);

  const fetchStatus = async (id) => {
    try {
      const res  = await fetch(`${API_BASE}/machines/${id}/status`);
      const data = await res.json();
      if (res.ok) setMachineStatus(data);
    } catch {}
  };

  /* poll for print completion */
  useEffect(() => {
    if (!jobId || !otp) return;
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`${API_BASE}/job-status/${jobId}`);
        const data = await res.json();
        if (data.status === "PRINTED") {
          clearInterval(interval); setPrintDone(true);
          setSuccess("✅ Print completed successfully!");
          setTimeout(() => { window.location.href = `/?machine=${machineId}`; }, 4000);
        }
        if (data.status === "FAILED") {
          clearInterval(interval);
          setError("❌ Printing failed. Please contact support.");
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [jobId, otp, machineId]);

  const handleFileChange = (e) => {
    setError(""); setSuccess("");
    const f = e.target.files[0];
    if (!f) return;
    if (f.type !== "application/pdf") { setError("Only PDF files are allowed."); return; }
    if (f.size > MAX_FILE_SIZE)       { setError("PDF size must be less than 50MB."); return; }
    setFile(f);
  };

  const fetchSummary = async (id) => {
    const res  = await fetch(`${API_BASE}/job-summary/${id}`);
    const data = await res.json();
    if (res.ok) setSummary(data);
  };

  const updateJob = useCallback(async () => {
    if (!jobId) return;
    const res  = await fetch(`${API_BASE}/job/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color, copies, paperSize, printSide }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await fetchSummary(jobId);
  }, [jobId, color, copies, paperSize, printSide]);

  useEffect(() => { if (jobId && !otp) updateJob(); }, [jobId, otp, updateJob]);

  /* STEP 1 — Upload */
  const handleUpload = async () => {
    setError(""); setSuccess("");
    if (machineStatus?.is_print_locked) { setError("Machine is out of paper. Try later."); return; }
    if (!machineId || !file) { setError("Machine and PDF are required."); return; }
    const formData = new FormData();
    formData.append("pdf", file);
    formData.append("machineId", machineId);
    formData.append("color", color);
    formData.append("copies", copies);
    formData.append("paperSize", paperSize);
    formData.append("printSide", printSide);
    setLoading(true);
    try {
      const res  = await fetch(`${API_BASE}/upload-job`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setJobId(data.jobId); await fetchSummary(data.jobId);
    } catch (err) { setError(err.message || "Upload failed."); }
    finally { setLoading(false); }
  };

  /* STEP 2 — Pay */
  const startPayment = async () => {
    setError(""); setSuccess("");
    setLoading(true);
    try {
      await updateJob();
      const res  = await fetch(`${API_BASE}/create-payment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const options = {
        key: data.key, amount: data.amount, currency: "INR", order_id: data.orderId,
        handler: async (response) => {
          const vRes  = await fetch(`${API_BASE}/verify-payment`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          });
          const vData = await vRes.json();
          if (!vRes.ok) throw new Error(vData.error);
          setOtp(vData.otp); setQrToken(vData.qrToken);
          setSuccess("Payment successful! Enter the OTP on the kiosk.");
        },
        theme: { color: "#007BFF" },
      };
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) { setError(err.message || "Payment failed."); }
    finally { setLoading(false); }
  };

  /* ── RENDER ── */

  /* print done state */
  if (printDone) return (
    <div className="pf-root">
      <div className="pf-card">
        <div className="pf-success-state">
          <div className="pf-success-icon">✓</div>
          <h2 className="pf-success-title">Print Complete!</h2>
          <p className="pf-success-sub">Collect your prints from the slot.<br/>Redirecting in a moment…</p>
        </div>
      </div>
    </div>
  );

  const isLocked = machineStatus?.is_print_locked;
  const isOnline = machineStatus?.is_online;

  return (
    <div className="pf-root">
      <div className="pf-card">

        {/* ── HEADER ── */}
        <div className="pf-header">
          <div className="pf-header-icon">🖨</div>
          <div>
            <h1 className="pf-header-title">Snap<em>Prints</em></h1>
            <p className="pf-header-sub">Upload · Pay · Print</p>
          </div>
        </div>

        {/* ── MACHINE STATUS ── */}
        {machineStatus && (
          <div className={`pf-machine-pill ${isOnline ? "online" : "offline"}`}>
            <span className="pf-machine-dot"></span>
            {isOnline ? `${machineId} — PRINTER ONLINE` : `${machineId} — OFFLINE`}
          </div>
        )}

        {/* ── ALERTS ── */}
        {isLocked && (
          <div className="pf-alert pf-alert-warning">
            ⚠ Machine is out of paper. Payment is disabled until refilled.
          </div>
        )}
        {error   && <div className="pf-alert pf-alert-error">⚠ {error}</div>}
        {success && !otp && <div className="pf-alert pf-alert-success">✓ {success}</div>}

        {/* ══════════ STEP 1 — Upload & Settings ══════════ */}
        {!jobId && (
          <>
            <div className="pf-step-badge">
              <span className="pf-step-badge-dot"></span>
              Step 1 — Upload your file
            </div>

            {/* File drop zone */}
            <div className="pf-group">
              <label className="pf-label">PDF Document</label>
              <div className="pf-dropzone">
                <input type="file" accept="application/pdf" onChange={handleFileChange} />
                <div className="pf-dropzone-icon">📄</div>
                <div className="pf-dropzone-text">
                  {file ? file.name : "Tap to choose a PDF file"}
                </div>
                <div className="pf-dropzone-sub">Max 50 MB · PDF only</div>
              </div>
              {file && (
                <div className="pf-file-pill">
                  📎 {file.name} &nbsp;·&nbsp; {(file.size / 1024 / 1024).toFixed(2)} MB
                </div>
              )}
            </div>

            <div className="pf-divider" />

            <div className="pf-step-badge">
              <span className="pf-step-badge-dot"></span>
              Step 2 — Print settings
            </div>

            {/* Print type */}
            <div className="pf-group">
              <label className="pf-label">Print Type</label>
              <Toggle
                options={[{ value:"bw", label:"B&W  ₹2/pg" }, { value:"color", label:"Colour  ₹5/pg" }]}
                value={color} onChange={setColor}
              />
            </div>

            {/* Print side */}
            <div className="pf-group">
              <label className="pf-label">Print Side</label>
              <Toggle
                options={[{ value:"single", label:"Single Side" }, { value:"duplex", label:"Duplex" }]}
                value={printSide} onChange={setPrintSide}
              />
            </div>

            {/* Copies & Paper size */}
            <div className="pf-row">
              <div className="pf-col">
                <label className="pf-label">Copies</label>
                <input
                  className="pf-input" type="number" min="1" max="50"
                  value={copies} onChange={e => setCopies(Number(e.target.value))}
                />
              </div>
              <div className="pf-col">
                <label className="pf-label">Paper Size</label>
                <select className="pf-select" value={paperSize} onChange={e => setPaperSize(e.target.value)}>
                  <option value="A4">A4</option>
                  <option value="A3">A3</option>
                </select>
              </div>
            </div>

            <button
              className="pf-btn pf-btn-primary"
              onClick={handleUpload}
              disabled={!file || loading || isLocked}
            >
              {loading ? "Uploading…" : "Upload & Continue →"}
            </button>
          </>
        )}

        {/* ══════════ STEP 2 — Summary & Pay ══════════ */}
        {jobId && !otp && (
          <>
            <div className="pf-step-badge">
              <span className="pf-step-badge-dot"></span>
              Step 3 — Review & Pay
            </div>

            {summary && (
              <div className="pf-summary">
                <div className="pf-summary-title">Order Summary</div>
                <div className="pf-summary-row">
                  <span className="pf-summary-row-key">Pages</span>
                  <span className="pf-summary-row-val">{summary.totalPages}</span>
                </div>
                <div className="pf-summary-row">
                  <span className="pf-summary-row-key">Copies</span>
                  <span className="pf-summary-row-val">{summary.copies}</span>
                </div>
                <div className="pf-summary-row">
                  <span className="pf-summary-row-key">Type</span>
                  <span className="pf-summary-row-val">{summary.color === "bw" ? "B&W" : "Colour"}</span>
                </div>
                <div className="pf-summary-row">
                  <span className="pf-summary-row-key">Side</span>
                  <span className="pf-summary-row-val">{summary.printSide === "duplex" ? "Duplex" : "Single"}</span>
                </div>
                <div className="pf-summary-row">
                  <span className="pf-summary-row-key">Rate</span>
                  <span className="pf-summary-row-val">₹{summary.rate}/pg</span>
                </div>
                <div className="pf-summary-total">
                  <span className="pf-summary-total-key">Total</span>
                  <span className="pf-summary-total-val">₹{summary.totalAmount}</span>
                </div>
              </div>
            )}

            <button
              className="pf-btn pf-btn-pay"
              onClick={startPayment}
              disabled={loading || isLocked}
            >
              {loading ? "Processing…" : "💳  Pay via UPI / Card"}
            </button>
          </>
        )}

        {/* ══════════ STEP 3 — OTP ══════════ */}
        {otp && (
          <>
            <div className="pf-step-badge">
              <span className="pf-step-badge-dot"></span>
              Step 4 — Enter OTP on the kiosk
            </div>

            <div className="pf-otp-box">
              <div className="pf-otp-label">Your OTP</div>
              <div className="pf-otp-digits">
                {otp.split("").map((d, i) => (
                  <div className="pf-otp-digit" key={i}>{d}</div>
                ))}
              </div>
              <p className="pf-otp-instruct">
                Enter this code on the kiosk screen<br/>
                or scan the QR code below.
              </p>
              {qrToken && (
                <div className="pf-qr-wrap">
                  <QRCodeCanvas value={`PRINTJOB:${qrToken}`} size={180} level="H" />
                  <span className="pf-qr-label">SCAN ON KIOSK</span>
                </div>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}