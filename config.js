// FlashQuant cloud settings. Both values below are PUBLIC by design (the publishable key is safe in browser code
// because row-level security limits every user to their own rows). Never put a "secret" or "service_role" key here.
// Leave SUPABASE_URL empty to run the app in local-only mode with no sign-in.

export const SUPABASE_URL = 'https://zubjqanlcpuckqmobibv.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_TrjbD9oljje5dJ4gT93wKQ_7qnRuLhU';

// Pinned exact version, loaded only when sync is enabled.
export const SUPABASE_SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
