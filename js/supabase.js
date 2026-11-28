import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = "https://cggoedzlnxkbtchvtjld.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_C_pxA1KKxWWrfEiz6j2yUQ_HWQgcErJ";
// Optional: set to `${SUPABASE_URL}/functions/v1/match-state` to offload state sync via stateless HTTP Edge Function
export const MATCH_STATE_EDGE_FUNCTION_URL = "";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

export const JWT_STORAGE_KEY = 'ludo_royale_jwt_v2';
export const ACTIVE_GAME_KEY = 'ludo_royale_active_match_v2';
export const FEE_CONFIG_CACHE_KEY = 'ludo_royale_fee_cfg_v2';
export const JWT_SIGNING_SECRET = 'LUDO_ROYALE_CLIENT_JWT_2026_SECURE';

// Shared mutable application state across modules
export const state = {
  authMode: 'login',
  deviceHash: '',
  account: {
    id: null,
    mobile: '',
    username: 'Player',
    role: 'user',
    coins: 0,
    depositedByBroker: null
  },
  platformConfig: {
    gameFeePct: 20,
    brokerFeePct: 10,
    minTxLimit: 500
  },
  selectedStake: 100,
  selectedPlayerCount: 2,
  game: null,
  onlineRoomCode: null,
  realtimeChannel: null,
  lobbyMatchmakerChannel: null,
  liveOpenRoomsMap: new Map(),
  waitingRoomState: null,
  mySeatIndex: 0,
  stakeDeductedForCurrentMatch: false,
  payoutProcessedForMatch: false,
  isAnimatingMove: false,
  isSyncingMatch: false,
  animFrameId: null,
  autoMatchLocked: false
};

export function showToast(msg, tone = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  const colors = {
    info: 'bg-slate-900/95 border-white/15 text-white',
    gold: 'bg-amber-950/95 border-amber-400/60 text-amber-200',
    danger: 'bg-rose-950/95 border-rose-400/60 text-rose-200',
    success: 'bg-emerald-950/95 border-emerald-400/60 text-emerald-200'
  };
  el.className = `toast-anim px-4 py-2.5 rounded-2xl border text-xs font-extrabold shadow-xl text-center ${colors[tone] || colors.info}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3250);
}