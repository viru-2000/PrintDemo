// import { useState, useEffect, useCallback } from "react";
// import { QRCodeCanvas } from "qrcode.react";
// //import * as pdfjsLib from "pdfjs-dist";
// //pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

// const MAX_FILE_SIZE = 50 * 1024 * 1024;
// const API_BASE = "http://localhost:5000/api";

// function PrintForm() {
//   const [machineId, setMachineId] = useState("");
//    const [machineStatus, setMachineStatus] = useState(null);
//   const [file, setFile] = useState(null);
//   //const [previewUrl, setPreviewUrl] = useState(null);
//   const [color, setColor] = useState("bw");
//   const [copies, setCopies] = useState(1);
//   const [printSide, setPrintSide] = useState("single");
//   const [paperSize, setPaperSize] = useState("A4");

//   const [jobId, setJobId] = useState(null);
//   const [summary, setSummary] = useState(null);
//   const [otp, setOtp] = useState(null);
//   const [qrToken, setQrToken] = useState(null);

//   const [error, setError] = useState("");
//   const [success, setSuccess] = useState("");

//   /* ===============================
//      GET MACHINE FROM URL
//   =============================== */
//   useEffect(() => {
//     const params = new URLSearchParams(window.location.search);
//     const machine = params.get("machine");
//     if (machine) {
//       setMachineId(machine);
//       fetchStatus(machine);
//     } else {
//       setError("Invalid kiosk link. Machine not specified.");
//     }
//   }, []);

//    const fetchStatus = async (id) => {
//     const res = await fetch(`${API_BASE}/machines/${id}/status`);
//     const data = await res.json();
//     if (res.ok) setMachineStatus(data);
//   };
//   useEffect(() => {
//     if (!jobId || !otp) return;

//     const interval = setInterval(async () => {
//       const res = await fetch(`${API_BASE}/job-status/${jobId}`);
//       const data = await res.json();

//       if (data.status === "PRINTED") {
//         clearInterval(interval);

//         setSuccess("✅ Print completed successfully!");
        
//         setTimeout(() => {
//           window.location.href = `/?machine=${machineId}`;
//         }, 3000);
//       }

//       if (data.status === "FAILED") {
//         clearInterval(interval);
//         setError("❌ Printing failed. Please contact support.");
//       }

//     }, 3000); // check every 3 seconds

//     return () => clearInterval(interval);

//   }, [jobId, otp, machineId]);
//   /* ===============================
//      FILE VALIDATION
//   =============================== */
//  const handleFileChange = async (e) => {
//   setError("");
//   setSuccess("");

//   const selectedFile = e.target.files[0];
//   if (!selectedFile) return;

//   if (selectedFile.type !== "application/pdf") {
//     setError("Only PDF files are allowed.");
//     return;
//   }

//   if (selectedFile.size > MAX_FILE_SIZE) {
//     setError("PDF size must be less than 50MB.");
//     return;
//   }

//   setFile(selectedFile);

//   /* ===============================
//      GENERATE PDF PREVIEW (FIRST PAGE)
//   =============================== */
// //   try {
// //     const fileReader = new FileReader();

// //     fileReader.onload = async function () {
// //       const typedArray = new Uint8Array(this.result);

// //       const pdf = await pdfjsLib.getDocument(typedArray).promise;
// //       const page = await pdf.getPage(1);

// //       const viewport = page.getViewport({ scale: 1.5 });

// //       const canvas = document.createElement("canvas");
// //       const context = canvas.getContext("2d");

// //       canvas.height = viewport.height;
// //       canvas.width = viewport.width;

// //       await page.render({
// //         canvasContext: context,
// //         viewport: viewport,
// //       }).promise;

// //       const imageUrl = canvas.toDataURL();
// //       setPreviewUrl(imageUrl);
// //     };

// //     fileReader.readAsArrayBuffer(selectedFile);

