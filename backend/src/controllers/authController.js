const crypto = require("crypto");

const { supabaseAdmin } = require("../client/supabase");

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const withSchemaHint = (error) => {
  const message = String(error?.message || "").toLowerCase();
  const isMissingOtpTable = message.includes("otp_challenges") && message.includes("does not exist");
  const isMissingSessionTable =
    message.includes("auth_sessions") && message.includes("does not exist");

  if (isMissingOtpTable || isMissingSessionTable) {
    return createHttpError(
      500,
      "Auth tables not found. Run migration: backend/migrations/2026-02-12_auth_otp_sessions.sql"
    );
  }

  return error;
};

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const OTP_EXPIRY_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 15;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const normalizePhone = (phone) => {
  if (!isNonEmptyString(phone)) {
    return "";
  }

  return phone.trim();
};

const hashToken = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const generateNumericOtp = () =>
  String(Math.floor(100000 + Math.random() * 900000));

const generateToken = () => crypto.randomBytes(32).toString("hex");

const getFutureIso = (seconds) =>
  new Date(Date.now() + seconds * 1000).toISOString();

const getOtpExpiryIso = () => getFutureIso(OTP_EXPIRY_MINUTES * 60);

const upsertCitizenFromPhone = async (phoneNumber, profile = {}) => {
  if (!phoneNumber) {
    return null;
  }

  const citizenPayload = {
    phone_number: phoneNumber,
    is_phone_verified: true,
    last_login_at: new Date().toISOString(),
  };

  const name = profile.name;
  if (isNonEmptyString(name)) {
    citizenPayload.name = name.trim();
  }

  const preferredLanguage = profile.preferred_language;
  if (isNonEmptyString(preferredLanguage)) {
    citizenPayload.preferred_language = preferredLanguage.trim();
  }

  const { data, error } = await supabaseAdmin
    .from("citizens")
    .upsert(citizenPayload, { onConflict: "phone_number" })
    .select("*")
    .single();

  if (error) {
    const message = String(error.message || "").toLowerCase();
    if (message.includes("column")) {
      const fallbackPayload = {
        phone_number: phoneNumber,
      };

      if (isNonEmptyString(citizenPayload.name)) {
        fallbackPayload.name = citizenPayload.name;
      }

      if (isNonEmptyString(citizenPayload.preferred_language)) {
        fallbackPayload.preferred_language = citizenPayload.preferred_language;
      }

      const { data: fallbackData, error: fallbackError } = await supabaseAdmin
        .from("citizens")
        .upsert(fallbackPayload, { onConflict: "phone_number" })
        .select("*")
        .single();

      if (fallbackError) {
        throw fallbackError;
      }

      return fallbackData;
    }

    throw error;
  }

  return data;
};

