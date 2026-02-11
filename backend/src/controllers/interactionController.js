const { createComplaintRecord, createHttpError, isNonEmptyString } = require("./complaintController");
const eventBus = require("../realtime/eventBus");

const createChatInteraction = async (req, res, next) => {
  try {
    const body = req.body || {};

    const complaint = await createComplaintRecord(
      {
        phone_number: body.phone_number,
        name: body.name,
        preferred_language: body.preferred_language,
        channel: body.channel || "whatsapp",
        raw_text: body.message_text,
        category: body.category,
        priority: body.priority,
        location_text: body.location_text,
        latitude: body.latitude,
        longitude: body.longitude,
        ward_id: body.ward_id,
        department_id: body.department_id,
        source_message_id: body.source_message_id,
        media: Array.isArray(body.media) ? body.media : [],
      },
      {
        actorType: "system",
        note: "Complaint created via app/web chat mode",
      }
    );

    eventBus.emit("complaint:created", {
      complaint_id: complaint.id,
      complaint_number: complaint.complaint_number,
      channel: complaint.channel,
      status: complaint.status,
      source: "chat_mode",
    });

    res.status(201).json({
      success: true,
      mode: "chat",
      data: complaint,
    });
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

const createVoiceInteraction = async (req, res, next) => {
  try {
    const body = req.body || {};
    const sessionId = isNonEmptyString(body.session_id) ? body.session_id.trim() : "";

    if (!sessionId) {
      throw createHttpError(400, "session_id is required for voice mode");
    }

    const complaint = await createComplaintRecord(
      {
        phone_number: body.phone_number,
        name: body.name,
        preferred_language: body.preferred_language,
        channel: "voice",
        raw_text: isNonEmptyString(body.initial_text)
          ? body.initial_text.trim()
          : "Voice interaction started",
        category: body.category,
        priority: body.priority,
        location_text: body.location_text,
        latitude: body.latitude,
        longitude: body.longitude,
        ward_id: body.ward_id,
        department_id: body.department_id,
        source_call_id: body.source_call_id || sessionId,
        media: Array.isArray(body.media) ? body.media : [],
      },
      {
        actorType: "system",
        note: "Complaint created via app/web voice mode",
      }
    );

    eventBus.emit("complaint:created", {
      complaint_id: complaint.id,
      complaint_number: complaint.complaint_number,
      channel: complaint.channel,
      status: complaint.status,
      source: "voice_mode",
      session_id: sessionId,
    });

    eventBus.emit("call:incoming", {
      session_id: sessionId,
      complaint_id: complaint.id,
      complaint_number: complaint.complaint_number,
      phone_number: body.phone_number,
      timestamp: Date.now(),
      source: "app_voice",
    });

    res.status(201).json({
      success: true,
      mode: "voice",
      session_id: sessionId,
      data: complaint,
    });
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

module.exports = {
  createChatInteraction,
  createVoiceInteraction,
};
