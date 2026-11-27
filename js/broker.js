import { supabase, state } from './supabase.js';
import { sfx } from './sound.js';
import { refreshAccountBalance, syncAccountUI } from './player.js';
import { fetchRemotePlatformConfig } from './admin.js';
import {
  isTxLocked,
  startTxCooldown,
  refreshPendingDWStatus,
  computeBrokerTxFee,
  creditBrokerDepositWithdrawFee,
  showWalletPopup,
  validateWalletActionButtons,
  loadWalletTransactions
} from './coin.js';

export async function loadBrokerPendingRequests() {
  const { data, error } = await supabase
    .from('mobile_coin_tx')
    .select('*')
    .eq('receiver_mobile', state.account.mobile)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  const list = document.getElementById('brokerPendingList');
  list.innerHTML = '';
  if (error) {
    list.innerHTML = `<p class="text-rose-400">Error loading requests: ${error.message}</p>`;
    return;
  }
  if (!data || data.length === 0) {
    list.innerHTML = '<p class="text-slate-400">No pending requests.</p>';
    return;
  }

  data.forEach(tx => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between bg-slate-950 border border-white/10 rounded-xl p-2.5 gap-2';
    div.innerHTML = `
      <div>
        <strong class="text-white">${tx.tx_type === 'deposit_req' ? 'DEPOSIT' : 'WITHDRAW'}</strong> •
        <span class="font-mono text-sky-300">${tx.sender_mobile}</span> •
        <span class="text-amber-300 font-bold">${tx.amount} Coins</span>
        <div class="text-[11px] text-slate-400">Ref: ${tx.note || '-'}</div>
      </div>
      <div class="flex gap-1.5">
        <button data-tx="${tx.id}" data-type="${tx.tx_type}" data-user="${tx.sender_mobile}" data-amt="${tx.amount}" data-dec="approved" type="button" class="px-2.5 py-1 rounded-lg bg-emerald-500 disabled:opacity-45 text-slate-950 font-extrabold cursor-pointer">Approve</button>
        <button data-tx="${tx.id}" data-type="${tx.tx_type}" data-user="${tx.sender_mobile}" data-amt="${tx.amount}" data-dec="rejected" type="button" class="px-2.5 py-1 rounded-lg bg-rose-500 disabled:opacity-45 text-white font-extrabold cursor-pointer">Reject</button>
      </div>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (isTxLocked()) return;
      const txId = btn.dataset.tx;
      const decision = btn.dataset.dec;
      const txType = btn.dataset.type;
      const userMobile = btn.dataset.user;
      const amt = Number(btn.dataset.amt);
      const { feeCoins, netCoins } = computeBrokerTxFee(amt);

      const beforeCoins = Number(state.account.coins || 0);

      if (txType === 'deposit_req' && decision === 'approved' && beforeCoins < netCoins) {
        return showWalletPopup(`Broker balance (${beforeCoins}) is less than ${netCoins} coins deposit!`, false);
      }

      startTxCooldown(5);

      try {
        const { data: rpcResult, error: rpcErr } = await supabase.rpc('mobile_handle_request', {
          p_broker_mobile: state.account.mobile,
          p_device_hash: state.deviceHash,
          p_tx_id: txId,
          p_decision: decision
        });

        if (rpcErr) {
          if (txType === 'withdraw_req' && decision === 'approved') {
            const { data: freshBroker } = await supabase
              .from('mobile_accounts')
              .select('coins')
              .eq('mobile', state.account.mobile)
              .single();
            const nextBrokerBal = Number(freshBroker?.coins ?? beforeCoins) + netCoins;
            const { error: bUpdErr } = await supabase
              .from('mobile_accounts')
              .update({ coins: nextBrokerBal })
              .eq('mobile', state.account.mobile);
            if (bUpdErr) throw bUpdErr;
          } else if (txType === 'withdraw_req' && decision === 'rejected') {
            const { data: uRow } = await supabase.from('mobile_accounts').select('coins').eq('mobile', userMobile).single();
            if (uRow) {
              await supabase.from('mobile_accounts').update({ coins: Number(uRow.coins || 0) + amt }).eq('mobile', userMobile);
            }
          } else if (txType === 'deposit_req' && decision === 'approved') {
            const { data: freshBroker } = await supabase
              .from('mobile_accounts')
              .select('coins')
              .eq('mobile', state.account.mobile)
              .single();
            const nextBrokerBal = Number(freshBroker?.coins ?? beforeCoins) - netCoins;
            if (nextBrokerBal < 0) throw new Error('Insufficient broker balance');
            await supabase.from('mobile_accounts').update({ coins: nextBrokerBal }).eq('mobile', state.account.mobile);
            const { data: uRow } = await supabase.from('mobile_accounts').select('coins').eq('mobile', userMobile).single();
            if (uRow) {
              await supabase.from('mobile_accounts').update({
                coins: Number(uRow.coins || 0) + netCoins,
                deposited_by_broker: state.account.mobile
              }).eq('mobile', userMobile);
            }
          }

          const { error: txUpdErr } = await supabase
            .from('mobile_coin_tx')
            .update({
              status: decision,
              amount: decision === 'approved' ? netCoins : amt,
              tx_type: decision === 'approved'
                ? (txType === 'withdraw_req' ? 'withdraw_approved' : 'deposit_approved')
                : txType
            })
            .eq('id', txId);
          if (txUpdErr) throw txUpdErr;
        } else if (txType === 'deposit_req' && decision === 'approved' && feeCoins > 0) {
          // If RPC credited full `amt` to user, trim `feeCoins` so user receives `netCoins`
          const { data: uRow } = await supabase.from('mobile_accounts').select('coins').eq('mobile', userMobile).single();
          if (uRow) {
            await supabase
              .from('mobile_accounts')
              .update({ coins: Math.max(0, Number(uRow.coins || 0) - feeCoins) })
              .eq('mobile', userMobile);
          }
          await supabase
            .from('mobile_coin_tx')
            .update({ amount: netCoins })
            .eq('id', txId);
        }

        let addedBrokerFee = 0;
        if (decision === 'approved') {
          addedBrokerFee = await creditBrokerDepositWithdrawFee(
            state.account.mobile,
            amt,
            txType === 'withdraw_req' ? 'withdraw' : 'deposit',
            userMobile
          );
        }

        await refreshAccountBalance(validateWalletActionButtons);
        if (txType === 'withdraw_req' && decision === 'approved' && Number(state.account.coins) <= beforeCoins) {
          const fallbackCoins = (typeof rpcResult === 'number' && Number(rpcResult) > beforeCoins)
            ? Number(rpcResult) + addedBrokerFee
            : beforeCoins + netCoins + addedBrokerFee;
          await supabase
            .from('mobile_accounts')
            .update({ coins: fallbackCoins })
            .eq('mobile', state.account.mobile);
          state.account.coins = fallbackCoins;
          syncAccountUI(validateWalletActionButtons);
        }

        sfx.coin();
        showWalletPopup(
          decision === 'approved'
            ? `${txType === 'withdraw_req' ? 'Withdraw' : 'Deposit'} approved! Net ${netCoins.toLocaleString()} coins (Fee: ${addedBrokerFee.toLocaleString()}).`
            : `Request ${decision}!`,
          true
        );
        await loadBrokerPendingRequests();
        await loadWalletTransactions();
      } catch (err) {
        showWalletPopup(err.message || 'Failed to process request', false);
      }
    });
  });
}

export async function openWalletModal(onRefreshPotPreview) {
  document.getElementById('walletActionPopup').classList.add('hidden');
  await refreshAccountBalance(validateWalletActionButtons);
  await fetchRemotePlatformConfig(onRefreshPotPreview);
  await refreshPendingDWStatus();
  document.getElementById('walletModal').classList.remove('hidden');

  const isAdmin = state.account.role === 'admin';
  const isUser = state.account.role === 'user';
  const isBroker = state.account.role === 'broker';

  document.getElementById('adminControlsBox').classList.toggle('hidden', !isAdmin);
  document.getElementById('adminBrokerTransferBox').classList.toggle('hidden', isUser);
  document.getElementById('userBrokerReqBox').classList.toggle('hidden', !isUser);
  document.getElementById('brokerPendingBox').classList.toggle('hidden', !isBroker);

  document.getElementById('transferBoxTitle').textContent = isAdmin
    ? 'Admin: Mint & Send Coins to Player'
    : 'Broker: Send Coins to Player';

  document.getElementById('walletTxHeading').textContent = 'Last 6 Coin Transactions';

  validateWalletActionButtons();
  if (isBroker) await loadBrokerPendingRequests();
  await loadWalletTransactions();
}

export function initBrokerBindings(onRefreshPotPreview) {
  document.getElementById('openWalletBtn').addEventListener('click', () => openWalletModal(onRefreshPotPreview));
  document.getElementById('lobbyWalletManageBtn').addEventListener('click', () => openWalletModal(onRefreshPotPreview));
  document.getElementById('refreshWalletDataBtn').addEventListener('click', () => openWalletModal(onRefreshPotPreview));
  document.getElementById('closeWalletBtn').addEventListener('click', () => {
    document.getElementById('walletModal').classList.add('hidden');
  });

  document.getElementById('btnSubmitBrokerReq').addEventListener('click', async () => {
    if (isTxLocked()) return;
    const stillPending = await refreshPendingDWStatus();
    if (stillPending) {
      validateWalletActionButtons();
      return showWalletPopup('You already have a pending deposit or withdraw request.', false);
    }

    const brokerMobile = document.getElementById('brokerMobileInput').value.trim();
    const action = document.getElementById('reqActionType').value;
    const amount = Number(document.getElementById('reqCoinAmount').value);
    const note = document.getElementById('reqPaymentNote').value.trim();
    const minLimit = Number(state.platformConfig.minTxLimit || 500);

    if (!/^\d{11}$/.test(brokerMobile)) {
      return showWalletPopup('Enter a valid 11-digit broker number.', false);
    }
    if (brokerMobile === state.account.mobile) {
      return showWalletPopup('You cannot send a request to your own number.', false);
    }
    if (isNaN(amount) || amount < minLimit) {
      return showWalletPopup(`Minimum deposit/withdrawal limit is ${minLimit} coins.`, false);
    }
    if (action === 'withdraw_req' && amount > Number(state.account.coins)) {
      return showWalletPopup(`Withdrawal (${amount}) cannot exceed your balance (${state.account.coins})!`, false);
    }

    startTxCooldown(5);

    try {
      const { data: brokerRow, error: brokerErr } = await supabase
        .from('mobile_accounts')
        .select('mobile, role, coins')
        .eq('mobile', brokerMobile)
        .single();

      if (brokerErr || !brokerRow) {
        throw new Error(`Account ${brokerMobile} not found.`);
      }
      if (!['broker', 'admin'].includes(brokerRow.role)) {
        throw new Error(`Number ${brokerMobile} is not a registered broker.`);
      }
      if (action === 'deposit_req' && Number(brokerRow.coins || 0) < amount) {
        throw new Error(`Broker wallet (${Number(brokerRow.coins || 0)}) is less than ${amount} coins deposit request.`);
      }

      const { data: rpcBal, error: rpcErr } = await supabase.rpc('mobile_request_by_phone', {
        p_user_mobile: state.account.mobile,
        p_device_hash: state.deviceHash,
        p_broker_mobile: brokerMobile,
        p_amount: amount,
        p_action: action,
        p_note: note
      });

      if (rpcErr) {
        if (action === 'withdraw_req') {
          const currentCoins = Number(state.account.coins || 0);
          if (currentCoins < amount) throw new Error('Insufficient balance for withdrawal.');
          const nextCoins = currentCoins - amount;
          const { error: updErr } = await supabase
            .from('mobile_accounts')
            .update({ coins: nextCoins })
            .eq('mobile', state.account.mobile);
          if (updErr) throw updErr;
          state.account.coins = nextCoins;
        }

        const { error: insErr } = await supabase
          .from('mobile_coin_tx')
          .insert({
            sender_mobile: state.account.mobile,
            receiver_mobile: brokerMobile,
            amount,
            tx_type: action,
            status: 'pending',
            note
          });
        if (insErr) {
          if (insErr.code === '23505') {
            throw new Error('Only one pending deposit or withdraw request is allowed at a time.');
          }
          throw insErr;
        }
      } else if (typeof rpcBal === 'number') {
        state.account.coins = Number(rpcBal);
      }

      await refreshAccountBalance(validateWalletActionButtons);
      syncAccountUI(validateWalletActionButtons);
      sfx.coin();
      showWalletPopup(
        action === 'withdraw_req'
          ? `Withdraw request of ${amount.toLocaleString()} coins sent (status: pending) & cut from your wallet!`
          : `Deposit request of ${amount.toLocaleString()} coins sent (status: pending)!`,
        true
      );
      document.getElementById('reqCoinAmount').value = '';
      await loadWalletTransactions();
    } catch (err) {
      showWalletPopup(err.message || 'Request failed.', false);
    }
  });
}