// //   } catch (err) {
// //     console.error("Preview error:", err);
// //   }
// // };

//   const fetchSummary = async (id) => {
//     const res = await fetch(`${API_BASE}/job-summary/${id}`);
//     const data = await res.json();
//     if (res.ok) setSummary(data);
//   };

//   /* ===============================
//      UPDATE JOB (MEMOIZED)
//   =============================== */
//   const updateJob = useCallback(async () => {
//     if (!jobId) return;

//     const res = await fetch(`${API_BASE}/job/${jobId}`, {
//       method: "PATCH",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ color, copies, paperSize, printSide }),
//     });

//     const data = await res.json();
//     if (!res.ok) throw new Error(data.error);

//     await fetchSummary(jobId);
//   }, [jobId, color, copies, paperSize, printSide]);

//   /* ===============================
//      AUTO UPDATE WHEN OPTIONS CHANGE
//   =============================== */
//   useEffect(() => {
//     if (jobId && !otp) {
//       updateJob();
//     }
//   }, [jobId, otp, updateJob]);

//   /* ===============================
//      STEP 1️⃣ UPLOAD JOB
//   =============================== */
//   const handleUploadJob = async () => {
//     setError("");
//     setSuccess("");

//     if (!machineStatus || machineStatus.is_print_locked) {
//       setError("Machine is out of paper. Try later.");
//       return;
//     }
//     if (!machineId || !file) {
//       setError("Machine and PDF are required.");
//       return;
//     }

//     const formData = new FormData();
//     formData.append("pdf", file);
//     formData.append("machineId", machineId);
//     formData.append("color", color);
//     formData.append("copies", copies);
//     formData.append("paperSize", paperSize);
//     formData.append("printSide", printSide);

//     try {
//       const res = await fetch(`${API_BASE}/upload-job`, {
//         method: "POST",
//         body: formData,
//       });

//       const data = await res.json();
//       if (!res.ok) throw new Error(data.error);

//       setJobId(data.jobId);
//       await fetchSummary(data.jobId);
//       setSuccess(`Job created. Job ID: ${data.jobId}`);
//     } catch (err) {
//       setError(err.message || "Upload failed.");
//     }
//   };

//   /* ===============================
//      STEP 2️⃣ PAYMENT
//   =============================== */
//   const startPayment = async () => {
//     setError("");
//     setSuccess("");

//     try {
//       await updateJob();

//       const res = await fetch(`${API_BASE}/create-payment`, {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ jobId }),
//       });

//       const data = await res.json();
//       if (!res.ok) throw new Error(data.error);

//       const options = {
//         key: data.key,
//         amount: data.amount,
//         currency: "INR",
//         order_id: data.orderId,

//         handler: async (response) => {
//           const verifyRes = await fetch(
//             `${API_BASE}/verify-payment`,
//             {
//               method: "POST",
//               headers: { "Content-Type": "application/json" },
//               body: JSON.stringify(response),
//             }
//           );

//           const verifyData = await verifyRes.json();
//           if (!verifyRes.ok) throw new Error(verifyData.error);

//           setOtp(verifyData.otp);
//           setQrToken(verifyData.qrToken);
//           setSuccess("Payment successful. OTP generated.");
//         },

//         theme: { color: "#16a34a" },
//       };

//       const rzp = new window.Razorpay(options);
//       rzp.open();
//     } catch (err) {
//       setError(err.message || "Payment failed.");
//     }
//   };

//   /* ===============================
//      UI
//   =============================== */
//   return (
//     <div style={styles.page}>
//       <div style={styles.card}>
//         <h2 style={styles.title}>📄 Print Document</h2>
//          {machineStatus?.is_print_locked && (
//         <div style={{ color: "red", fontWeight: "bold" }}>
//           ⚠ Machine out of paper. Payment disabled.
//         </div>
//       )}
//         {error && <div style={styles.alertError}>{error}</div>}
//         {success && <div style={styles.alertSuccess}>{success}</div>}

