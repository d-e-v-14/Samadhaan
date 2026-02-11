const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl) {
  throw new Error("Missing SUPABASE_URL environment variable");
}

if (!supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable");
}

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
};

const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
  clientOptions
);

const testConnection = async () => {
  try {
    const { error } = await supabaseAdmin
      .from("complaints")
      .select("id")
      .limit(1);

    if (error) {
      throw error;
    }

    return true;
  } catch (_error) {
    return false;
  }
};

module.exports = {
  supabaseAdmin,
  testConnection,
};
