import { supabase, state, showToast } from './supabase.js';
import { sfx } from './sound.js';
import { refreshAccountBalance, syncAccountUI } from './player.js';

let txCooldownUntil = 0;
let txCooldownTimer = null;
let hasPendingDWRequest = false;

export function isTxLocked() {
  return Date.now() < txCooldownUntil;
}

export async function refreshPendingDWStatus() {
  if (!state.account.mobile) {
    hasPendingDWRequest = false;
    return false;
  }
  try {
    const { data, error } = await supabase
      .from('mobile_coin_tx')
      .select('id')
      .eq('sender_mobile', state.account.mobile)
      .eq('status', 'pending')
      .in('tx_type', ['deposit_req', 'withdraw_req'])
      .limit(1);

    if (!error) {
      hasPendingDWRequest = Array.isArray(data) && data.length > 0;
    }
  } catch (e) {}
  return hasPendingDWRequest;
}

export function showWalletPopup(message, isSuccess = true) {
  const box = document.getElementById('walletActionPopup');
  const icon = document.getElementById('walletActionPopupIcon');
  const title = document.getElementById('walletActionPopupTitle');
  const msgEl = document.getElementById('walletActionPopupMsg');
  if (!box) return;

  box.classList.remove('hidden', 'bg-emerald-950/85', 'border-emerald-400/50', 'bg-rose-950/85', 'border-rose-400/50');
  title.classList.remove('text-emerald-300', 'text-rose-300');

  if (isSuccess) {
    box.classList.add('bg-emerald-950/85', 'border-emerald-400/50');
    title.classList.add('text-emerald-300');
    icon.textContent = '✅';
    title.textContent = 'Success';
  } else {
    box.classList.add('bg-rose-950/85', 'border-rose-400/50');
    title.classList.add('text-rose-300');
    icon.textContent = '❌';
    title.textContent = 'Error';
  }
  msgEl.textContent = message;
  showToast(message, isSuccess ? 'success' : 'danger');
}

export function validateWalletActionButtons() {
  const minLimit = Number(state.platformConfig.minTxLimit || 500);
  const bal = Number(state.account.coins || 0);
  const locked = isTxLocked();
  const secsLeft = locked ? Math.ceil((txCooldownUntil - Date.now()) / 1000) : 0;

  const transferBtn = document.getElementById('btnExecuteTransfer');
  if (transferBtn) {
    const recvMobile = document.getElementById('recipientMobileInput').value.trim();
    const amt = Number(document.getElementById('transferAmountInput').value);
    const validMobile = /^\d{11}$/.test(recvMobile);
    const validAmt = !isNaN(amt) && amt >= minLimit;
    const balanceSufficient = state.account.role === 'admin' || (bal >= minLimit && bal >= amt);

    transferBtn.disabled = locked || !validMobile || !validAmt || !balanceSufficient;
    if (locked) {
      transferBtn.textContent = `Locked (${secsLeft}s)...`;
    } else if (state.account.role !== 'admin' && bal < minLimit) {
      transferBtn.textContent = `Balance Below Limit (${bal} < ${minLimit})`;
    } else if (amt > 0 && amt < minLimit) {
      transferBtn.textContent = `Minimum Limit is ${minLimit} Coins`;
    } else if (state.account.role !== 'admin' && validAmt && bal < amt) {
      transferBtn.textContent = `Insufficient Balance (${bal})`;
    } else {
      transferBtn.textContent = 'Send Coins';
    }
  }

  const reqBtn = document.getElementById('btnSubmitBrokerReq');
  const pendingNotice = document.getElementById('pendingRequestNotice');
  if (pendingNotice) {
    pendingNotice.classList.toggle('hidden', !hasPendingDWRequest);
  }
  if (reqBtn) {
    const brokerMobile = document.getElementById('brokerMobileInput').value.trim();
    const actionType = document.getElementById('reqActionType').value;
    const amt = Number(document.getElementById('reqCoinAmount').value);
    const validMobile = /^\d{11}$/.test(brokerMobile);
    const validAmt = !isNaN(amt) && amt >= minLimit;
    const balanceSufficient = actionType === 'deposit_req'
      ? true
      : (bal >= minLimit && bal >= amt);

    reqBtn.disabled = locked || hasPendingDWRequest || !validMobile || !validAmt || !balanceSufficient;
    if (locked) {
      reqBtn.textContent = `Locked (${secsLeft}s)...`;
    } else if (hasPendingDWRequest) {
      reqBtn.textContent = 'Pending Request Exists';
    } else if (actionType === 'withdraw_req' && bal < minLimit) {
      reqBtn.textContent = `Balance Below Limit (${bal} < ${minLimit})`;
    } else if (amt > 0 && amt < minLimit) {
      reqBtn.textContent = `Minimum Limit is ${minLimit} Coins`;
    } else if (actionType === 'withdraw_req' && validAmt && bal < amt) {
      reqBtn.textContent = `Exceeds Balance (${bal})`;
    } else {
      reqBtn.textContent = 'Submit Request';
    }
  }

  document.querySelectorAll('#brokerPendingList button[data-tx]').forEach(btn => {
    btn.disabled = locked;
    btn.classList.toggle('opacity-45', locked);
  });
}