//         {/* FILE */}
//         <div style={styles.formGroup}>
//           <label style={styles.label}>Upload PDF</label>
//           <input
//             type="file"
//             accept="application/pdf"
//             onChange={handleFileChange}
//             style={styles.fileInput}
//           />
//           {file && (
//   <div style={{ marginTop: 15 }}>
//     <p><strong>File:</strong> {file.name}</p>

//     {/* {previewUrl && (
//       <img
//         src={previewUrl}
//         alt="PDF Preview"
//         style={{
//           width: "100%",
//           borderRadius: 8,
//           marginTop: 10,
//           border: "1px solid #ddd"
//         }}
//       />
//     )} */}
//   </div>
// )}
//         </div>

//         {/* OPTIONS */}
//         <div style={styles.row}>
//           <div style={styles.half}>
//             <label style={styles.label}>Print Type</label>
//             <select
//               value={color}
//               onChange={(e) => setColor(e.target.value)}
//               style={styles.input}
//             >
//               <option value="bw">Black & White</option>
//               <option value="color">Color</option>
//             </select>
//           </div>

//           <div style={styles.half}>
//             <label style={styles.label}>Copies</label>
//             <input
//               type="number"
//               min="1"
//               max="50"
//               value={copies}
//               onChange={(e) => setCopies(Number(e.target.value))}
//               style={styles.input}
//             />
//           </div>
//         </div>

//         <div style={styles.row}>
//           <div style={styles.half}>
//             <label style={styles.label}>Print Side</label>
//             <select
//               value={printSide}
//               onChange={(e) => setPrintSide(e.target.value)}
//               style={styles.input}
//             >
//               <option value="single">Single Side</option>
//               <option value="duplex">Duplex</option>
//             </select>
//           </div>

//           <div style={styles.half}>
//             <label style={styles.label}>Paper Size</label>
//             <select
//               value={paperSize}
//               onChange={(e) => setPaperSize(e.target.value)}
//               style={styles.input}
//             >
//               <option value="A4">A4</option>
//               <option value="A3">A3</option>
//             </select>
//           </div>
//         </div>

//         {!jobId && (
//           <button style={styles.primaryButton} onClick={handleUploadJob}>
//             Upload & Create Job
//           </button>
//         )}

//         {summary && (
//           <div style={styles.summaryBox}>
//             <h3>🧾 Order Summary</h3>
//             <p>   Total Amount: ₹{summary.totalAmount}</p>
//              <h3> Copies: {summary.copies}</h3>
//             {/* <p>Total: ₹{summary.copies}</p> */}
//              <h3> Color: {summary.color}</h3>
//             {/* <p>Total: ₹{summary.color}</p> */}
//           </div>
//         )}

//         {jobId && !otp && (
//           <button style={styles.payButton} onClick={startPayment} disabled={machineStatus?.is_print_locked}> 
//             Pay & Generate OTP
//           </button>
//         )}

//         {otp && (
//           <div style={styles.otpBox}>
//             <h2>🔐 OTP: {otp}</h2>
//             <QRCodeCanvas value={qrToken} size={200} />
//           </div>
//         )}
//       </div>
//     </div>
//   );
// }
// // /* ===============================
// //    STYLES
// // =============================== */
// const styles = {
//   page: {
//     minHeight: "100vh",
//     background: "linear-gradient(135deg, #f0f4f8, #e2e8f0)",
//     display: "flex",
//     justifyContent: "center",
//     alignItems: "center",
//     padding: 20,
//   },

//   card: {
//     width: "100%",
//     maxWidth: 500,
//     background: "#ffffff",
//     padding: 30,
//     borderRadius: 12,
//     boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
//   },

//   title: {
//     marginBottom: 20,
//     textAlign: "center",
//     fontSize: 22,
//     fontWeight: 600,
//   },

