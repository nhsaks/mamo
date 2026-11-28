import { supabase, state, FEE_CONFIG_CACHE_KEY } from './supabase.js';
import { syncAccountUI } from './player.js';
import { showWalletPopup, validateWalletActionButtons } from './coin.js';

let feeConfigChannel = null;
const DEFAULT_POT_STAKES = [10, 100, 500, 1000, 2000, 5000];

export function parsePotStakesInput(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[\s,]+/);
  const nums = parts
    .map(n => Number(String(n).trim()))
    .filter(n => Number.isFinite(n) && n > 0)
    .map(n => Math.floor(n));
  const unique = Array.from(new Set(nums)).sort((a, b) => a - b);
  return unique.length > 0 ? unique : [...DEFAULT_POT_STAKES];
}

export function applyPlatformConfigToUI(onRefreshPotPreview) {
  const gameFeePct = Number(state.platformConfig.gameFeePct ?? 20);
  const brokerFeePct = Number(state.platformConfig.brokerFeePct ?? 10);
  const brokerTxFeePct = Number(state.platformConfig.brokerTxFeePct ?? 5);
  const minTxLimit = Number(state.platformConfig.minTxLimit ?? 500);
  const maxMissedTurns = Number(state.platformConfig.maxMissedTurns ?? 5);
  const potStakes = parsePotStakesInput(state.platformConfig.potStakes);

  state.platformConfig.potStakes = potStakes;
  state.platformConfig.maxMissedTurns = maxMissedTurns;
  state.platformConfig.brokerTxFeePct = brokerTxFeePct;

  if (!potStakes.includes(Number(state.selectedStake))) {
    state.selectedStake = potStakes[0];
  }

  document.getElementById('adminGameFeeInput').value = gameFeePct;
  document.getElementById('adminBrokerFeeInput').value = brokerFeePct;
  document.getElementById('adminBrokerTxFeeInput').value = brokerTxFeePct;
  document.getElementById('adminMinLimitInput').value = minTxLimit;
  document.getElementById('adminPotStakesInput').value = potStakes.join(', ');
  document.getElementById('adminMaxMissedTurnsInput').value = maxMissedTurns;
  document.getElementById('feeSummaryText').textContent = `${gameFeePct}% Fee`;

  const maxMissHud = document.getElementById('maxMissHudText');
  if (maxMissHud) maxMissHud.textContent = String(maxMissedTurns);

  document.querySelectorAll('.minLimitDisplayText').forEach(el => {
    el.textContent = minTxLimit.toLocaleString();
  });
  document.querySelectorAll('.brokerTxFeeDisplayText').forEach(el => {
    el.textContent = `${brokerTxFeePct}%`;
  });

  const transferInput = document.getElementById('transferAmountInput');
  const reqInput = document.getElementById('reqCoinAmount');
  if (transferInput) {
    transferInput.min = minTxLimit;
    transferInput.placeholder = `Min ${minTxLimit} Coins`;
  }
  if (reqInput) {
    reqInput.min = minTxLimit;
    reqInput.placeholder = `Min ${minTxLimit} Coins`;
  }

  if (typeof onRefreshPotPreview === 'function') onRefreshPotPreview();
  validateWalletActionButtons();
}

export function loadCachedPlatformConfig(onRefreshPotPreview) {
  try {
    const raw = localStorage.getItem(FEE_CONFIG_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed.gameFeePct === 'number') state.platformConfig.gameFeePct = parsed.gameFeePct;
      if (typeof parsed.brokerFeePct === 'number') state.platformConfig.brokerFeePct = parsed.brokerFeePct;
      if (typeof parsed.brokerTxFeePct === 'number') state.platformConfig.brokerTxFeePct = parsed.brokerTxFeePct;
      if (typeof parsed.minTxLimit === 'number') state.platformConfig.minTxLimit = parsed.minTxLimit;
      if (typeof parsed.maxMissedTurns === 'number') state.platformConfig.maxMissedTurns = parsed.maxMissedTurns;
      if (Array.isArray(parsed.potStakes) && parsed.potStakes.length > 0) {
        state.platformConfig.potStakes = parsePotStakesInput(parsed.potStakes);
      }
    }
  } catch (e) {}
  applyPlatformConfigToUI(onRefreshPotPreview);
}

export async function fetchRemotePlatformConfig(onRefreshPotPreview) {
  try {
    const { data, error } = await supabase
      .from('platform_fee_config')
      .select('game_fee_pct, broker_fee_pct, broker_tx_fee_pct, min_tx_limit, max_missed_turns, pot_stakes')
      .eq('id', 1)
      .maybeSingle();
    if (!error && data) {
      state.platformConfig.gameFeePct = Number(data.game_fee_pct ?? 20);
      state.platformConfig.brokerFeePct = Number(data.broker_fee_pct ?? 10);
      state.platformConfig.brokerTxFeePct = Number(data.broker_tx_fee_pct ?? 5);
      state.platformConfig.minTxLimit = Number(data.min_tx_limit ?? 500);
      state.platformConfig.maxMissedTurns = Number(data.max_missed_turns ?? 5);
      state.platformConfig.potStakes = parsePotStakesInput(data.pot_stakes);
      localStorage.setItem(FEE_CONFIG_CACHE_KEY, JSON.stringify(state.platformConfig));
      applyPlatformConfigToUI(onRefreshPotPreview);
    }
  } catch (e) {}
}

