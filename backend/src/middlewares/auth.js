const crypto = require("crypto");

const { supabaseAdmin } = require("../client/supabase");

const createHttpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const withSchemaHint = (error) => {
  const message = String(error?.message || "").toLowerCase();
  const isMissingSessionTable =
    message.includes("auth_sessions") && message.includes("does not exist");

  if (isMissingSessionTable) {
    return createHttpError(
      500,
      "Auth tables not found. Run migration: backend/migrations/2026-02-12_auth_otp_sessions.sql"
    );
  }

  return error;
};

const extractBearerToken = (authorizationHeader = "") => {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token.trim();
};

const hashToken = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const getAuthFromToken = async (token) => {
  const tokenHash = hashToken(token);

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("auth_sessions")
    .select(
      "id, citizen_id, access_expires_at, refresh_expires_at, is_revoked, citizens(*)"
    )
    .eq("access_token_hash", tokenHash)
    .maybeSingle();

  if (sessionError) {
    throw sessionError;
  }

  if (!session || session.is_revoked) {
    throw createHttpError(401, "Invalid or expired token");
  }

  if (new Date(session.access_expires_at).getTime() < Date.now()) {
    throw createHttpError(401, "Access token expired");
  }

  if (!session.citizens) {
    throw createHttpError(401, "Session citizen not found");
  }

  return {
    session,
    citizen: session.citizens,
    role: session.citizens.role || "citizen",
  };
};

const requireAuth = async (req, _res, next) => {
  try {
    const token = extractBearerToken(req.headers.authorization);

    if (!token) {
      throw createHttpError(401, "Missing or invalid Authorization header");
    }
    const authData = await getAuthFromToken(token);

    req.auth = {
      token,
      session_id: authData.session.id,
      citizen: authData.citizen,
      role: authData.role,
      phone_number: authData.citizen.phone_number,
    };

    next();
  } catch (error) {
    error = withSchemaHint(error);
    if (!error.statusCode) {
      error.statusCode = 401;
    }
    next(error);
  }
};

const requireRole = (...roles) => (req, _res, next) => {
  const role = req.auth?.role || "citizen";

  if (!roles.includes(role)) {
    return next(createHttpError(403, "Forbidden: insufficient role"));
  }

  return next();
};

module.exports = {
  getAuthFromToken,
  requireAuth,
  requireRole,
};