//   formGroup: {
//     marginBottom: 15,
//   },

//   row: {
//     display: "flex",
//     gap: 12,
//     marginBottom: 15,
//   },

//   half: {
//     flex: 1,
//   },

//   label: {
//     fontSize: 14,
//     fontWeight: 500,
//     marginBottom: 5,
//     display: "block",
//   },

//   input: {
//     width: "100%",
//     padding: 10,
//     borderRadius: 6,
//     border: "1px solid #cbd5e1",
//     fontSize: 14,
//   },

//   fileInput: {
//     marginTop: 5,
//   },

//   primaryButton: {
//     marginTop: 10,
//     width: "100%",
//     padding: 12,
//     backgroundColor: "#2563eb",
//     color: "#fff",
//     border: "none",
//     borderRadius: 8,
//     fontWeight: 600,
//     cursor: "pointer",
//   },

//   payButton: {
//     marginTop: 15,
//     width: "100%",
//     padding: 12,
//     backgroundColor: "#16a34a",
//     color: "#fff",
//     border: "none",
//     borderRadius: 8,
//     fontWeight: 600,
//     cursor: "pointer",
//   },

//   summaryBox: {
//     marginTop: 20,
//     padding: 15,
//     background: "#f8fafc",
//     borderRadius: 8,
//     border: "1px solid #e2e8f0",
//   },

//   summaryTitle: {
//     marginBottom: 10,
//   },

//   total: {
//     marginTop: 10,
//     color: "#16a34a",
//   },

//   otpBox: {
//     marginTop: 20,
//     textAlign: "center",
//     padding: 20,
//     background: "#ecfdf5",
//     borderRadius: 10,
//   },

//   otpText: {
//     color: "#065f46",
//   },

//   alertError: {
//     background: "#fee2e2",
//     padding: 10,
//     borderRadius: 6,
//     color: "#b91c1c",
//     marginBottom: 10,
//   },

//   alertSuccess: {
//     background: "#dcfce7",
//     padding: 10,
//     borderRadius: 6,
//     color: "#166534",
//     marginBottom: 10,
//   },
// };


//export default PrintForm;
"use client"

import { useState, useEffect, useCallback } from "react";
import { QRCodeCanvas } from "qrcode.react";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
// const API_BASE = "http://192.168.0.108:5000/api";
const API_BASE = process.env.REACT_APP_API_BASE || "http://192.168.0.108:5000/api";

