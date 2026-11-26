import {
  supabase,
  state,
  showToast,
  JWT_STORAGE_KEY,
  ACTIVE_GAME_KEY,
  JWT_SIGNING_SECRET
} from './supabase.js';

function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return decodeURIComponent(escape(atob(str)));
}

export async function createLongLivedJWT(payloadObj, daysValid = 365) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payloadObj,
    iat: nowSec,
    exp: nowSec + daysValid * 24 * 60 * 60
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(JWT_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuf = await crypto.subtle.sign('HMAC', key, enc.encode(dataToSign));
  const sigBytes = String.fromCharCode(...new Uint8Array(signatureBuf));
  const encodedSig = base64UrlEncode(sigBytes);
  return `${dataToSign}.${encodedSig}`;
}

export async function verifyLongLivedJWT(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  const dataToVerify = `${encodedHeader}.${encodedPayload}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(JWT_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigRaw = base64UrlDecode(encodedSig);
  const sigBytes = new Uint8Array(sigRaw.length);
  for (let i = 0; i < sigRaw.length; i++) sigBytes[i] = sigRaw.charCodeAt(i);

  const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(dataToVerify));
  if (!isValid) return null;

  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSec) return null;
  return payload;
}

async function hashFingerprint(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function computeDeviceHash() {
  const deviceMemory = navigator.deviceMemory || "NA";
  const width = screen.width;
  const height = screen.height;
  const pixelRatio = window.devicePixelRatio || 1;
  let glVendor = "unknown";
  let glRenderer = "unknown";

  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (gl) {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        glVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        glRenderer = gl.getParameter(debugInfo.UNMASKED_RENDER_WEBGL);
      }
    }
  } catch (e) {}

  const languages = navigator.languages ? navigator.languages.join(",") : "NA";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "NA";
  const platform = navigator.platform || "NA";
  const raw = `MEM${deviceMemory}_RES${width}x${height}_PIX${pixelRatio}_GPU${glVendor}_${glRenderer}_LANG${languages}_TZ${timezone}_PLAT${platform}`;
  const hash = await hashFingerprint(raw);

  const inputField = document.getElementById("umobileInput");
  if (inputField) inputField.value = hash;
  state.deviceHash = hash;
  return hash;
}

export function syncAccountUI(onValidateWalletButtons) {
  const loggedIn = Boolean(state.account.mobile);
  document.getElementById('headerControls').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;
  document.getElementById('headerRoleBadge').textContent = state.account.role.toUpperCase();
  document.getElementById('coinBalanceDisplay').textContent = Number(state.account.coins).toLocaleString();
  document.getElementById('lobbyUsernameText').textContent = state.account.username;
  document.getElementById('walletMobileText').textContent = state.account.mobile;
  document.getElementById('walletRoleText').textContent = state.account.role.toUpperCase();
  document.getElementById('walletModalCoins').textContent = Number(state.account.coins).toLocaleString();
  if (typeof onValidateWalletButtons === 'function') onValidateWalletButtons();
}

export async function refreshAccountBalance(onValidateWalletButtons) {
  if (!state.account.mobile) return;
  const { data } = await supabase
    .from('mobile_accounts')
    .select('*')
    .eq('mobile', state.account.mobile)
    .single();
  if (data) {
    state.account.id = data.id;
    state.account.username = data.username;
    state.account.role = data.role;
    state.account.coins = Number(data.coins || 0);
    state.account.depositedByBroker = data.deposited_by_broker || null;
    syncAccountUI(onValidateWalletButtons);
  }
}

export function initPlayerAuthBindings(callbacks) {
  const {
    onLoginSuccess,
    onForfeit,
    onLogoutCleanup,
    onValidateWalletButtons
  } = callbacks;

  document.getElementById('tabLoginBtn').addEventListener('click', () => {
    state.authMode = 'login';
    document.getElementById('regNameField').classList.add('hidden');
    document.getElementById('button1').textContent = 'Continue to Lobby';
    document.getElementById('tabLoginBtn').className = 'py-2 rounded-lg text-xs font-extrabold bg-amber-500 text-slate-950 cursor-pointer';
    document.getElementById('tabRegisterBtn').className = 'py-2 rounded-lg text-xs font-extrabold text-slate-400 hover:text-white cursor-pointer';
  });

  document.getElementById('tabRegisterBtn').addEventListener('click', () => {
    state.authMode = 'register';
    document.getElementById('regNameField').classList.remove('hidden');
    document.getElementById('button1').textContent = 'Create Account';
    document.getElementById('tabRegisterBtn').className = 'py-2 rounded-lg text-xs font-extrabold bg-emerald-500 text-slate-950 cursor-pointer';
    document.getElementById('tabLoginBtn').className = 'py-2 rounded-lg text-xs font-extrabold text-slate-400 hover:text-white cursor-pointer';
  });

  document.getElementById('myForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const form = e.target;
    const button = document.getElementById('button1');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    button.disabled = true;

    try {
      if (!state.deviceHash) await computeDeviceHash();
      const mobile = document.getElementById('mobileNumberInput').value.trim();
      const username = document.getElementById('regUsernameInput').value.trim();

      // Pre-check existing account device binding before/after RPC so mismatched devices always fail cleanly
      const { data: existingAcc } = await supabase
        .from('mobile_accounts')
        .select('id, mobile, username, device_hash, role, coins, deposited_by_broker')
        .eq('mobile', mobile)
        .maybeSingle();

      if (state.authMode === 'login') {
        if (!existingAcc) {
          throw new Error('Account number not registered. Please create an account first.');
        }
        if (existingAcc.device_hash && existingAcc.device_hash !== state.deviceHash) {
          throw new Error('Device mismatch! This account is bound to another device.');
        }
      } else if (state.authMode === 'register' && existingAcc) {
        throw new Error('This 11-digit number is already registered. Please use Fast Login.');
      }

      const { data, error } = await supabase.rpc('mobile_auth_action', {
        p_mode: state.authMode,
        p_mobile: mobile,
        p_device_hash: state.deviceHash,
        p_username: username,
        p_role: 'user'
      });

      if (error) throw error;
      if (!data || data.mobile !== mobile) {
        throw new Error('Account number verification failed.');
      }
      if (data.device_hash && data.device_hash !== state.deviceHash) {
        throw new Error('Device mismatch! This account is bound to another device.');
      }

      state.account.id = data.id;
      state.account.mobile = data.mobile;
      state.account.username = data.username;
      state.account.role = data.role || 'user';
      state.account.coins = Number(data.coins || 0);
      state.account.depositedByBroker = data.deposited_by_broker || null;

      const jwtToken = await createLongLivedJWT({
        sub: state.account.id,
        mobile: state.account.mobile,
        username: state.account.username,
        role: state.account.role,
        deviceHash: state.deviceHash
      }, 365);
      localStorage.setItem(JWT_STORAGE_KEY, jwtToken);

      syncAccountUI(onValidateWalletButtons);
      await onLoginSuccess();
      showToast(`Welcome, ${state.account.username}!`, 'success');
    } catch (err) {
      showToast(err.message || 'Sign in failed', 'danger');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (onForfeit) await onForfeit();
    } catch (err) {
      showToast(`Forfeit sync failed: ${err.message || 'connection unavailable'}`, 'danger');
    } finally {
      localStorage.removeItem(JWT_STORAGE_KEY);
      localStorage.removeItem(ACTIVE_GAME_KEY);
      state.account.mobile = '';
      state.account.id = null;
      state.autoMatchLocked = false;
      onLogoutCleanup();
      button.disabled = false;
    }
  });
}
