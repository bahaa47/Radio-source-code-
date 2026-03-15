import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials missing in VITE_ env vars. Realtime and direct uploads may not work.');
}

const finalUrl = supabaseUrl || (typeof process !== 'undefined' ? process.env.SUPABASE_URL : '') || '';
const finalKey = supabaseAnonKey || (typeof process !== 'undefined' ? process.env.SUPABASE_ANON_KEY : '') || '';

export const supabase = createClient(finalUrl, finalKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  global: {
    headers: { 'x-application-name': 'radio-dream-voice' },
  },
});
