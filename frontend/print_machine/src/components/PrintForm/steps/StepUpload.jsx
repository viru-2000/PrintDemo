// steps/StepUpload.jsx
import React from "react";
import { MdAttachFile } from "react-icons/md";

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function StepUpload({
  file,
  handleFileChange,
  fileError,
  color, setColor,
  copies, setCopies,
  printSide, setPrintSide,
  paperSize, setPaperSize,
  isLocked,
  jobError,
}) {
  return (
    <div className="pf-step-enter">

      <p className="pf-section-title">Accepted formats:PDF,DOCX,JPG,PNG.MAX 100MB perfile</p>

      <div className={`pf-dropzone ${file ? "has-file" : ""}`}>
        <input
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
        />
        {!file ? (
          <>
            <div className="pf-dropzone-icon">📄</div>
            <div className="pf-dropzone-text">Select file</div>
            {/* <div className="pf-dropzone-hint">PDF only · Max 50 MB</div> */}
          </>
        ) : (
          <>
            <div className="pf-dropzone-icon">✅</div>
            <div className="pf-dropzone-text">File selected</div>
            <div className="pf-dropzone-hint">We delete your files once printed</div>
          </>
        )}
      </div>

      {fileError ? (
        <div className="pf-alert error">⚠ {fileError}</div>
      ) : null}

      {file ? (
        <div className="pf-file-info">
          <span style={{ color: "var(--lime)", display: "flex" }}>
            <MdAttachFile size={16} />
          </span>
          <span className="file-name">{file.name}</span>
          <span className="file-size">{formatBytes(file.size)}</span>
        </div>
      ) : null}

      {file ? (
        <>
          <div className="pf-divider" />
          <p className="pf-section-title">Print Options</p>

          <div className="pf-grid">
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
        </>
      ) : null}

      {jobError ? (
        <div className="pf-alert error" style={{ marginTop: 10 }}>⚠ {jobError}</div>
      ) : null}

      {isLocked ? (
        <div className="pf-alert warning" style={{ marginTop: 10 }}>
          ⚠ Machine is out of paper. Printing is unavailable.
        </div>
      ) : null}

    </div>
  );
}