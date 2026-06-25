const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.warn("[db] Falta SUPABASE_URL o SUPABASE_SERVICE_KEY. La persistencia no funcionará.");
}

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || "",
  { auth: { persistSession: false } }
);

module.exports = { supabase };