const createSessionForCitizen = async (citizenId) => {
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);

  const { data, error } = await supabaseAdmin
    .from("auth_sessions")
    .insert({
      citizen_id: citizenId,
      access_token_hash: accessTokenHash,
      refresh_token_hash: refreshTokenHash,
      access_expires_at: getFutureIso(ACCESS_TOKEN_TTL_SECONDS),
      refresh_expires_at: getFutureIso(REFRESH_TOKEN_TTL_SECONDS),
      is_revoked: false,
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  return {
    session_id: data.id,
    access_token: accessToken,
    refresh_token: refreshToken,
    access_expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
  };
};

const requestOtp = async (req, res, next) => {
  try {
    const phoneNumber = normalizePhone(req.body?.phone_number);

    if (!phoneNumber) {
      throw createHttpError(400, "phone_number is required");
    }

    const otp = generateNumericOtp();
    const otpHash = hashToken(otp);

    const { error: invalidateError } = await supabaseAdmin
      .from("otp_challenges")
      .update({ status: "expired" })
      .eq("phone_number", phoneNumber)
      .eq("status", "pending");

    if (invalidateError) {
      throw invalidateError;
    }

    const { error } = await supabaseAdmin.from("otp_challenges").insert({
      phone_number: phoneNumber,
      otp_hash: otpHash,
      expires_at: getOtpExpiryIso(),
      attempt_count: 0,
      status: "pending",
    });

    if (error) {
      throw createHttpError(400, error.message || "Failed to request OTP");
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(`[OTP] ${phoneNumber} -> ${otp}`);
    }

    res.status(200).json({
      success: true,
      message: "OTP sent successfully",
      ...(process.env.NODE_ENV !== "production" ? { dev_otp: otp } : {}),
    });
  } catch (error) {
    error = withSchemaHint(error);
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

const verifyOtp = async (req, res, next) => {
  try {
    const phoneNumber = normalizePhone(req.body?.phone_number);
    const otp = normalizePhone(req.body?.otp);

    if (!phoneNumber || !otp) {
      throw createHttpError(400, "phone_number and otp are required");
    }

    const { data: challenge, error: challengeError } = await supabaseAdmin
      .from("otp_challenges")
      .select("id, otp_hash, expires_at, attempt_count, status")
      .eq("phone_number", phoneNumber)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (challengeError) {
      throw challengeError;
    }

    if (!challenge) {
      throw createHttpError(401, "No pending OTP found");
    }

    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      await supabaseAdmin
        .from("otp_challenges")
        .update({ status: "expired" })
        .eq("id", challenge.id);
      throw createHttpError(401, "OTP expired");
    }

    if (challenge.attempt_count >= OTP_MAX_ATTEMPTS) {
      await supabaseAdmin
        .from("otp_challenges")
        .update({ status: "blocked" })
        .eq("id", challenge.id);
      throw createHttpError(429, "Maximum OTP attempts exceeded");
    }

    const providedHash = hashToken(otp);
    const isValid = providedHash === challenge.otp_hash;

    if (!isValid) {
      await supabaseAdmin
        .from("otp_challenges")
        .update({ attempt_count: challenge.attempt_count + 1 })
        .eq("id", challenge.id);
      throw createHttpError(401, "Invalid OTP");
    }

    await supabaseAdmin
      .from("otp_challenges")
      .update({ status: "verified", verified_at: new Date().toISOString() })
      .eq("id", challenge.id);

    const citizen = await upsertCitizenFromPhone(phoneNumber, {
      name: req.body?.name,
      preferred_language: req.body?.preferred_language,
    });

    const session = await createSessionForCitizen(citizen.id);

    res.status(200).json({
      success: true,
      message: "OTP verified",
      data: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        access_expires_in: session.access_expires_in,
        refresh_expires_in: session.refresh_expires_in,
        token_type: "bearer",
        user: {
          id: citizen.id,
          phone_number: citizen.phone_number,
        },
        citizen,
      },
    });
  } catch (error) {
    error = withSchemaHint(error);
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

const refreshSession = async (req, res, next) => {
  try {
    const refreshToken = normalizePhone(req.body?.refresh_token);

    if (!refreshToken) {
      throw createHttpError(400, "refresh_token is required");
    }

    const refreshTokenHash = hashToken(refreshToken);

    const { data: session, error: sessionError } = await supabaseAdmin
      .from("auth_sessions")
      .select(
        "id, citizen_id, refresh_token_hash, refresh_expires_at, is_revoked, citizens(id, phone_number, name, preferred_language, role)"
      )
      .eq("refresh_token_hash", refreshTokenHash)
      .maybeSingle();

    if (sessionError) {
      throw sessionError;
    }

    if (!session || session.is_revoked) {
      throw createHttpError(401, "Invalid refresh token");
    }

    if (new Date(session.refresh_expires_at).getTime() < Date.now()) {
      await supabaseAdmin
        .from("auth_sessions")
        .update({ is_revoked: true, revoked_at: new Date().toISOString() })
        .eq("id", session.id);
      throw createHttpError(401, "Refresh token expired");
    }

    const accessToken = generateToken();
    const nextRefreshToken = generateToken();

    const { error: rotateError } = await supabaseAdmin
      .from("auth_sessions")
      .update({
        access_token_hash: hashToken(accessToken),
        refresh_token_hash: hashToken(nextRefreshToken),
        access_expires_at: getFutureIso(ACCESS_TOKEN_TTL_SECONDS),
        refresh_expires_at: getFutureIso(REFRESH_TOKEN_TTL_SECONDS),
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);

    if (rotateError) {
      throw rotateError;
    }

    await supabaseAdmin
      .from("citizens")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", session.citizen_id);

    res.status(200).json({
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: nextRefreshToken,
        access_expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
        token_type: "bearer",
      },
    });
  } catch (error) {
    error = withSchemaHint(error);
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

const getCurrentUser = async (req, res, next) => {
  try {
    if (!req.auth?.citizen) {
      throw createHttpError(401, "Unauthorized");
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: req.auth.citizen.id,
          phone_number: req.auth.citizen.phone_number,
        },
        citizen: req.auth.citizen,
        role: req.auth.role || "citizen",
      },
    });
  } catch (error) {
    error = withSchemaHint(error);
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const sessionId = req.auth?.session_id;

    if (sessionId) {
      const { error } = await supabaseAdmin
        .from("auth_sessions")
        .update({
          is_revoked: true,
          revoked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId);

      if (error) {
        throw error;
      }
    }

    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    error = withSchemaHint(error);
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

module.exports = {
  requestOtp,
  verifyOtp,
  refreshSession,
  getCurrentUser,
  logout,
};
