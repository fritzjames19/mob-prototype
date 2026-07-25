import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing Supabase env vars. Copy .env.example to .env and fill in your project\'s ' +
    'URL, anon key, and service role key from Supabase > Project Settings > API.'
  );
}

// Used ONLY to verify a user's login token on incoming requests. Cannot bypass Row Level Security.
export const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Used for all actual game data reads/writes. The service role key bypasses Row Level Security,
// which is exactly why it must never be sent to the browser — this client living only on the
// server is the entire basis of "the server is authoritative, not the client."
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
