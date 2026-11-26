import { supabase, state, FEE_CONFIG_CACHE_KEY } from './supabase.js';
import { syncAccountUI } from './player.js';
import { showWalletPopup, validateWalletActionButtons } from './coin.js';

let feeConfigChannel = null;

export function applyPlatformConfigToUI(onRefreshPotPreview) {
  const gameFeePct = Number(state.platformConfig.gameFeePct ?? 20);
  const brokerFeePct = Number(state.platformConfig.brokerFeePct ?? 10);
  const minTxLimit = Number(state.platformConfig.minTxLimit ?? 500);

  document.getElementById('adminGameFeeInput').value = gameFeePct;
  document.getElementById('adminBrokerFeeInput').value = brokerFeePct;
  document.getElementById('adminMinLimitInput').value = minTxLimit;
  document.getElementById('feeSummaryText').textContent = `${gameFeePct}% Fee`;

  document.querySelectorAll('.minLimitDisplayText').forEach(el => {
    el.textContent = minTxLimit.toLocaleString();
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
      if (typeof parsed.minTxLimit === 'number') state.platformConfig.minTxLimit = parsed.minTxLimit;
    }
  } catch (e) {}
  applyPlatformConfigToUI(onRefreshPotPreview);
}

export async function fetchRemotePlatformConfig(onRefreshPotPreview) {
  try {
    const { data, error } = await supabase
      .from('platform_fee_config')
      .select('game_fee_pct, broker_fee_pct, min_tx_limit')
      .eq('id', 1)
      .maybeSingle();
    if (!error && data) {
      state.platformConfig.gameFeePct = Number(data.game_fee_pct ?? 20);
      state.platformConfig.brokerFeePct = Number(data.broker_fee_pct ?? 10);
      state.platformConfig.minTxLimit = Number(data.min_tx_limit ?? 500);
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
          state.platformConfig.minTxLimit = Number(row.min_tx_limit ?? 500);
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
    const minTxLimit = Number(document.getElementById('adminMinLimitInput').value);

    if (isNaN(gameFeePct) || isNaN(brokerFeePct) || gameFeePct < 0 || brokerFeePct < 0 || brokerFeePct > gameFeePct || gameFeePct > 90) {
      return showWalletPopup('Invalid fee % (0 <= Broker % <= Game % <= 90).', false);
    }
    if (isNaN(minTxLimit) || minTxLimit < 1) {
      return showWalletPopup('Minimum deposit/withdrawal limit must be at least 1 coin.', false);
    }

    btn.disabled = true;
    try {
      const { error: rpcErr } = await supabase.rpc('admin_set_platform_settings', {
        p_admin_mobile: state.account.mobile,
        p_device_hash: state.deviceHash,
        p_game_fee_pct: gameFeePct,
        p_broker_fee_pct: brokerFeePct,
        p_min_tx_limit: minTxLimit
      });

      if (rpcErr) {
        const { error: upsertErr } = await supabase
          .from('platform_fee_config')
          .upsert({
            id: 1,
            game_fee_pct: gameFeePct,
            broker_fee_pct: brokerFeePct,
            min_tx_limit: minTxLimit,
            updated_at: new Date().toISOString()
          });
        if (upsertErr) throw upsertErr;
      }

      state.platformConfig.gameFeePct = gameFeePct;
      state.platformConfig.brokerFeePct = brokerFeePct;
      state.platformConfig.minTxLimit = minTxLimit;
      localStorage.setItem(FEE_CONFIG_CACHE_KEY, JSON.stringify(state.platformConfig));
      applyPlatformConfigToUI(onRefreshPotPreview);

      await fetchRemotePlatformConfig(onRefreshPotPreview);
      showWalletPopup(`Saved: ${gameFeePct}% Game Fee, ${brokerFeePct}% Broker Fee, Min Limit ${minTxLimit} coins!`, true);
    } catch (err) {
      showWalletPopup(err.message || 'Failed to save platform settings', false);
    } finally {
      btn.disabled = false;
    }
  });
}