export function startTxCooldown(seconds = 5) {
  txCooldownUntil = Date.now() + seconds * 1000;
  validateWalletActionButtons();
  if (txCooldownTimer) clearInterval(txCooldownTimer);
  txCooldownTimer = setInterval(() => {
    if (!isTxLocked()) {
      clearInterval(txCooldownTimer);
      txCooldownTimer = null;
    }
    validateWalletActionButtons();
  }, 250);
}

export async function runMatchCoinRpc(action, amount, note, targetMobile = null) {
  const { data: newBal, error } = await supabase.rpc('mobile_match_coins', {
    p_mobile: targetMobile || state.account.mobile,
    p_device_hash: state.deviceHash,
    p_action: action,
    p_amount: amount,
    p_note: note
  });
  if (error) {
    showToast(error.message, 'danger');
    return null;
  }
  if (!targetMobile || targetMobile === state.account.mobile) {
    state.account.coins = Number(newBal);
    syncAccountUI(validateWalletActionButtons);
  }
  return Number(newBal);
}

export async function creditWalletCoinsReliable(targetMobile, amount, txType, note, senderMobile = 'SYSTEM') {
  if (!targetMobile || amount <= 0) return;

  const { error: rpcErr } = await supabase.rpc('credit_account_coins', {
    p_target_mobile: targetMobile,
    p_amount: amount,
    p_tx_type: txType,
    p_note: note
  });

  if (!rpcErr) return;

  const { data: row } = await supabase
    .from('mobile_accounts')
    .select('coins')
    .eq('mobile', targetMobile)
    .single();

  if (row) {
    await supabase
      .from('mobile_accounts')
      .update({ coins: Number(row.coins || 0) + amount })
      .eq('mobile', targetMobile);

    await supabase
      .from('mobile_coin_tx')
      .insert({
        sender_mobile: senderMobile,
        receiver_mobile: targetMobile,
        amount,
        tx_type: txType,
        status: 'completed',
        note
      });
  }
}

export async function creditBrokerDepositWithdrawFee(brokerMobile, baseAmount, kindLabel, userMobile) {
  const feePct = Number(state.platformConfig.brokerTxFeePct ?? 5);
  const feeCoins = Math.floor((Number(baseAmount || 0) * feePct) / 100);
  if (!brokerMobile || feeCoins <= 0) return 0;

  await creditWalletCoinsReliable(
    brokerMobile,
    feeCoins,
    'broker_fee',
    `Broker ${kindLabel} fee (${feePct}% of ${baseAmount}) from ${userMobile}`,
    userMobile || 'SYSTEM'
  );
  return feeCoins;
}

let stakeDeductionPromise = null;
let lastDeductedMatchKey = null;

export function resetMatchStakeLock() {
  state.stakeDeductedForCurrentMatch = false;
  lastDeductedMatchKey = null;
  stakeDeductionPromise = null;
}

