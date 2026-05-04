// steps/StepSummary.jsx
import React, { useState } from "react";
import { ImCross } from "react-icons/im";
import { MdAttachFile } from "react-icons/md";

const COLOR_LABELS = { bw: "Black & White", color: "Color" };
const SIDE_LABELS  = { single: "Single Side", duplex: "Duplex" };

export default function StepSummary({
  file,
  jobId,
  summary,
  color, setColor,
  copies, setCopies,
  printSide, setPrintSide,
  paperSize, setPaperSize,
  jobError,
  jobSuccess,
  isLocked,
  onBack,
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);

  return (
    <div className="pf-step-enter">

      {file ? (
        <div className="pf-file-info">
          <span style={{ color: "var(--lime)", display: "flex" }}>
            <MdAttachFile size={16} />
          </span>
          <span className="file-name">{file.name}</span>
          {onBack ? (
            <button
              onClick={onBack}
              title="Remove file and go back"
              className="pf-remove-btn"
            >
              <ImCross size={11} />
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="pf-section-title">// order summary</p>

      {summary ? (
        <div className="pf-summary">
          <div className="pf-summary-header">
            <h3>Job Details</h3>
          </div>
          <div className="pf-summary-body">
            <div className="pf-summary-row">
              <span className="key">Print Type</span>
              <span className="val">{COLOR_LABELS[summary.color] ?? summary.color}</span>
            </div>
            <div className="pf-summary-row">
              <span className="key">Copies</span>
              <span className="val">{summary.copies}</span>
            </div>
            <div className="pf-summary-row">
              <span className="key">Print Side</span>
              <span className="val">{SIDE_LABELS[summary.printSide] ?? summary.printSide}</span>
            </div>
            <div className="pf-summary-row">
              <span className="key">Total Pages</span>
              <span className="val">{summary.pages || summary.totalPages || "—"}</span>
            </div>
            <div className="pf-summary-total">
              <span className="label">Total</span>
              <span className="amount">₹{summary.totalAmount}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Collapsible Adjust Options */}
      <button
        type="button"
        className={`pf-adjust-toggle ${adjustOpen ? "open" : ""}`}
        onClick={() => setAdjustOpen((v) => !v)}
      >
        <span>✏ Adjust options</span>
        <span className="chevron">▾</span>
      </button>

      <div className={`pf-adjust-body ${adjustOpen ? "open" : ""}`}>
        <div className="pf-grid" style={{ paddingBottom: 12 }}>
          <div className="pf-field">
            <label>Print Type</label>
            <select value={color} onChange={(e) => setColor(e.target.value)}>
              <option value="bw">B &amp; W</option>
              <option value="color">Color</option>
            </select>
          </div>

          <div className="pf-field">
            <label>Copies</label>
            <div className="pf-counter">
              <button
                type="button"
                onClick={() => setCopies((prev) => Math.max(1, prev - 1))}
                className="pf-counter-btn"
              >−</button>
              <span className="pf-counter-value">{copies}</span>
              <button
                type="button"
                onClick={() => setCopies((prev) => Math.min(50, prev + 1))}
                className="pf-counter-btn"
              >+</button>
            </div>
          </div>

          <div className="pf-field">
            <label>Print Side</label>
            <select value={printSide} onChange={(e) => setPrintSide(e.target.value)}>
              <option value="single">Single</option>
              <option value="duplex">Duplex</option>
            </select>
          </div>

          <div className="pf-field">
            <label>Paper Size</label>
            <select value={paperSize} onChange={(e) => setPaperSize(e.target.value)}>
              <option value="A4">A4</option>
              <option value="A3">A3</option>
            </select>
          </div>
        </div>
      </div>

      {isLocked ? (
        <div className="pf-alert warning" style={{ marginTop: 10 }}>
          ⚠ Machine is out of paper. Payment is disabled.
        </div>
      ) : null}

    </div>
  );
}

// import React from "react";

// import { ImCross } from "react-icons/im";
// import { MdAttachFile } from "react-icons/md";
// // function formatBytes(bytes) {
// //   if (bytes < 1024) return `${bytes} B`;
// //   if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
// //   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
// // }

// const COLOR_LABELS = { bw: "Black & White", color: "Color" };
// const SIDE_LABELS  = { single: "Single Side", duplex: "Duplex" };

// export default function StepSummary({
//   file,
//   jobId,
//   summary,
//   color, setColor,
//   copies, setCopies,
//   printSide, setPrintSide,
//   paperSize, setPaperSize,
//   jobError,
//   jobSuccess,
//   isLocked,
//   onBack,
// }) {
//   return (
//     <div className="pf-step-enter">
//       {!!file && (
//         <div className="pf-file-info">
//           <span><MdAttachFile size={20} /></span>
//           <span className="file-name">{file.name}</span>
//           {/* <span className="file-size">{formatBytes(file.size)}</span> */}
//           {!!onBack && (
//             <button
//               onClick={onBack}
//               title="Remove file and go back"
//               className="pf-remove-btn"
//             >
//              <ImCross size={16} />
//             </button>
//           )}
//         </div>
        
//       )}
     

//       <p className="pf-section-title">🧾 Order Summary</p>

//       {!!summary ? (
//         <div className="pf-summary">
//           <div className="pf-summary-header">
//             <h3>Job Details</h3>
//           </div>
//           <div className="pf-summary-body">
//             <div className="pf-summary-row">
//               <span className="key">Print Type</span>
//               <span className="val">{COLOR_LABELS[summary.color] ?? summary.color}</span>
//             </div>
            
//             <div className="pf-summary-row">
//               <span className="key">Copies</span>
//               <span className="val">{summary.copies}</span>
//             </div>

//             <div className="pf-summary-row">
//               <span className="key">Print Side</span>
//               <span className="val">{SIDE_LABELS[summary.printSide] ?? summary.printSide}</span>
//             </div>

//             {/* CHANGED: Show Total Pages instead of Paper Size */}
//             <div className="pf-summary-row">
//               <span className="key">Total Pages</span>
//               <span className="val">{summary.pages || summary.totalPages || "—"}</span>
//               {/* {summary.pages || summary.totalPages || "—"} */}
//             </div>

//             <div className="pf-summary-total">
//               <span className="label">Total</span>
//               <span className="amount">₹{summary.totalAmount}</span>
//             </div>
//           </div>
//         </div>
//       ) : null}

//       {/* Adjust options before paying */}
//       <p className="pf-section-title">✏️ Adjust Options</p>

//       <div className="pf-grid">
//         <div className="pf-field">
//           <label>Print Type</label>
//           <select value={color} onChange={(e) => setColor(e.target.value)}>
//             <option value="bw">B &amp; W</option>
//             <option value="color">Color</option>
//           </select>
//         </div>

//         <div className="pf-field">
//   <label>Copies</label>

//   <div className="pf-counter">
//     <button
//       type="button"
//       onClick={() => setCopies((prev) => Math.max(1, prev - 1))}
//       className="pf-counter-btn"
//     >
//       −
//     </button>

//     <span className="pf-counter-value">{copies}</span>

//     <button
//       type="button"
//       onClick={() => setCopies((prev) => Math.min(50, prev + 1))}
//       className="pf-counter-btn"
//     >
//       +
//     </button>
//   </div>
// </div>

//         <div className="pf-field">
//           <label>Print Side</label>
//           <select value={printSide} onChange={(e) => setPrintSide(e.target.value)}>
//             <option value="single">Single</option>
//             <option value="duplex">Duplex</option>
//           </select>
//         </div>

//         <div className="pf-field">
//           <label>Paper Size</label>
//           <select value={paperSize} onChange={(e) => setPaperSize(e.target.value)}>
//             <option value="A4">A4</option>
//             <option value="A3">A3</option>
//           </select>
//         </div>
//       </div>

//       {!!isLocked && (
//         <div className="pf-alert warning" style={{ marginTop: 10 }}>
//           ⚠ Machine is out of paper. Payment is disabled.
//         </div>
//       )}
//     </div>
//   );
// }