export function subscribePlatformConfigRealtime(onRefreshPotPreview) {
  if (feeConfigChannel) return;
  feeConfigChannel = supabase
    .channel('ludo-platform-fee-config')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'platform_fee_config', filter: 'id=eq.1' },
      (payload) => {
        const row = payload.new;
        if (row) {
          state.platformConfig.gameFeePct = Number(row.game_fee_pct ?? 20);
          state.platformConfig.brokerFeePct = Number(row.broker_fee_pct ?? 10);
          state.platformConfig.brokerTxFeePct = Number(row.broker_tx_fee_pct ?? 5);
          state.platformConfig.minTxLimit = Number(row.min_tx_limit ?? 500);
          state.platformConfig.maxMissedTurns = Number(row.max_missed_turns ?? 5);
          state.platformConfig.potStakes = parsePotStakesInput(row.pot_stakes);
          localStorage.setItem(FEE_CONFIG_CACHE_KEY, JSON.stringify(state.platformConfig));
          applyPlatformConfigToUI(onRefreshPotPreview);
        }
      }
    )
    .subscribe();
}

export function initAdminBindings(onRefreshPotPreview) {
  document.getElementById('btnUpdateUserRole').addEventListener('click', async () => {
    const btn = document.getElementById('btnUpdateUserRole');
    const targetMobile = document.getElementById('roleTargetMobileInput').value.trim();
    const newRole = document.getElementById('roleTargetSelect').value;

    if (!/^\d{11}$/.test(targetMobile)) {
      return showWalletPopup('Enter a valid 11-digit account number.', false);
    }

    btn.disabled = true;
    try {
      const { error: rpcErr } = await supabase.rpc('admin_set_user_role', {
        p_admin_mobile: state.account.mobile,
        p_device_hash: state.deviceHash,
        p_target_mobile: targetMobile,
        p_new_role: newRole
      });

      if (rpcErr) {
        const { data: updatedRows, error: updErr } = await supabase
          .from('mobile_accounts')
          .update({ role: newRole })
          .eq('mobile', targetMobile)
          .select('mobile, role');

        if (updErr || !updatedRows || updatedRows.length === 0) {
          throw new Error(rpcErr.message || updErr?.message || 'Account not found or update blocked');
        }
      }

      if (targetMobile === state.account.mobile) {
        state.account.role = newRole;
        syncAccountUI(validateWalletActionButtons);
      }
      showWalletPopup(`Role for ${targetMobile} changed to ${newRole.toUpperCase()}!`, true);
      document.getElementById('roleTargetMobileInput').value = '';
    } catch (err) {
      showWalletPopup(`Role update failed: ${err.message}`, false);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnSaveFeeSettings').addEventListener('click', async () => {
    const btn = document.getElementById('btnSaveFeeSettings');
    const gameFeePct = Number(document.getElementById('adminGameFeeInput').value);
    const brokerFeePct = Number(document.getElementById('adminBrokerFeeInput').value);
    const brokerTxFeePct = Number(document.getElementById('adminBrokerTxFeeInput').value);
    const minTxLimit = Number(document.getElementById('adminMinLimitInput').value);
    const maxMissedTurns = Number(document.getElementById('adminMaxMissedTurnsInput').value);
    const potStakes = parsePotStakesInput(document.getElementById('adminPotStakesInput').value);

    if (
      isNaN(gameFeePct) || isNaN(brokerFeePct) || isNaN(brokerTxFeePct) ||
      gameFeePct < 0 || brokerFeePct < 0 || brokerTxFeePct < 0 ||
      brokerFeePct > gameFeePct || gameFeePct > 90 || brokerTxFeePct > 90
    ) {
      return showWalletPopup('Invalid fee % (0 <= Broker Cut <= Game Fee <= 90, Dep/With Fee <= 90).', false);
    }
    if (isNaN(minTxLimit) || minTxLimit < 1) {
      return showWalletPopup('Minimum deposit/withdrawal limit must be at least 1 coin.', false);
    }
    if (isNaN(maxMissedTurns) || maxMissedTurns < 1 || maxMissedTurns > 20) {
      return showWalletPopup('Missed turn limit must be between 1 and 20.', false);
    }

    btn.disabled = true;
    try {
      const { error: rpcErr } = await supabase.rpc('admin_set_platform_settings_v2', {
        p_game_fee_pct: gameFeePct,
        p_broker_fee_pct: brokerFeePct,
        p_broker_tx_fee_pct: brokerTxFeePct,
        p_min_tx_limit: minTxLimit,
        p_max_missed_turns: maxMissedTurns,
        p_pot_stakes: potStakes
      });

      if (rpcErr) {
        const { error: upsertErr } = await supabase
          .from('platform_fee_config')
          .upsert({
            id: 1,
            game_fee_pct: gameFeePct,
            broker_fee_pct: brokerFeePct,
            broker_tx_fee_pct: brokerTxFeePct,
            min_tx_limit: minTxLimit,
            max_missed_turns: maxMissedTurns,
            pot_stakes: potStakes,
            updated_at: new Date().toISOString()
          });
        if (upsertErr) throw upsertErr;
      }

      state.platformConfig.gameFeePct = gameFeePct;
      state.platformConfig.brokerFeePct = brokerFeePct;
      state.platformConfig.brokerTxFeePct = brokerTxFeePct;
      state.platformConfig.minTxLimit = minTxLimit;
      state.platformConfig.maxMissedTurns = maxMissedTurns;
      state.platformConfig.potStakes = potStakes;
      localStorage.setItem(FEE_CONFIG_CACHE_KEY, JSON.stringify(state.platformConfig));
      applyPlatformConfigToUI(onRefreshPotPreview);

      await fetchRemotePlatformConfig(onRefreshPotPreview);
      showWalletPopup(`Saved: Game ${gameFeePct}%, Broker Dep/With ${brokerTxFeePct}%, Stakes [${potStakes.join(', ')}], Max Miss ${maxMissedTurns}!`, true);
    } catch (err) {
      showWalletPopup(err.message || 'Failed to save platform settings', false);
    } finally {
      btn.disabled = false;
    }
  });
}