function PrintForm() {

  const [machineId, setMachineId] = useState("");
  const [machineStatus, setMachineStatus] = useState(null);
  const [file, setFile] = useState(null);

  const [color, setColor] = useState("bw");
  const [copies, setCopies] = useState(1);
  const [printSide, setPrintSide] = useState("single");
  const [paperSize, setPaperSize] = useState("A4");

  const [jobId, setJobId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [otp, setOtp] = useState(null);
  const [qrToken, setQrToken] = useState(null);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  /* ===============================
     GET MACHINE FROM URL
  =============================== */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const machine = params.get("machine");

    if (machine) {
      setMachineId(machine);
      fetchStatus(machine);
    } else {
      setError("Invalid kiosk link. Machine not specified.");
    }
  }, []);

  const fetchStatus = async (id) => {
    const res = await fetch(`${API_BASE}/machines/${id}/status`);
    const data = await res.json();

    if (res.ok) setMachineStatus(data);
  };

  /* ===============================
     AUTO STATUS CHECK (PRINT COMPLETE)
  =============================== */
  useEffect(() => {
    if (!jobId || !otp) return;

    const interval = setInterval(async () => {
      const res = await fetch(`${API_BASE}/job-status/${jobId}`);
      const data = await res.json();

      if (data.status === "PRINTED") {
        clearInterval(interval);

        setSuccess("✅ Print completed successfully!");

        setTimeout(() => {
          window.location.href = `/?machine=${machineId}`;
        }, 3000);
      }

      if (data.status === "FAILED") {
        clearInterval(interval);
        setError("❌ Printing failed. Please contact support.");
      }

    }, 3000);

    return () => clearInterval(interval);

  }, [jobId, otp, machineId]);

  /* ===============================
     FILE VALIDATION
  =============================== */
  const handleFileChange = (e) => {
    setError("");
    setSuccess("");

    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    if (selectedFile.type !== "application/pdf") {
      setError("Only PDF files are allowed.");
      return;
    }

    if (selectedFile.size > MAX_FILE_SIZE) {
      setError("PDF size must be less than 50MB.");
      return;
    }

    setFile(selectedFile);
  };

  const fetchSummary = async (id) => {
    const res = await fetch(`${API_BASE}/job-summary/${id}`);
    const data = await res.json();

    if (res.ok) setSummary(data);
  };

  /* ===============================
     UPDATE JOB
  =============================== */
  const updateJob = useCallback(async () => {
    if (!jobId) return;

    const res = await fetch(`${API_BASE}/job/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color, copies, paperSize, printSide }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    await fetchSummary(jobId);

  }, [jobId, color, copies, paperSize, printSide]);

  useEffect(() => {
    if (jobId && !otp) {
      updateJob();
    }
  }, [jobId, otp, updateJob]);

  /* ===============================
     STEP 1️⃣ UPLOAD
  =============================== */
  const handleUploadJob = async () => {
    setError("");
    setSuccess("");

    if (!machineStatus || machineStatus.is_print_locked) {
      setError("Machine is out of paper. Try later.");
      return;
    }

    if (!machineId || !file) {
      setError("Machine and PDF are required.");
      return;
    }

    const formData = new FormData();
    formData.append("pdf", file);
    formData.append("machineId", machineId);
    formData.append("color", color);
    formData.append("copies", copies);
    formData.append("paperSize", paperSize);
    formData.append("printSide", printSide);

    try {
      const res = await fetch(`${API_BASE}/upload-job`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setJobId(data.jobId);
      await fetchSummary(data.jobId);

      setSuccess(`Job created. Job ID: ${data.jobId}`);

    } catch (err) {
      setError(err.message || "Upload failed.");
    }
  };

  /* ===============================
     STEP 2️⃣ PAYMENT
  =============================== */
  const startPayment = async () => {
    setError("");
    setSuccess("");

    try {
      await updateJob();

      const res = await fetch(`${API_BASE}/create-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const options = {
        key: data.key,
        amount: data.amount,
        currency: "INR",
        order_id: data.orderId,

        handler: async (response) => {
          const verifyRes = await fetch(`${API_BASE}/verify-payment`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          });

          const verifyData = await verifyRes.json();
          if (!verifyRes.ok) throw new Error(verifyData.error);

          setOtp(verifyData.otp);
          setQrToken(verifyData.qrToken);
          setSuccess("Payment successful. OTP generated.");
        },

        theme: { color: "#16a34a" },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();

    } catch (err) {
      setError(err.message || "Payment failed.");
    }
  };

  /* ===============================
     UI
  =============================== */
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h2 style={styles.title}>📄 Print Document</h2>

        {machineStatus?.is_print_locked && (
          <div style={{ color: "red", fontWeight: "bold" }}>
            ⚠ Machine out of paper. Payment disabled.
          </div>
        )}

        {error && <div style={styles.alertError}>{error}</div>}
        {success && <div style={styles.alertSuccess}>{success}</div>}

        {/* FILE */}
        <div style={styles.formGroup}>
          <label style={styles.label}>Upload PDF</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
            style={styles.fileInput}
          />

          {file && (
            <div style={{ marginTop: 10 }}>
              <strong>File:</strong> {file.name}
            </div>
          )}
        </div>

        {/* OPTIONS */}
        <div style={styles.row}>
          <div style={styles.half}>
            <label style={styles.label}>Print Type</label>
            <select value={color} onChange={(e) => setColor(e.target.value)} style={styles.input}>
              <option value="bw">Black & White</option>
              <option value="color">Color</option>
            </select>
          </div>

          <div style={styles.half}>
            <label style={styles.label}>Copies</label>
            <input
              type="number"
              min="1"
              max="50"
              value={copies}
              onChange={(e) => setCopies(Number(e.target.value))}
              style={styles.input}
            />
          </div>
        </div>

        <div style={styles.row}>
          <div style={styles.half}>
            <label style={styles.label}>Print Side</label>
            <select value={printSide} onChange={(e) => setPrintSide(e.target.value)} style={styles.input}>
              <option value="single">Single Side</option>
              <option value="duplex">Duplex</option>
            </select>
          </div>

          <div style={styles.half}>
            <label style={styles.label}>Paper Size</label>
            <select value={paperSize} onChange={(e) => setPaperSize(e.target.value)} style={styles.input}>
              <option value="A4">A4</option>
              <option value="A3">A3</option>
            </select>
          </div>
        </div>

        {!jobId && (
          <button style={styles.primaryButton} onClick={handleUploadJob}>
            Upload & Create Job
          </button>
        )}

        {summary && (
          <div style={styles.summaryBox}>
            <h3>🧾 Order Summary</h3>
            <p>Total Amount: ₹{summary.totalAmount}</p>
            <p>Copies: {summary.copies}</p>
            <p>Color: {summary.color}</p>
          </div>
        )}

        {jobId && !otp && (
          <button
            style={styles.payButton}
            onClick={startPayment}
            disabled={machineStatus?.is_print_locked}
          >
            Pay & Generate OTP
          </button>
        )}

        {otp && (
          <div style={styles.otpBox}>
            <h2>🔐 OTP: {otp}</h2>
            <QRCodeCanvas value={qrToken} size={200} />
          </div>
        )}
      </div>
    </div>
  );
}