export async function deductPlayerWalletStakeOnce(targetMobile, stakeAmount, roomCode, matchSessionId = '') {
  const stake = Number(stakeAmount || 0);
  if (!targetMobile || targetMobile === 'LOCAL' || stake <= 0) return { ok: true, coins: 0 };

  const note = `Match Start Stake (${roomCode || 'ONLINE'}${matchSessionId ? ` #${matchSessionId}` : ''})`;

  if (matchSessionId) {
    const { data: existingTx } = await supabase
      .from('mobile_coin_tx')
      .select('id')
      .eq('sender_mobile', targetMobile)
      .eq('tx_type', 'match_deduct')
      .eq('note', note)
      .limit(1);

    if (existingTx && existingTx.length > 0) {
      const { data: accRow } = await supabase
        .from('mobile_accounts')
        .select('coins')
        .eq('mobile', targetMobile)
        .single();
      return { ok: true, coins: Number(accRow?.coins ?? 0), alreadyCut: true };
    }
  }

  const { data: beforeRow, error: fetchErr } = await supabase
    .from('mobile_accounts')
    .select('coins, device_hash')
    .eq('mobile', targetMobile)
    .single();

  if (fetchErr || !beforeRow) {
    return { ok: false, error: `Unable to read wallet for ${targetMobile}.` };
  }

  const startCoins = Number(beforeRow.coins || 0);
  if (startCoins < stake) {
    return { ok: false, error: `Insufficient coins (${startCoins} < ${stake}) for ${targetMobile}.` };
  }

  const devHash = targetMobile === state.account.mobile ? state.deviceHash : (beforeRow.device_hash || state.deviceHash);
  const { data: rpcBal, error: rpcErr } = await supabase.rpc('mobile_match_coins', {
    p_mobile: targetMobile,
    p_device_hash: devHash,
    p_action: 'deduct',
    p_amount: stake,
    p_note: note
  });

  let finalCoins = null;
  if (!rpcErr && rpcBal !== null && rpcBal !== undefined) {
    finalCoins = Number(rpcBal);
  } else {
    const expectedAfter = startCoins - stake;
    const { data: updRow, error: updErr } = await supabase
      .from('mobile_accounts')
      .update({ coins: expectedAfter })
      .eq('mobile', targetMobile)
      .eq('coins', startCoins)
      .select('coins')
      .single();

    if (updErr || !updRow) {
      return { ok: false, error: rpcErr?.message || `Wallet deduction failed for ${targetMobile}.` };
    }
    finalCoins = Number(updRow.coins);

    await supabase.from('mobile_coin_tx').insert({
      sender_mobile: targetMobile,
      receiver_mobile: 'SYSTEM',
      amount: stake,
      tx_type: 'match_deduct',
      status: 'completed',
      note
    });
  }

  const { data: afterRow } = await supabase
    .from('mobile_accounts')
    .select('coins')
    .eq('mobile', targetMobile)
    .single();

  const verifiedCoins = afterRow ? Number(afterRow.coins) : finalCoins;
  if (verifiedCoins > startCoins - stake) {
    const reconciled = Math.max(0, startCoins - stake);
    await supabase
      .from('mobile_accounts')
      .update({ coins: reconciled })
      .eq('mobile', targetMobile);
    return { ok: true, coins: reconciled };
  }

  return { ok: true, coins: verifiedCoins };
}

export async function deductStakeOnMatchStart(stakeAmount, roomCode, matchSessionId = '') {
  const stake = Number(stakeAmount || 0);
  if (stake <= 0) return true;

  const matchKey = `${roomCode || 'ONLINE'}:${matchSessionId || 'DEFAULT'}:${stake}`;
  if (state.stakeDeductedForCurrentMatch && lastDeductedMatchKey === matchKey) {
    return true;
  }
  if (stakeDeductionPromise) return stakeDeductionPromise;

  stakeDeductionPromise = (async () => {
    try {
      const res = await deductPlayerWalletStakeOnce(state.account.mobile, stake, roomCode, matchSessionId);
      if (!res.ok) {
        showToast(res.error || 'Stake deduction failed.', 'danger');
        return false;
      }

      state.account.coins = Number(res.coins);
      state.stakeDeductedForCurrentMatch = true;
      lastDeductedMatchKey = matchKey;
      syncAccountUI(validateWalletActionButtons);
      if (!res.alreadyCut) {
        sfx.coin();
        showToast(`Match started! ${stake} coins cut (Wallet: ${state.account.coins}).`, 'gold');
      }
      return true;
    } finally {
      stakeDeductionPromise = null;
    }
  })();

  return stakeDeductionPromise;
}

