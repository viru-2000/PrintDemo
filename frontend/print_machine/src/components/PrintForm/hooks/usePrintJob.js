// hooks/usePrintJob.js
import { useState, useEffect, useCallback, useMemo } from "react";
import { API_BASE } from "../constants";

export function usePrintJob({ machineId, machineStatus, onJobComplete }) {
  // Print options
  const [color, setColor] = useState("bw");
  const [copies, setCopies] = useState(1);
  const [printSide, setPrintSide] = useState("single");
  const [paperSize, setPaperSize] = useState("A4");
  const [file, setFile] = useState(null);

  // Job state
  const [jobId, setJobId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [otp, setOtp] = useState(null);
  const [qrToken, setQrToken] = useState(null);

  // UI state
  const [uploading, setUploading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [fileError, setFileError] = useState("");
  const [jobError, setJobError] = useState("");
  const [jobSuccess, setJobSuccess] = useState("");

  /* -----------------------------------------------
     RESET JOB
  ----------------------------------------------- */
  const resetJob = useCallback(() => {
    setJobId(null);
    setSummary(null);
    setFile(null);
    setJobError("");
    setJobSuccess("");
    setColor("bw");
    setCopies(1);
    setPrintSide("single");
    setPaperSize("A4");
  }, []);

  /* -----------------------------------------------
     FILE VALIDATION
  ----------------------------------------------- */
  const handleFileChange = (e) => {
    setFileError("");
    setJobError("");
    const selected = e.target.files[0];
    if (!selected) return;

    if (selected.type !== "application/pdf") {
      setFileError("Only PDF files are allowed.");
      return;
    }

    const MAX = 50 * 1024 * 1024;
    if (selected.size > MAX) {
      setFileError("PDF size must be less than 50MB.");
      return;
    }

    setFile(selected);
  };

  /* -----------------------------------------------
     INSTANT LOCAL PRICE CALCULATION
  ----------------------------------------------- */
  const localSummary = useMemo(() => {
    if (!summary) return null;

    const pages = summary.pages || summary.totalPages || 0;

    let rate;
    if (color === "bw") {
      rate = printSide === "duplex" ? 4 : 2;
    } else {
      rate = printSide === "duplex" ? 10 : 5;
    }

    const units =
      printSide === "duplex"
        ? Math.ceil(pages / 2) * copies
        : pages * copies;

    return {
      ...summary,
      color,
      copies,
      printSide,
      totalAmount: units * rate,
    };
  }, [summary, color, copies, printSide]);

  /* -----------------------------------------------
     FETCH SUMMARY — runs in background after upload
  ----------------------------------------------- */
  const fetchSummary = useCallback(async (id) => {
    try {
      const res = await fetch(`${API_BASE}/job-summary/${id}`);
      const data = await res.json();
      if (res.ok) setSummary(data);
    } catch {
      // Non-critical — summary just won't show
    }
  }, []);

  /* -----------------------------------------------
     DEBOUNCED BACKEND SYNC
  ----------------------------------------------- */
  const updateJob = useCallback(async () => {
    if (!jobId) return;
    const res = await fetch(`${API_BASE}/job/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color, copies, paperSize, printSide }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to update job.");
  }, [jobId, color, copies, paperSize, printSide]);

  useEffect(() => {
    if (!jobId || otp) return;
    const timer = setTimeout(() => {
      updateJob().catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [jobId, otp, updateJob]);

  /* -----------------------------------------------
     STEP 1 — UPLOAD
     FIX: setJobId immediately after upload response,
     then fetch summary in the background.
     This makes the step transition instant.
  ----------------------------------------------- */
  const handleUploadJob = async () => {
    setJobError("");
    setJobSuccess("");

    if (machineStatus?.is_print_locked) {
      setJobError("Machine is out of paper. Please try later.");
      return;
    }

    if (!machineId || !file) {
      setJobError("Please select a PDF file to continue.");
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
      setUploading(true);
      const res = await fetch(`${API_BASE}/upload-job`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");

      // ✅ Move to step 2 immediately — don't wait for summary
      setJobId(data.jobId);
      setJobSuccess("Job created successfully.");

      // Fetch summary in the background — UI already moved on
      fetchSummary(data.jobId);

    } catch (err) {
      setJobError(err.message || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  /* -----------------------------------------------
     STEP 2 — PAYMENT
     FIX: fire updateJob in background, don't await it.
     Open Razorpay immediately.
  ----------------------------------------------- */
  const startPayment = async () => {
    setJobError("");
    setJobSuccess("");

    try {
      setPaying(true);

      // ✅ Sync job options in background — don't block payment open
      updateJob().catch(() => {});

      const res = await fetch(`${API_BASE}/create-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not initiate payment.");

      const options = {
        key: data.key,
        amount: data.amount,
        currency: "INR",
        order_id: data.orderId,
        handler: async (response) => {
          try {
            const verifyRes = await fetch(`${API_BASE}/verify-payment`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok)
              throw new Error(verifyData.error || "Payment verification failed.");

            setOtp(verifyData.otp);
            setQrToken(verifyData.qrToken);
            setJobSuccess("Payment successful! Use your OTP or QR to collect prints.");
          } catch (err) {
            setJobError(err.message || "Payment verification failed.");
          }
        },
        modal: {
          ondismiss: () => {
            setPaying(false);
          },
        },
        theme: { color: "#15803d" },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      setJobError(err.message || "Payment failed. Please try again.");
      setPaying(false);
    }
  };

  /* -----------------------------------------------
     STEP 3 — POLL JOB STATUS AFTER OTP
  ----------------------------------------------- */
  useEffect(() => {
    if (!jobId || !otp) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/job-status/${jobId}`);
        const data = await res.json();

        if (data.status === "PRINTED") {
          clearInterval(interval);
          onJobComplete?.("success");
          setTimeout(() => {
            window.location.replace(window.location.origin);
          }, 3000);
        }

        if (data.status === "FAILED") {
          clearInterval(interval);
          setJobError("Printing failed. Please contact support.");
        }
      } catch {
        // Polling failure — silently continue
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [jobId, otp, machineId, onJobComplete]);

  return {
    // Options
    color, setColor,
    copies, setCopies,
    printSide, setPrintSide,
    paperSize, setPaperSize,
    file, handleFileChange,

    // Job
    jobId,
    summary: localSummary,
    otp,
    qrToken,

    // Actions
    handleUploadJob,
    startPayment,
    resetJob,

    // UI
    uploading,
    paying,
    fileError,
    jobError,
    jobSuccess,
    clearJobError: () => setJobError(""),
    clearJobSuccess: () => setJobSuccess(""),
  };
}




// // hooks/usePrintJob.js
// import { useState, useEffect, useCallback, useMemo } from "react";
// import { API_BASE } from "../constants";

// export function usePrintJob({ machineId, machineStatus, onJobComplete }) {
//   // Print options
//   const [color, setColor] = useState("bw");
//   const [copies, setCopies] = useState(1);
//   const [printSide, setPrintSide] = useState("single");
//   const [paperSize, setPaperSize] = useState("A4");
//   const [file, setFile] = useState(null);

//   // Job state
//   const [jobId, setJobId] = useState(null);
//   const [summary, setSummary] = useState(null);
//   const [otp, setOtp] = useState(null);
//   const [qrToken, setQrToken] = useState(null);

//   // UI state
//   const [uploading, setUploading] = useState(false);
//   const [paying, setPaying] = useState(false);
//   const [fileError, setFileError] = useState("");
//   const [jobError, setJobError] = useState("");
//   const [jobSuccess, setJobSuccess] = useState("");

//   /* -----------------------------------------------
//      RESET JOB — resets everything including options
//   ----------------------------------------------- */
//   const resetJob = useCallback(() => {
//     setJobId(null);
//     setSummary(null);
//     setFile(null);
//     setJobError("");
//     setJobSuccess("");
//     setColor("bw");
//     setCopies(1);
//     setPrintSide("single");
//     setPaperSize("A4");
//   }, []);

//   /* -----------------------------------------------
//      FILE VALIDATION
//   ----------------------------------------------- */
//   const handleFileChange = (e) => {
//     setFileError("");
//     setJobError("");
//     const selected = e.target.files[0];
//     if (!selected) return;

//     if (selected.type !== "application/pdf") {
//       setFileError("Only PDF files are allowed.");
//       return;
//     }

//     const MAX = 50 * 1024 * 1024;
//     if (selected.size > MAX) {
//       setFileError("PDF size must be less than 50MB.");
//       return;
//     }

//     setFile(selected);
//   };

//   /* -----------------------------------------------
//      INSTANT LOCAL PRICE CALCULATION
//      Mirrors calculatePrice() from backend exactly.
//      Updates immediately on every copies/color/printSide change.
//   ----------------------------------------------- */
//   const localSummary = useMemo(() => {
//     if (!summary) return null;

//     const pages = summary.pages || summary.totalPages || 0;

//     let rate;
//     if (color === "bw") {
//       rate = printSide === "duplex" ? 4 : 2;
//     } else {
//       rate = printSide === "duplex" ? 10 : 5;
//     }

//     const units =
//       printSide === "duplex"
//         ? Math.ceil(pages / 2) * copies
//         : pages * copies;

//     return {
//       ...summary,
//       color,
//       copies,
//       printSide,
//       totalAmount: units * rate,
//     };
//   }, [summary, color, copies, printSide]);

//   /* -----------------------------------------------
//      FETCH SUMMARY (only called once after upload)
//   ----------------------------------------------- */
//   const fetchSummary = useCallback(async (id) => {
//     try {
//       const res = await fetch(`${API_BASE}/job-summary/${id}`);
//       const data = await res.json();
//       if (res.ok) setSummary(data);
//     } catch {
//       // Non-critical — summary just won't show
//     }
//   }, []);

//   /* -----------------------------------------------
//      UPDATE JOB ON BACKEND
//      Debounced 600ms so backend stays in sync
//      but UI is already instant via localSummary above.
//   ----------------------------------------------- */
//   const updateJob = useCallback(async () => {
//     if (!jobId) return;
//     const res = await fetch(`${API_BASE}/job/${jobId}`, {
//       method: "PATCH",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ color, copies, paperSize, printSide }),
//     });
//     const data = await res.json();
//     if (!res.ok) throw new Error(data.error || "Failed to update job.");
//   }, [jobId, color, copies, paperSize, printSide]);

//   useEffect(() => {
//     if (!jobId || otp) return;
//     const timer = setTimeout(() => {
//       updateJob().catch(() => {});
//     }, 600);
//     return () => clearTimeout(timer);
//   }, [jobId, otp, updateJob]);

//   /* -----------------------------------------------
//      STEP 1 — UPLOAD
//   ----------------------------------------------- */
//   const handleUploadJob = async () => {
//     setJobError("");
//     setJobSuccess("");

//     if (machineStatus?.is_print_locked) {
//       setJobError("Machine is out of paper. Please try later.");
//       return;
//     }

//     if (!machineId || !file) {
//       setJobError("Please select a PDF file to continue.");
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
//       setUploading(true);
//       const res = await fetch(`${API_BASE}/upload-job`, {
//         method: "POST",
//         body: formData,
//       });
//       const data = await res.json();
//       if (!res.ok) throw new Error(data.error || "Upload failed.");

//       setJobId(data.jobId);
//       await fetchSummary(data.jobId);
//       setJobSuccess("Job created successfully.");
//     } catch (err) {
//       setJobError(err.message || "Upload failed. Please try again.");
//     } finally {
//       setUploading(false);
//     }
//   };

//   /* -----------------------------------------------
//      STEP 2 — PAYMENT
//   ----------------------------------------------- */
//   const startPayment = async () => {
//     setJobError("");
//     setJobSuccess("");

//     try {
//       setPaying(true);
//       await updateJob();

//       const res = await fetch(`${API_BASE}/create-payment`, {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ jobId }),
//       });
//       const data = await res.json();
//       if (!res.ok) throw new Error(data.error || "Could not initiate payment.");

//       const options = {
//         key: data.key,
//         amount: data.amount,
//         currency: "INR",
//         order_id: data.orderId,
//         handler: async (response) => {
//           try {
//             const verifyRes = await fetch(`${API_BASE}/verify-payment`, {
//               method: "POST",
//               headers: { "Content-Type": "application/json" },
//               body: JSON.stringify(response),
//             });
//             const verifyData = await verifyRes.json();
//             if (!verifyRes.ok)
//               throw new Error(verifyData.error || "Payment verification failed.");

//             setOtp(verifyData.otp);
//             setQrToken(verifyData.qrToken);
//             setJobSuccess("Payment successful! Use your OTP or QR to collect prints.");
//           } catch (err) {
//             setJobError(err.message || "Payment verification failed.");
//           }
//         },
//         modal: {
//           ondismiss: () => {
//             setPaying(false);
//           },
//         },
//         theme: { color: "#15803d" },
//       };

//       const rzp = new window.Razorpay(options);
//       rzp.open();
//     } catch (err) {
//       setJobError(err.message || "Payment failed. Please try again.");
//       setPaying(false);
//     }
//   };

//   /* -----------------------------------------------
//      STEP 3 — POLL JOB STATUS AFTER OTP
//   ----------------------------------------------- */
//   useEffect(() => {
//     if (!jobId || !otp) return;

//     const interval = setInterval(async () => {
//       try {
//         const res = await fetch(`${API_BASE}/job-status/${jobId}`);
//         const data = await res.json();

//         if (data.status === "PRINTED") {
//           clearInterval(interval);
//           onJobComplete?.("success");
//           setTimeout(() => {
//             // sessionStorage still has machineId — clean URL redirect
//             window.location.replace(window.location.origin);
//           }, 3000);
//         }

//         if (data.status === "FAILED") {
//           clearInterval(interval);
//           setJobError("Printing failed. Please contact support.");
//         }
//       } catch {
//         // Polling failure — silently continue
//       }
//     }, 3000);

//     return () => clearInterval(interval);
//   }, [jobId, otp, machineId, onJobComplete]);

//   return {
//     // Options
//     color, setColor,
//     copies, setCopies,
//     printSide, setPrintSide,
//     paperSize, setPaperSize,
//     file, handleFileChange,

//     // Job
//     jobId,
//     summary: localSummary,
//     otp,
//     qrToken,

//     // Actions
//     handleUploadJob,
//     startPayment,
//     resetJob,

//     // UI
//     uploading,
//     paying,
//     fileError,
//     jobError,
//     jobSuccess,
//     clearJobError: () => setJobError(""),
//     clearJobSuccess: () => setJobSuccess(""),
//   };
// }