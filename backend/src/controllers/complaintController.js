const { supabaseAdmin } = require("../client/supabase");

const VALID_CHANNELS = new Set(["sms", "whatsapp", "voice"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_MEDIA_TYPES = new Set(["audio", "image"]);

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const normalizeMedia = (media) => {
  if (!Array.isArray(media)) {
    return [];
  }

  return media.filter((item) => item && typeof item === "object");
};

const createComplaint = async (req, res, next) => {
  try {
    const {
      phone_number: rawPhone,
      name,
      preferred_language,
      channel: rawChannel,
      raw_text,
      translated_text,
      category,
      priority: rawPriority,
      location_text,
      latitude,
      longitude,
      ward_id,
      department_id,
      source_message_id,
      source_call_id,
      media,
    } = req.body || {};

    const phoneNumber = isNonEmptyString(rawPhone)
     ? rawPhone.trim()
     : "";

    const channel = isNonEmptyString(rawChannel)
      ? rawChannel.trim().toLowerCase()
      : "";
      
    const priority = isNonEmptyString(rawPriority)
      ? rawPriority.trim().toLowerCase()
      : "medium";

    if (!phoneNumber) {
      throw createHttpError(400, "phone_number is required");
    }

    if (!VALID_CHANNELS.has(channel)) {
      throw createHttpError(400, "channel must be sms, whatsapp, or voice");
    }

    if (!VALID_PRIORITIES.has(priority)) {
      throw createHttpError(
        400,
        "priority must be low, medium, high, or critical"
      );
    }

    const normalizedMedia = normalizeMedia(media);
    const hasText = isNonEmptyString(raw_text);
    const hasMedia = normalizedMedia.length > 0;

    if (!hasText && !hasMedia) {
      throw createHttpError(
        400,
        "Either raw_text or at least one media item is required"
      );
    }

    if (latitude != null && (Number(latitude) < -90 || Number(latitude) > 90)) {
      throw createHttpError(400, "latitude must be between -90 and 90");
    }

    if (
      longitude != null &&
      (Number(longitude) < -180 || Number(longitude) > 180)
    ) {
      throw createHttpError(400, "longitude must be between -180 and 180");
    }

    for (const item of normalizedMedia) {
      if (!VALID_MEDIA_TYPES.has(item.media_type)) {
        throw createHttpError(400, "media_type must be audio or image");
      }

      if (!isNonEmptyString(item.storage_path)) {
        throw createHttpError(400, "media.storage_path is required");
      }
    }

    const citizenPayload = {
      phone_number: phoneNumber,
    };

    if (isNonEmptyString(name)) {
      citizenPayload.name = name.trim();
    }

    if (isNonEmptyString(preferred_language)) {
      citizenPayload.preferred_language = preferred_language.trim();
    }

    const { data: citizen, error: citizenError } = await supabaseAdmin
      .from("citizens")
      .upsert(citizenPayload, { onConflict: "phone_number" })
      .select("id")
      .single();

    if (citizenError) {
      throw citizenError;
    }

    const complaintPayload = {
      citizen_id: citizen.id,
      channel,
      raw_text: hasText ? raw_text.trim() : null,
      translated_text: isNonEmptyString(translated_text)
        ? translated_text.trim()
        : null,
      category: isNonEmptyString(category) ? category.trim().toLowerCase() : null,
      priority,
      location_text: isNonEmptyString(location_text) ? location_text.trim() : null,
      latitude: latitude != null ? Number(latitude) : null,
      longitude: longitude != null ? Number(longitude) : null,
      ward_id: ward_id || null,
      department_id: department_id || null,
      source_message_id: isNonEmptyString(source_message_id)
        ? source_message_id.trim()
        : null,
      source_call_id: isNonEmptyString(source_call_id)
        ? source_call_id.trim()
        : null,
    };

    const { data: complaint, error: complaintError } = await supabaseAdmin
      .from("complaints")
      .insert(complaintPayload)
      .select("id, complaint_number, status, channel, citizen_id, created_at")
      .single();

    if (complaintError) {
      if (complaintError.code === "23505") {
        throw createHttpError(409, "Duplicate source message/call id");
      }

      throw complaintError;
    }

    const eventPayload = {
      complaint_id: complaint.id,
      event_type: "complaint_created",
      old_value: null,
      new_value: {
        status: complaint.status,
      },
      actor_type: "system",
      note: "Complaint created via API",
    };

    const { error: eventError } = await supabaseAdmin
      .from("complaint_events")
      .insert(eventPayload);

    if (eventError) {
      throw eventError;
    }

    if (normalizedMedia.length > 0) {
      const mediaRows = normalizedMedia.map((item) => ({
        complaint_id: complaint.id,
        media_type: item.media_type,
        storage_bucket: isNonEmptyString(item.storage_bucket)
          ? item.storage_bucket.trim()
          : "complaint-evidence",
        storage_path: item.storage_path.trim(),
        mime_type: isNonEmptyString(item.mime_type) ? item.mime_type.trim() : null,
        size_bytes:
          item.size_bytes != null && !Number.isNaN(Number(item.size_bytes))
            ? Number(item.size_bytes)
            : null,
        duration_sec:
          item.duration_sec != null && !Number.isNaN(Number(item.duration_sec))
            ? Number(item.duration_sec)
            : null,
        checksum_sha256: isNonEmptyString(item.checksum_sha256)
          ? item.checksum_sha256.trim()
          : null,
      }));

      const { error: mediaError } = await supabaseAdmin
        .from("complaint_media")
        .insert(mediaRows);

      if (mediaError) {
        throw mediaError;
      }
    }

    res.status(201).json({
      success: true,
      data: complaint,
    });
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }

    next(error);
  }
};

const readComplaint = async (req, res, next) => {
  try {
    const complaintNo = Number(req.params.complaint_no);

    if (!Number.isInteger(complaintNo) || complaintNo <= 0) {
      throw createHttpError(400, "complaint_no must be a positive integer");
    }

    const { data: complaint, error: complaintError } = await supabaseAdmin
      .from("complaints")
      .select(
        "id, complaint_number, status, channel, priority, category, raw_text, translated_text, location_text, latitude, longitude, citizen_id, ward_id, department_id, created_at, updated_at, resolved_at"
      )
      .eq("complaint_number", complaintNo)
      .single();

    if (complaintError) {
      if (complaintError.code === "PGRST116") {
        throw createHttpError(404, "Complaint not found");
      }

      throw complaintError;
    }

    const [{ data: media, error: mediaError }, { data: events, error: eventsError }] =
      await Promise.all([
        supabaseAdmin
          .from("complaint_media")
          .select(
            "id, media_type, storage_bucket, storage_path, mime_type, size_bytes, duration_sec, checksum_sha256, uploaded_at"
          )
          .eq("complaint_id", complaint.id)
          .order("uploaded_at", { ascending: false }),
        supabaseAdmin
          .from("complaint_events")
          .select(
            "id, event_type, old_value, new_value, actor_id, actor_type, note, created_at"
          )
          .eq("complaint_id", complaint.id)
          .order("created_at", { ascending: false }),
      ]);

    if (mediaError) {
      throw mediaError;
    }

    if (eventsError) {
      throw eventsError;
    }

    res.status(200).json({
      success: true,
      data: {
        ...complaint,
        media: media || [],
        timeline: events || [],
      },
    });
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }

    next(error);
  }
};

const deleteComplaint = async (req, res, next) => {
  try {
    const complaintId = isNonEmptyString(req.params.complaint_id)
      ? req.params.complaint_id.trim()
      : "";

    if (!complaintId) {
      throw createHttpError(400, "complaint_id is required");
    }

    const { data: complaint, error: complaintError } = await supabaseAdmin
      .from("complaints")
      .select("id, complaint_number")
      .eq("id", complaintId)
      .single();

    if (complaintError) {
      if (complaintError.code === "PGRST116") {
        throw createHttpError(404, "Complaint not found");
      }

      throw complaintError;
    }

    const { error: deleteError } = await supabaseAdmin
      .from("complaints")
      .delete()
      .eq("id", complaintId);

    if (deleteError) {
      throw deleteError;
    }

    res.status(200).json({
      success: true,
      message: "Complaint deleted successfully",
      data: {
        id: complaint.id,
        complaint_number: complaint.complaint_number,
      },
    });
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }

    next(error);
  }
};

module.exports = {
  createComplaint,
  readComplaint,
  deleteComplaint,
};
