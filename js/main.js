import { supabase, state, JWT_STORAGE_KEY } from './supabase.js';
import {
  computeDeviceHash,
  createLongLivedJWT,
  verifyLongLivedJWT,
  syncAccountUI,
  initPlayerAuthBindings
} from './player.js';
import {
  validateWalletActionButtons,
  initCoinTransferBindings
} from './coin.js';
import {
  loadCachedPlatformConfig,
  fetchRemotePlatformConfig,
  subscribePlatformConfigRealtime,
  initAdminBindings
} from './admin.js';
import { initBrokerBindings } from './broker.js';
import { initBoardBindings } from './board.js';
import { renderDiceFaces, initDiceBindings } from './dice.js';
import {
  updateAutoMatchButtonState,
  refreshPotPreview,
  switchView,
  stopTurnTimer,
  stopMatchmakingCountdown,
  cleanupOnlineChannel,
  cleanupLobbyMatchmakerChannel,
  startLobbyMatchmakerPresence,
  checkSavedMatchForRejoin,
  executeTokenMove,
  triggerDiceRoll,
  forfeitCurrentPlayer,
  initGameBindings
} from './game.js';

// Wire all module UI event listeners
initPlayerAuthBindings({
  onForfeit: forfeitCurrentPlayer,
  onLoginSuccess: async () => {
    await fetchRemotePlatformConfig(refreshPotPreview);
    subscribePlatformConfigRealtime(refreshPotPreview);
    startLobbyMatchmakerPresence();
    checkSavedMatchForRejoin();
    await switchView('lobby');
  },
  onLogoutCleanup: () => {
    updateAutoMatchButtonState();
    stopTurnTimer();
    stopMatchmakingCountdown();
    state.isAnimatingMove = false;
    cleanupOnlineChannel();
    cleanupLobbyMatchmakerChannel();
    state.game = null;
    switchView('auth');
  },
  onValidateWalletButtons: validateWalletActionButtons
});

initCoinTransferBindings();
initAdminBindings(refreshPotPreview);
initBrokerBindings(refreshPotPreview);
initBoardBindings(executeTokenMove);
initDiceBindings(triggerDiceRoll);
initGameBindings();

// Bootstrap session & platform settings
window.addEventListener('DOMContentLoaded', async () => {
  renderDiceFaces(6);
  loadCachedPlatformConfig(refreshPotPreview);
  refreshPotPreview();
  await computeDeviceHash();
  await fetchRemotePlatformConfig(refreshPotPreview);
  subscribePlatformConfigRealtime(refreshPotPreview);

  const storedJwt = localStorage.getItem(JWT_STORAGE_KEY);
  if (storedJwt) {
    const jwtPayload = await verifyLongLivedJWT(storedJwt);
    if (jwtPayload && jwtPayload.mobile && (!jwtPayload.deviceHash || jwtPayload.deviceHash === state.deviceHash)) {
      const { data } = await supabase.rpc('mobile_auth_action', {
        p_mode: 'login',
        p_mobile: jwtPayload.mobile,
        p_device_hash: state.deviceHash
      });
      if (data && data.mobile === jwtPayload.mobile && (!data.device_hash || data.device_hash === state.deviceHash)) {
        state.account.id = data.id;
        state.account.mobile = data.mobile;
        state.account.username = data.username;
        state.account.role = data.role;
        state.account.coins = Number(data.coins || 0);
        state.account.depositedByBroker = data.deposited_by_broker || null;

        const renewedJwt = await createLongLivedJWT({
          sub: state.account.id,
          mobile: state.account.mobile,
          username: state.account.username,
          role: state.account.role,
          deviceHash: state.deviceHash
        }, 365);
        localStorage.setItem(JWT_STORAGE_KEY, renewedJwt);

        await fetchRemotePlatformConfig(refreshPotPreview);
        syncAccountUI(validateWalletActionButtons);
        startLobbyMatchmakerPresence();
        checkSavedMatchForRejoin();
        await switchView('lobby');
        return;
      }
    }
  }
  await switchView('auth');
});

// Global single-click lock guard to prevent rapid double/multi-clicks on any game button
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button, [role="button"]');
  if (!btn) return;
  if (btn.disabled || btn.dataset.clickLocked === '1') {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  btn.dataset.clickLocked = '1';
  setTimeout(() => {
    delete btn.dataset.clickLocked;
  }, 450);
}, true);
