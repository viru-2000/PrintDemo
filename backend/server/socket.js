const { Server } = require("socket.io");

let io = null;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "*",
    },
  });

  io.on("connection", (socket) => {
    console.log("🔌 Client connected:", socket.id);

    socket.on("disconnect", () => {
      console.log("❌ Client disconnected:", socket.id);
    });
  });

  console.log("✅ Socket.io initialized");
}

// ✅ SAFE getter (prevents crashes)
function getIO() {
  if (!io) {
    console.warn("⚠️ Socket not initialized — using no-op emitter");
    return {
      emit: () => {},
    };
  }
  return io;
}

module.exports = { initSocket, getIO };