// /* ===============================
//    STYLES
// =============================== */
const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #f0f4f8, #e2e8f0)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },

  card: {
    width: "100%",
    maxWidth: 500,
    background: "#ffffff",
    padding: 30,
    borderRadius: 12,
    boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
  },

  title: {
    marginBottom: 20,
    textAlign: "center",
    fontSize: 22,
    fontWeight: 600,
  },

  formGroup: {
    marginBottom: 15,
  },

  row: {
    display: "flex",
    gap: 12,
    marginBottom: 15,
  },

  half: {
    flex: 1,
  },

  label: {
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 5,
    display: "block",
  },

  input: {
    width: "100%",
    padding: 10,
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    fontSize: 14,
  },

  fileInput: {
    marginTop: 5,
  },

  primaryButton: {
    marginTop: 10,
    width: "100%",
    padding: 12,
    backgroundColor: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontWeight: 600,
    cursor: "pointer",
  },

  payButton: {
    marginTop: 15,
    width: "100%",
    padding: 12,
    backgroundColor: "#16a34a",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontWeight: 600,
    cursor: "pointer",
  },

  summaryBox: {
    marginTop: 20,
    padding: 15,
    background: "#f8fafc",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
  },

  summaryTitle: {
    marginBottom: 10,
  },

  total: {
    marginTop: 10,
    color: "#16a34a",
  },

  otpBox: {
    marginTop: 20,
    textAlign: "center",
    padding: 20,
    background: "#ecfdf5",
    borderRadius: 10,
  },

  otpText: {
    color: "#065f46",
  },

  alertError: {
    background: "#fee2e2",
    padding: 10,
    borderRadius: 6,
    color: "#b91c1c",
    marginBottom: 10,
  },

  alertSuccess: {
    background: "#dcfce7",
    padding: 10,
    borderRadius: 6,
    color: "#166534",
    marginBottom: 10,
  },
};
export default PrintForm;

