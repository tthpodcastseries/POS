(() => {
  let payments, card;
  let cart = [];
  let doorQty = 1;
  let appConfig = {};
  let pendingPaymentType = null; // 'card' or 'cash'
  let buyerEmail = '';
  let buyerName = '';
  let buyerPhone = '';
  let buyerNewsletter = false;
  let cartIdCounter = 0;

  // Haptic feedback helper
  function haptic() {
    if (navigator.vibrate) navigator.vibrate(10);
  }

  // --- Toast notification (replaces alert()) ---
  let toastTimer = null;
  function showToast(message, type = 'error', duration = 3500) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast' + (type === 'success' ? ' toast-success' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.add('hidden'); }, duration);
  }

  // --- Styled confirm modal (replaces confirm()) ---
  function showConfirm(title, message, okLabel, isDanger) {
    return new Promise((resolve) => {
      document.getElementById('confirmTitle').textContent = title;
      document.getElementById('confirmMessage').textContent = message;
      const okBtn = document.getElementById('confirmOk');
      okBtn.textContent = okLabel || 'Confirm';
      okBtn.className = 'btn btn-primary' + (isDanger ? ' btn-danger' : '');
      document.getElementById('confirmModal').classList.remove('hidden');

      function cleanup(result) {
        document.getElementById('confirmModal').classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        document.getElementById('confirmCancel').removeEventListener('click', onCancel);
        document.getElementById('closeConfirm').removeEventListener('click', onCancel);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }

      okBtn.addEventListener('click', onOk);
      document.getElementById('confirmCancel').addEventListener('click', onCancel);
      document.getElementById('closeConfirm').addEventListener('click', onCancel);
    });
  }

  // --- Offline/online indicator ---
  function updateOnlineStatus() {
    const banner = document.getElementById('offlineBanner');
    if (navigator.onLine) {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
    }
  }
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);

  // Authenticated POST helper
  function authPost(url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (appConfig.apiKey) headers['X-POS-Key'] = appConfig.apiKey;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  // Authenticated GET helper (for protected read endpoints)
  function authGet(url) {
    const headers = {};
    if (appConfig.apiKey) headers['X-POS-Key'] = appConfig.apiKey;
    return fetch(url, { headers });
  }

  // --- Init ---
  async function init() {
    bindEvents();
    updateOnlineStatus();

    try {
      const res = await fetch('/api/config');
      appConfig = await res.json();

      const sdkUrl = appConfig.environment === 'production'
        ? 'https://web.squarecdn.com/v1/square.js'
        : 'https://sandbox.web.squarecdn.com/v1/square.js';

      // Try loading Square SDK up to 3 times
      let sdkLoaded = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await loadScript(sdkUrl);
          if (window.Square) { sdkLoaded = true; break; }
        } catch (e) {
          console.warn(`Square SDK load attempt ${attempt} failed`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }

      if (!sdkLoaded || !window.Square) {
        console.error('Square SDK failed to load after 3 attempts');
        return;
      }

      payments = window.Square.payments(appConfig.applicationId, appConfig.locationId);

      card = await payments.card();
      await card.attach('#card-container');

      refreshInventory();

      // Hide loading splash
      const splash = document.getElementById('loadingSplash');
      if (splash) splash.remove();
    } catch (err) {
      console.error('Square init error:', err);
      // Still hide splash on error so the UI is usable for cash
      const splash = document.getElementById('loadingSplash');
      if (splash) splash.remove();
      const container = document.getElementById('card-container');
      if (container) {
        container.innerHTML = '<p style="color:#ef4444;font-size:13px;padding:8px;cursor:pointer;" onclick="location.reload()">Card form failed to load. <u>Tap to retry.</u></p>';
      }
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      // Remove any previous failed script tag so retries actually reload
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (window.Square) { resolve(); return; }
        existing.remove();
      }
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // --- Check if cart has 50/50 tickets ---
  function cartHas5050() {
    return cart.some(item => item.product === '50/50 Tickets');
  }

  // --- Cart ---
  function addToCart(product, qty, price) {
    cart.push({ product, qty, price, id: ++cartIdCounter });
    haptic();
    renderCart();
  }

  function removeFromCart(id) {
    cart = cart.filter((item) => item.id !== id);
    renderCart();
  }

  function clearCart() {
    cart = [];
    buyerEmail = '';
    buyerName = '';
    buyerPhone = '';
    buyerNewsletter = false;
    renderCart();
  }

  function getTotal() {
    return cart.reduce((sum, item) => sum + item.price, 0);
  }

  function getDescription() {
    return cart.map((item) => item.product + ' (' + item.qty + ')').join(', ');
  }

  function renderCart() {
    const itemsEl = document.getElementById('cartItems');
    const emptyEl = document.getElementById('cartEmpty');
    const totalEl = document.getElementById('cartTotal');
    const totalAmountEl = document.getElementById('totalAmount');
    const chargeBtn = document.getElementById('chargeCardBtn');
    const cashBtn = document.getElementById('cashBtn');
    const clearBtn = document.getElementById('clearCartBtn');

    if (cart.length === 0) {
      emptyEl.style.display = 'block';
      itemsEl.innerHTML = '';
      totalEl.style.display = 'none';
      chargeBtn.disabled = true;
      cashBtn.disabled = true;
      clearBtn.disabled = true;
      return;
    }

    emptyEl.style.display = 'none';
    totalEl.style.display = 'flex';
    chargeBtn.disabled = false;
    cashBtn.disabled = false;
    clearBtn.disabled = false;

    const total = getTotal();
    totalAmountEl.textContent = '$' + total.toFixed(2);

    itemsEl.innerHTML = cart
      .map(
        (item) => `
      <div class="cart-item">
        <div class="cart-item-info">
          <span class="cart-item-name">${escapeHtml(item.product)}</span>
          <span class="cart-item-detail">${item.qty} ticket${item.qty > 1 ? 's' : ''}</span>
        </div>
        <div class="cart-item-right">
          <span class="cart-item-price">$${item.price.toFixed(2)}</span>
          <button class="cart-remove" data-id="${item.id}">&times;</button>
        </div>
      </div>
    `
      )
      .join('');

    itemsEl.querySelectorAll('.cart-remove').forEach((btn) => {
      btn.addEventListener('click', () => removeFromCart(parseInt(btn.dataset.id)));
    });
  }

  // --- Events ---
  function bindEvents() {
    // Product buttons (raffle & 50/50)
    document.querySelectorAll('.product-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const product = btn.dataset.product;
        const qty = parseInt(btn.dataset.qty);
        const price = parseInt(btn.dataset.price);
        addToCart(product, qty, price);
      });
    });

    // Door ticket qty controls
    document.getElementById('doorMinus').addEventListener('click', () => {
      if (doorQty > 1) {
        doorQty--;
        document.getElementById('doorQty').textContent = doorQty;
      }
    });

    document.getElementById('doorPlus').addEventListener('click', () => {
      // Cap at available inventory if known
      const doorRemaining = document.getElementById('inv-Door Ticket');
      const remainText = doorRemaining ? doorRemaining.textContent : '';
      const match = remainText.match(/(\d+)/);
      const maxQty = match ? parseInt(match[1]) : 50;
      if (doorQty < maxQty) {
        doorQty++;
        document.getElementById('doorQty').textContent = doorQty;
      }
    });

    document.getElementById('addDoorTicket').addEventListener('click', () => {
      addToCart('Door Tickets', doorQty, doorQty * 30);
      doorQty = 1;
      document.getElementById('doorQty').textContent = 1;
    });

    // Clear cart with confirmation
    document.getElementById('clearCartBtn').addEventListener('click', async () => {
      if (cart.length === 0) return;
      const ok = await showConfirm('Clear Cart', 'Remove all items from the cart?', 'Clear', true);
      if (ok) clearCart();
    });

    // --- Card button ---
    document.getElementById('chargeCardBtn').addEventListener('click', () => {
      const total = getTotal();
      if (total < 1) return;
      if (cartHas5050()) {
        pendingPaymentType = 'card';
        showEmailModal();
      } else {
        buyerEmail = '';
        buyerName = '';
        buyerPhone = '';
        buyerNewsletter = false;
        openCardModal();
      }
    });

    document.getElementById('closePayment').addEventListener('click', () => {
      document.getElementById('paymentModal').classList.add('hidden');
    });

    document.getElementById('payBtn').addEventListener('click', handleCardPayment);

    // --- Cash button ---
    document.getElementById('cashBtn').addEventListener('click', () => {
      const total = getTotal();
      if (total < 0.01) return;
      if (cartHas5050()) {
        pendingPaymentType = 'cash';
        showEmailModal();
      } else {
        buyerEmail = '';
        buyerName = '';
        buyerPhone = '';
        buyerNewsletter = false;
        openCashModal();
      }
    });

    document.getElementById('closeCash').addEventListener('click', () => {
      document.getElementById('cashModal').classList.add('hidden');
    });

    document.getElementById('confirmCashBtn').addEventListener('click', handleCashPayment);

    // --- Email modal ---
    document.getElementById('closeEmail').addEventListener('click', () => {
      document.getElementById('emailModal').classList.add('hidden');
      pendingPaymentType = null;
    });

    document.getElementById('confirmEmailBtn').addEventListener('click', handleEmailConfirm);

    // Clear errors on typing, submit on Enter from any field
    ['buyerName', 'buyerEmail', 'buyerPhone'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        document.getElementById('email-errors').textContent = '';
      });
      document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleEmailConfirm();
      });
    });

    // --- New sale ---
    document.getElementById('newSaleBtn').addEventListener('click', () => {
      document.getElementById('successOverlay').classList.add('hidden');
    });

    // --- History ---
    document.getElementById('historyBtn').addEventListener('click', loadHistory);
    document.getElementById('backBtn').addEventListener('click', () => {
      document.getElementById('historyScreen').classList.add('hidden');
    });

    // --- Report ---
    document.getElementById('reportBtn').addEventListener('click', loadReport);
    document.getElementById('reportBackBtn').addEventListener('click', () => {
      document.getElementById('reportScreen').classList.add('hidden');
    });

    // --- Inventory Edit ---
    document.getElementById('editInventoryBtn').addEventListener('click', openInventoryEditor);
    document.getElementById('invBackBtn').addEventListener('click', () => {
      document.getElementById('inventoryScreen').classList.add('hidden');
    });

    // +/- buttons for inventory
    document.querySelectorAll('.inv-minus').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        const val = parseInt(input.value) || 0;
        if (val > 0) input.value = val - 1;
      });
    });
    document.querySelectorAll('.inv-plus').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        const val = parseInt(input.value) || 0;
        input.value = val + 1;
      });
    });

    document.getElementById('saveInventoryBtn').addEventListener('click', saveInventoryEdits);

    // --- 50/50 Draw (admin password validated server-side) ---
    document.getElementById('drawBtn').addEventListener('click', async () => {
      const password = prompt('Enter admin password:');
      if (!password) return;
      try {
        const res = await fetch('/api/admin/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        if (!res.ok) {
          showToast('Incorrect password');
          return;
        }
      } catch (err) {
        showToast('Could not verify password');
        return;
      }
      document.getElementById('drawScreen').classList.remove('hidden');
      refreshJackpot();
      // Check if there's already a draw result
      try {
        const currentRes = await authPost('/api/draw-5050/current', {});
        const current = await currentRes.json();
        if (current && current.ticketNumber) {
          displayDrawResult(current);
        } else {
          document.getElementById('drawResult').classList.add('hidden');
          document.getElementById('redrawBtn').classList.add('hidden');
        }
      } catch (e) {
        document.getElementById('drawResult').classList.add('hidden');
        document.getElementById('redrawBtn').classList.add('hidden');
      }
    });
    document.getElementById('drawBackBtn').addEventListener('click', () => {
      document.getElementById('drawScreen').classList.add('hidden');
    });
    document.getElementById('runDrawBtn').addEventListener('click', runDraw);
    document.getElementById('redrawBtn').addEventListener('click', async () => {
      const ok = await showConfirm('Draw Again?', 'This will select a NEW random winner. The previous result will be replaced. Are you sure?', 'Draw Again', true);
      if (ok) runDraw();
    });

    // Factory Reset
    document.getElementById('resetBtn').addEventListener('click', async () => {
      const confirmed = await showConfirm(
        'Factory Reset',
        'This will delete ALL transactions, reset ALL 50/50 tickets to available, and restore inventory to defaults. This cannot be undone.',
        'Reset Everything',
        true
      );
      if (!confirmed) return;
      const resetBtn = document.getElementById('resetBtn');
      resetBtn.disabled = true;
      resetBtn.textContent = 'Resetting...';
      try {
        const res = await authPost('/api/reset', {});
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Reset failed');
        showToast('Factory reset complete', 'success');
        document.getElementById('drawResult').classList.add('hidden');
        document.getElementById('redrawBtn').classList.add('hidden');
        refreshJackpot();
        refreshInventory();
      } catch (err) {
        showToast('Reset failed: ' + err.message);
      } finally {
        resetBtn.disabled = false;
        resetBtn.textContent = 'Factory Reset';
      }
    });
  }

  // --- Buyer Info Modal ---
  function showEmailModal() {
    document.getElementById('buyerName').value = '';
    document.getElementById('buyerEmail').value = '';
    document.getElementById('buyerPhone').value = '';
    document.getElementById('buyerNewsletter').checked = false;
    document.getElementById('email-errors').textContent = '';
    document.getElementById('emailModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('buyerName').focus(), 300);
  }

  function handleEmailConfirm() {
    const name = document.getElementById('buyerName').value.trim();
    const email = document.getElementById('buyerEmail').value.trim();
    const phone = document.getElementById('buyerPhone').value.trim();
    const newsletter = document.getElementById('buyerNewsletter').checked;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    const errors = [];
    if (!name) errors.push('Name is required');
    if (!email || !emailRegex.test(email)) errors.push('Valid email is required');

    if (errors.length > 0) {
      document.getElementById('email-errors').textContent = errors.join('. ');
      return;
    }

    buyerName = name;
    buyerEmail = email;
    buyerPhone = phone;
    buyerNewsletter = newsletter;
    document.getElementById('emailModal').classList.add('hidden');

    if (pendingPaymentType === 'card') {
      openCardModal();
    } else if (pendingPaymentType === 'cash') {
      openCashModal();
    }
    pendingPaymentType = null;
  }

  function openCardModal() {
    const total = getTotal();
    document.getElementById('modalAmount').textContent = total.toFixed(2);
    document.getElementById('paymentModal').classList.remove('hidden');
  }

  function openCashModal() {
    const total = getTotal();
    document.getElementById('cashAmount').textContent = total.toFixed(2);
    document.getElementById('cashModal').classList.remove('hidden');
  }

  // --- Card Payment ---
  async function handleCardPayment() {
    const total = getTotal();
    if (total < 1) return;
    const payBtn = document.getElementById('payBtn');
    payBtn.disabled = true;
    payBtn.textContent = 'Processing...';
    document.getElementById('card-errors').textContent = '';

    if (!card) {
      document.getElementById('card-errors').textContent = 'Card form not ready. Please wait a moment and try again.';
      try {
        if (payments) {
          card = await payments.card();
          await card.attach('#card-container');
          document.getElementById('card-errors').textContent = 'Card form loaded - please try again.';
        } else {
          document.getElementById('card-errors').textContent = 'Square failed to load. Check your connection and refresh.';
        }
      } catch (initErr) {
        document.getElementById('card-errors').textContent = 'Could not load card form: ' + initErr.message;
      }
      payBtn.disabled = false;
      payBtn.textContent = 'Pay Now';
      return;
    }

    try {
      const tokenResult = await card.tokenize();

      if (tokenResult.status !== 'OK') {
        const errorMsg = tokenResult.errors
          ? tokenResult.errors.map(e => e.message).join(', ')
          : 'Card tokenization failed';
        document.getElementById('card-errors').textContent = errorMsg;
        return;
      }

      const fiftyFiftyAmount = cart.filter(i => i.product === '50/50 Tickets').reduce((s, i) => s + i.price, 0);
      const res = await authPost('/api/create-payment', {
        sourceId: tokenResult.token,
        amount: total,
        description: getDescription(),
        method: 'card',
        email: buyerEmail || undefined,
        buyerName: buyerName || undefined,
        buyerPhone: buyerPhone || undefined,
        newsletterOptIn: buyerNewsletter,
        fiftyFiftyAmount: fiftyFiftyAmount || undefined,
      });
      const data = await res.json();

      if (data.error) {
        document.getElementById('card-errors').textContent = data.error;
        return;
      }

      document.getElementById('paymentModal').classList.add('hidden');
      refreshInventory();
      showSuccess(total, 'Card', data.ticketNumbers, data.emailSent);
    } catch (err) {
      document.getElementById('card-errors').textContent = err.message;
    } finally {
      payBtn.disabled = false;
      payBtn.textContent = 'Pay Now';
    }
  }

  // --- Cash Payment ---
  async function handleCashPayment() {
    const total = getTotal();
    const btn = document.getElementById('confirmCashBtn');
    btn.disabled = true;
    btn.textContent = 'Recording...';

    try {
      const fiftyFiftyAmount = cart.filter(i => i.product === '50/50 Tickets').reduce((s, i) => s + i.price, 0);
      const res = await authPost('/api/cash-payment', {
        amount: total,
        description: getDescription(),
        email: buyerEmail || undefined,
        buyerName: buyerName || undefined,
        buyerPhone: buyerPhone || undefined,
        newsletterOptIn: buyerNewsletter,
        fiftyFiftyAmount: fiftyFiftyAmount || undefined,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      document.getElementById('cashModal').classList.add('hidden');
      refreshInventory();
      showSuccess(total, 'Cash', data.ticketNumbers, data.emailSent);
    } catch (err) {
      document.getElementById('cashModal').classList.add('hidden');
      showToast('Cash error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm Cash Received';
    }
  }

  // --- Success ---
  function showSuccess(amount, method, ticketNumbers, emailSent) {
    document.getElementById('successAmount').textContent = '$' + amount.toFixed(2);
    document.getElementById('successMethod').textContent = method ? 'Paid via ' + method : '';

    const ticketsDiv = document.getElementById('successTickets');
    const ticketListDiv = document.getElementById('ticketNumberList');
    const emailNote = document.getElementById('emailSentNote');

    if (ticketNumbers && ticketNumbers.length > 0) {
      ticketListDiv.innerHTML = ticketNumbers
        .map(n => `<span class="ticket-number">${n}</span>`)
        .join('');
      emailNote.textContent = emailSent
        ? 'Ticket numbers emailed to ' + buyerEmail
        : 'Email could not be sent - please note these numbers';
      ticketsDiv.style.display = 'block';
    } else {
      ticketsDiv.style.display = 'none';
    }

    document.getElementById('successOverlay').classList.remove('hidden');
    clearCart();
    refreshJackpot();
  }

  // --- History ---
  async function loadHistory() {
    document.getElementById('historyScreen').classList.remove('hidden');
    document.getElementById('transactionList').innerHTML = '<p class="loading">Loading...</p>';

    try {
      const res = await authGet('/api/transactions');
      const txns = await res.json();

      if (txns.length === 0) {
        document.getElementById('transactionList').innerHTML =
          '<p class="loading">No transactions yet</p>';
        return;
      }

      document.getElementById('transactionList').innerHTML = txns
        .map(
          (t) => {
            const isRefunded = t.status === 'refunded';
            return `
        <div class="transaction-item ${isRefunded ? 'txn-refunded' : ''}">
          <div class="txn-info">
            <span class="txn-desc">${escapeHtml(t.description)}</span>
            <span class="txn-date">${escapeHtml(formatDate(t.created))}</span>
          </div>
          <div class="txn-right">
            <span class="txn-amount ${isRefunded ? 'amount-refunded' : ''}">$${t.amount}</span>
            ${isRefunded
              ? '<span class="txn-status refunded">refunded</span>'
              : `<span class="txn-method ${t.method}">${t.method}</span>
                 <button class="refund-btn" data-txid="${escapeHtml(t.tx_id)}" data-amount="${t.amount}" data-method="${t.method}">Refund</button>`
            }
          </div>
        </div>
      `;
          }
        )
        .join('');

      // Bind refund buttons
      document.getElementById('transactionList').querySelectorAll('.refund-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const txId = btn.dataset.txid;
          const amount = btn.dataset.amount;
          const method = btn.dataset.method;
          handleRefund(txId, amount, method, btn);
        });
      });
    } catch (err) {
      document.getElementById('transactionList').innerHTML =
        '<p class="loading">Error loading transactions</p>';
    }
  }

  // --- Refund ---
  async function handleRefund(txId, amount, method, btn) {
    const label = method === 'cash' ? 'cash' : 'card';
    const ok = await showConfirm('Refund Payment', `Refund $${amount} ${label} payment?`, 'Refund', true);
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = 'Refunding...';

    try {
      const res = await authPost('/api/refund', {
        paymentId: txId,
        amount: parseFloat(amount),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Refresh history to show updated status
      refreshInventory();
      loadHistory();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Refund';
      showToast('Refund failed: ' + err.message);
    }
  }

  // --- Report ---
  async function loadReport() {
    document.getElementById('reportScreen').classList.remove('hidden');
    document.getElementById('reportContent').innerHTML = '<p class="loading">Loading...</p>';

    try {
      const res = await authGet('/api/report');
      const data = await res.json();

      const tickets5050 = data.tickets5050 || { sold: 0, available: 0 };

      const refunds = data.refunds || { count: 0, total: '0.00' };
      const hasRefunds = refunds.count > 0;

      document.getElementById('reportContent').innerHTML = `
        <div class="report-hero">
          <div class="report-total-label">Total Revenue</div>
          <div class="report-total-amount">$${data.totalRevenue}</div>
          <div class="report-total-count">${data.totalSales} sale${data.totalSales !== 1 ? 's' : ''}</div>
          ${hasRefunds ? `
            <div class="report-refund-summary">
              <span class="refund-line">- $${refunds.total} refunded (${refunds.count})</span>
              <span class="net-line">Net: $${data.netRevenue}</span>
            </div>
          ` : ''}
        </div>

        <div class="report-breakdown">
          <div class="report-card">
            <div class="report-card-icon cash-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Cash</span>
              <span class="report-card-count">${data.cash.count} sale${data.cash.count !== 1 ? 's' : ''}</span>
            </div>
            <span class="report-card-amount">$${data.cash.total}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon card-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Card</span>
              <span class="report-card-count">${data.card.count} sale${data.card.count !== 1 ? 's' : ''}</span>
            </div>
            <span class="report-card-amount">$${data.card.total}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon ticket-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 10h20"/><circle cx="12" cy="15" r="1"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">50/50 Tickets</span>
              <span class="report-card-count">${tickets5050.sold} sold / ${tickets5050.available} remaining</span>
            </div>
          </div>
        </div>

        <div class="export-row">
          ${data.newsletterSubscribers > 0 ? `
          <button onclick="window._downloadExport()" class="btn btn-export">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export Yer Letter Subscribers (${data.newsletterSubscribers}) CSV
          </button>
          ` : `
          <div class="btn btn-export btn-export-disabled">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            No Yer Letter Subscribers Yet
          </div>
          `}
        </div>

        <div class="report-section-title">Recent Transactions</div>
        <div class="report-transactions">
          ${data.transactions.length === 0 ? '<p class="loading">No transactions yet</p>' : ''}
          ${data.transactions
            .slice(0, 50)
            .map(
              (t) => {
                const isRefunded = t.status === 'refunded';
                return `
            <div class="transaction-item ${isRefunded ? 'txn-refunded' : ''}">
              <div class="txn-info">
                <span class="txn-desc">${escapeHtml(t.description)}</span>
                <span class="txn-date">${escapeHtml(formatDate(t.created))}</span>
              </div>
              <div class="txn-right">
                <span class="txn-amount ${isRefunded ? 'amount-refunded' : ''}">$${t.amount}</span>
                ${isRefunded
                  ? '<span class="txn-status refunded">refunded</span>'
                  : `<span class="txn-method ${t.method}">${t.method}</span>`
                }
              </div>
            </div>
          `;
              }
            )
            .join('')}
        </div>
      `;
    } catch (err) {
      document.getElementById('reportContent').innerHTML =
        '<p class="loading">Error loading report</p>';
    }
  }

  // --- Helpers ---
  function formatDate(isoString) {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  const escapeEl = document.createElement('div');
  function escapeHtml(str) {
    escapeEl.textContent = str;
    return escapeEl.innerHTML;
  }

  // --- Inventory ---
  async function refreshInventory() {
    try {
      const res = await fetch('/api/inventory');
      const inv = await res.json();
      for (const [product, remaining] of Object.entries(inv)) {
        const el = document.getElementById('inv-' + product);
        if (el) {
          el.textContent = remaining + ' left';
          el.classList.toggle('sold-out', remaining <= 0);
        }
        const btn = document.querySelector(`[data-product="${product}"]`);
        if (btn) {
          btn.disabled = remaining <= 0;
          if (remaining <= 0) btn.classList.add('sold-out-btn');
          else btn.classList.remove('sold-out-btn');
        }
        if (product === 'Door Ticket') {
          const doorBtn = document.getElementById('addDoorTicket');
          if (doorBtn) {
            doorBtn.disabled = remaining <= 0;
            if (remaining <= 0) doorBtn.classList.add('sold-out-btn');
            else doorBtn.classList.remove('sold-out-btn');
          }
        }
      }
    } catch (err) {
      console.error('Error fetching inventory:', err);
    }

    // Refresh 50/50 ticket count
    try {
      const res = await fetch('/api/tickets-5050/available');
      const data = await res.json();
      const el = document.getElementById('tickets5050count');
      if (el && data.available !== undefined) {
        el.textContent = '(' + data.available + ' left)';
      }
    } catch (err) {
      console.error('Error fetching 50/50 count:', err);
    }
  }

  // Only poll inventory when checkout screen is visible (no overlapping screens open)
  setInterval(() => {
    const historyVisible = !document.getElementById('historyScreen').classList.contains('hidden');
    const reportVisible = !document.getElementById('reportScreen').classList.contains('hidden');
    const inventoryVisible = !document.getElementById('inventoryScreen').classList.contains('hidden');
    const drawVisible = !document.getElementById('drawScreen').classList.contains('hidden');
    if (!historyVisible && !reportVisible && !inventoryVisible && !drawVisible) {
      refreshInventory();
    }
  }, 10000);

  // --- 50/50 Jackpot ---
  async function refreshJackpot() {
    try {
      const res = await fetch('/api/tickets-5050/jackpot');
      const data = await res.json();
      if (data.error) return;
      const jackpotEl = document.getElementById('jackpotAmount');
      const detailEl = document.getElementById('jackpotDetail');
      const inlineEl = document.getElementById('jackpotInline');
      if (jackpotEl) jackpotEl.textContent = '$' + data.jackpot.toFixed(2);
      if (detailEl) detailEl.textContent = data.soldCount + ' ticket' + (data.soldCount !== 1 ? 's' : '') + ' sold \u2022 $' + data.totalSales.toFixed(2) + ' total sales';
      if (inlineEl) inlineEl.textContent = 'Jackpot: $' + data.jackpot.toFixed(2);
    } catch (e) { /* ignore */ }
  }

  // Refresh jackpot on load and every 10s
  refreshJackpot();
  setInterval(refreshJackpot, 10000);

  // --- 50/50 Draw ---
  let drawInProgress = false;

  function displayDrawResult(data) {
    document.getElementById('drawTicketNumber').textContent = data.ticketNumber;
    document.getElementById('drawWinnerName').textContent = data.name || 'No name on file';
    document.getElementById('drawWinnerEmail').textContent = data.email || 'No email on file';
    document.getElementById('drawWinnerPhone').textContent = data.phone || 'No phone on file';
    document.getElementById('drawPoolSize').textContent = data.totalSold + ' ticket' + (data.totalSold !== 1 ? 's' : '') + ' sold';
    document.getElementById('drawResult').classList.remove('hidden');
    document.getElementById('redrawBtn').classList.remove('hidden');
  }

  async function runDraw() {
    if (drawInProgress) return; // double-tap guard
    drawInProgress = true;

    const drawBtn = document.getElementById('runDrawBtn');
    const redrawBtn = document.getElementById('redrawBtn');

    drawBtn.disabled = true;
    drawBtn.textContent = 'Drawing...';
    redrawBtn.classList.add('hidden');

    try {
      const res = await authPost('/api/draw-5050', {});
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      displayDrawResult(data);
    } catch (err) {
      showToast('Draw failed: ' + err.message);
    } finally {
      drawBtn.disabled = false;
      drawBtn.textContent = 'Draw Winner';
      drawInProgress = false;
    }
  }

  // --- Inventory Editor ---
  async function openInventoryEditor() {
    document.getElementById('inventoryScreen').classList.remove('hidden');
    document.getElementById('inv-save-status').textContent = '';
    try {
      const res = await fetch('/api/inventory');
      const inv = await res.json();
      document.getElementById('invEarlyBird').value = inv['Early Bird Ticket'] ?? 0;
      document.getElementById('invGA').value = inv['GA Ticket'] ?? 0;
      document.getElementById('invDoor').value = inv['Door Ticket'] ?? 0;
    } catch (err) {
      console.error('Error loading inventory for edit:', err);
    }
  }

  async function saveInventoryEdits() {
    const btn = document.getElementById('saveInventoryBtn');
    const status = document.getElementById('inv-save-status');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    status.textContent = '';

    try {
      const items = [
        { name: 'Early Bird Ticket', remaining: parseInt(document.getElementById('invEarlyBird').value) || 0 },
        { name: 'GA Ticket', remaining: parseInt(document.getElementById('invGA').value) || 0 },
        { name: 'Door Ticket', remaining: parseInt(document.getElementById('invDoor').value) || 0 },
      ];

      const res = await authPost('/api/inventory/update', { items });
      const data = await res.json();

      if (data.error) {
        status.style.color = 'var(--danger)';
        status.textContent = data.error;
      } else {
        status.style.color = 'var(--success)';
        status.textContent = 'Saved!';
        refreshInventory();
      }
    } catch (err) {
      status.style.color = 'var(--danger)';
      status.textContent = 'Error saving: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  }

  // --- Newsletter CSV download (authenticated) ---
  window._downloadExport = async function() {
    try {
      const res = await authGet('/api/newsletter-export');
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'yer-letter-subscribers.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast('Export failed: ' + err.message);
    }
  };

  // --- Start ---
  init();
})();
