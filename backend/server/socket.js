// const { Server } = require("socket.io");

// let io = null;

// function initSocket(server) {
//   io = new Server(server, {
//     cors: {
//       origin: "*",
//     },
//   });

//   io.on("connection", (socket) => {
//     console.log("Admin connected:", socket.id);
//     socket.on("disconnect", () => {
//       console.log("Admin disconnected:", socket.id);
//     });
//   });

//   console.log("✅ Socket.io initialized");
// }

// // ✅ Safe getter — returns a no-op emitter if socket is not yet initialized
// // This prevents crashes on routes that call getIO() before initSocket()
// function getIO() {
//   if (!io) {
//     console.warn("⚠️ Socket not initialized — using no-op emitter");
//     return {
//       emit: () => {},
//     };
//   }
//   return io;
// }

// module.exports = { initSocket, getIO };


// // const { Server } = require("socket.io");

// // let io;

// // function initSocket(server) {
// //   io = new Server(server, {
// //     cors: {
// //       origin: "*"
// //     }
// //   });

// //   io.on("connection", (socket) => {
// //     console.log("Admin connected:", socket.id);

// //     socket.on("disconnect", () => {
// //       console.log("Admin disconnected");
// //     });
// //   });
// // }

// // function getIO() {
// //   if (!io) {
// //     throw new Error("Socket not initialized");
// //   }
// //   return io;
// // }

// // module.exports = { initSocket, getIO };