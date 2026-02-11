const { supabaseAdmin } = require("../client/supabase");

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const intakeSms = async (req, res, next) => {
  try {
    const from = isNonEmptyString(req.body?.From) ? req.body.From.trim() : "";
    const bodyText = isNonEmptyString(req.body?.Body) ? req.body.Body.trim() : "";
    const messageSid = isNonEmptyString(req.body?.MessageSid)
      ? req.body.MessageSid.trim()
      : null;
    const numMedia = Number(req.body?.NumMedia || 0);

    if (!from) {
      throw createHttpError(400, "Missing sender number");
    }

    if (!bodyText && numMedia <= 0) {
      throw createHttpError(400, "SMS body or media is required");
    }

    const citizenPayload = { phone_number: from };

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
      channel: "sms",
      raw_text: bodyText || "Media complaint received",
      source_message_id: messageSid,
      status: "received",
    };

    const { data: complaint, error: complaintError } = await supabaseAdmin
      .from("complaints")
      .insert(complaintPayload)
      .select("id, complaint_number, status")
      .single();

    if (complaintError) {
      if (complaintError.code === "23505") {
        res.status(200).type("text/xml").send("<Response></Response>");
        return;
      }

      throw complaintError;
    }

    const { error: eventError } = await supabaseAdmin
      .from("complaint_events")
      .insert({
        complaint_id: complaint.id,
        event_type: "complaint_created",
        old_value: null,
        new_value: { status: complaint.status },
        actor_type: "system",
        note: "Complaint created via Twilio SMS webhook",
      });

    if (eventError) {
      throw eventError;
    }

    const message = `Complaint #${complaint.complaint_number} received. We will keep you updated.`;

    res
      .status(200)
      .type("text/xml")
      .send(`<Response><Message>${message}</Message></Response>`);
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }

    next(error);
  }
};

module.exports = {
  intakeSms,
};
