import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL || "";
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY || "";

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.error(
    "Missing REACT_APP_SUPABASE_URL or REACT_APP_SUPABASE_ANON_KEY. " +
    "Set them in your .env file (see .env.example) and restart the dev server."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);