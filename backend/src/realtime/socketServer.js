const { Server } = require("socket.io");

const eventBus = require("./eventBus");
const { supabaseAdmin } = require("../client/supabase");
const { getAuthFromToken } = require("../middlewares/auth");

const validateSocketAuth = async (socket, requiredRoles = []) => {
  const token = socket.handshake.auth?.token || null;
  if (!token) {
    throw new Error("Missing auth token");
  }

  const auth = await getAuthFromToken(token);
  const role = auth.role;

  if (requiredRoles.length > 0 && !requiredRoles.includes(role)) {
    throw new Error("Forbidden role");
  }

  return {
    citizen: auth.citizen,
    role,
    session_id: auth.session.id,
  };
};

const persistVoiceTranscript = async (payload) => {
  const complaintId =
    typeof payload.complaint_id === "string" ? payload.complaint_id.trim() : "";
  const transcriptText =
    typeof payload.transcript_text === "string" ? payload.transcript_text.trim() : "";

  if (!complaintId || !transcriptText) {
    return;
  }

  await supabaseAdmin.from("ai_outputs").insert({
    complaint_id: complaintId,
    transcript_text: transcriptText,
    transcript_confidence:
      payload.transcript_confidence != null
        ? Number(payload.transcript_confidence)
        : null,
    model_name:
      typeof payload.model_name === "string" && payload.model_name.trim().length > 0
        ? payload.model_name.trim()
        : "streaming-stt",
  });

  await supabaseAdmin.from("complaint_events").insert({
    complaint_id: complaintId,
    event_type: "voice_transcript_received",
    old_value: null,
    new_value: {
      transcript_text: transcriptText,
      source: "socket",
    },
    actor_type: "system",
    note: "Streaming transcript received via voice socket",
  });
};

const initializeSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  const opsNamespace = io.of("/ops");
  const voiceNamespace = io.of("/voice");

  opsNamespace.use(async (socket, next) => {
    try {
      const auth = await validateSocketAuth(socket, ["admin", "manager", "officer"]);
      socket.data.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  });

  voiceNamespace.use(async (socket, next) => {
    try {
      const auth = await validateSocketAuth(socket);
      socket.data.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  });

  opsNamespace.on("connection", (socket) => {
    socket.on("ops:join", (payload = {}) => {
      if (typeof payload.room === "string" && payload.room.trim()) {
        socket.join(payload.room.trim());
      }
    });
  });

  voiceNamespace.on("connection", (socket) => {
    socket.on("voice:join", (payload = {}) => {
      if (typeof payload.session_id === "string" && payload.session_id.trim()) {
        socket.join(payload.session_id.trim());
      }
    });

    socket.on("voice:chunk", (payload = {}, ack) => {
      const sessionId =
        typeof payload.session_id === "string" ? payload.session_id.trim() : "";

      if (!sessionId) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "session_id is required" });
        }
        return;
      }

      voiceNamespace.to(sessionId).emit("voice:chunk", payload);
      opsNamespace.emit("voice:chunk_received", {
        session_id: sessionId,
        sequence: payload.sequence || null,
        timestamp: Date.now(),
      });

      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });

    socket.on("voice:transcript", async (payload = {}, ack) => {
      const sessionId =
        typeof payload.session_id === "string" ? payload.session_id.trim() : "";

      if (!sessionId) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "session_id is required" });
        }
        return;
      }

      try {
        await persistVoiceTranscript(payload);
      } catch (_error) {
      }

      voiceNamespace.to(sessionId).emit("voice:transcript", payload);
      opsNamespace.emit("voice:transcript_received", {
        session_id: sessionId,
        complaint_id: payload.complaint_id || null,
        transcript_text: payload.transcript_text || "",
        timestamp: Date.now(),
      });

      if (typeof ack === "function") {
        ack({ ok: true });
      }
    });
  });

  eventBus.on("complaint:created", (payload) => {
    opsNamespace.emit("complaint:created", payload);
  });

  eventBus.on("complaint:status_updated", (payload) => {
    opsNamespace.emit("complaint:status_updated", payload);
  });

  eventBus.on("complaint:deleted", (payload) => {
    opsNamespace.emit("complaint:deleted", payload);
  });

  eventBus.on("call:incoming", (payload) => {
    opsNamespace.emit("call:incoming", payload);
  });

  return io;
};

module.exports = {
  initializeSocketServer,
};