export async function loadWalletTransactions() {
  await refreshPendingDWStatus();
  validateWalletActionButtons();

  const { data } = await supabase
    .from('mobile_coin_tx')
    .select('*')
    .or(`sender_mobile.eq.${state.account.mobile},receiver_mobile.eq.${state.account.mobile}`)
    .order('created_at', { ascending: false })
    .limit(30);

  let rows = data || [];
  if (state.account.role === 'user') {
    const depositWithdrawTypes = new Set(['deposit_req', 'withdraw_req', 'deposit_approved', 'withdraw_approved']);
    rows = rows.filter(tx => depositWithdrawTypes.has(tx.tx_type)).slice(0, 6);
  } else {
    rows = rows.slice(0, 15);
  }

  const tbody = document.getElementById('walletTxBody');
  tbody.innerHTML = '';
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-3 text-center text-slate-500">No transactions to display.</td></tr>`;
    return;
  }

  rows.forEach(tx => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-white/5';
    tr.innerHTML = `
      <td class="py-1.5 font-bold text-slate-200">${tx.tx_type}</td>
      <td class="py-1.5 font-mono text-slate-300">${tx.sender_mobile} → ${tx.receiver_mobile}</td>
      <td class="py-1.5 text-amber-300 font-bold">${tx.amount}</td>
      <td class="py-1.5 text-emerald-400">${tx.status}</td>
    `;
    tbody.appendChild(tr);
  });
}

export function initCoinTransferBindings() {
  document.getElementById('closeWalletPopupBtn').addEventListener('click', () => {
    document.getElementById('walletActionPopup').classList.add('hidden');
  });

  ['recipientMobileInput', 'transferAmountInput', 'brokerMobileInput', 'reqActionType', 'reqCoinAmount'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', validateWalletActionButtons);
      el.addEventListener('change', validateWalletActionButtons);
    }
  });

  document.getElementById('btnExecuteTransfer').addEventListener('click', async () => {
    if (isTxLocked()) return;
    const receiverMobile = document.getElementById('recipientMobileInput').value.trim();
    const amount = Number(document.getElementById('transferAmountInput').value);
    const note = document.getElementById('transferNoteInput').value.trim();
    const minLimit = Number(state.platformConfig.minTxLimit || 500);

    if (!/^\d{11}$/.test(receiverMobile) || isNaN(amount) || amount < minLimit) {
      return showWalletPopup(`Enter a valid 11-digit number and at least ${minLimit} coins.`, false);
    }

    startTxCooldown(5);

    try {
      const { data: newBal, error } = await supabase.rpc('mobile_transfer_by_phone', {
        p_sender_mobile: state.account.mobile,
        p_device_hash: state.deviceHash,
        p_receiver_mobile: receiverMobile,
        p_amount: amount,
        p_note: note
      });

      if (error) throw error;

      if (state.account.role === 'broker') {
        await supabase
          .from('mobile_accounts')
          .update({ deposited_by_broker: state.account.mobile })
          .eq('mobile', receiverMobile);
      }

      if (state.account.role === 'broker' && newBal !== null) {
        state.account.coins = Number(newBal);
      }
      await refreshAccountBalance(validateWalletActionButtons);
      syncAccountUI(validateWalletActionButtons);
      sfx.coin();
      showWalletPopup(`Sent ${amount.toLocaleString()} coins to ${receiverMobile}!`, true);
      document.getElementById('transferAmountInput').value = '';
      validateWalletActionButtons();
      await loadWalletTransactions();
    } catch (err) {
      showWalletPopup(err.message || 'Send coin transfer failed.', false);
    }
  });
}