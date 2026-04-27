// // constants.js
// // export const API_BASE = "http://192.168.0.108:5000/api";
// export const API_BASE= "http://192.168.0.106:5000/api";
// export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// export const STEPS = [
//   { id: 1, label: "Upload" },
//   { id: 2, label: "Pay" },
//   { id: 3, label: "Collect" },
// ];

// constants.js
export const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:5000/api";
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export const STEPS = [
  { id: 1, label: "Upload" },
  { id: 2, label: "Pay" },
  { id: 3, label: "Collect" },
];