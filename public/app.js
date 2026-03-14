(() => {
  let stripe, elements, cardElement, terminal;
  let cart = [];
  let doorQty = 1;

  // --- Init ---
  async function init() {
    const res = await fetch('/api/config');
    const { publishableKey } = await res.json();
    stripe = Stripe(publishableKey);
    elements = stripe.elements();

    cardElement = elements.create('card', {
      style: {
        base: {
          color: '#140038',
          fontSize: '16px',
          fontFamily: 'Poppins, sans-serif',
          '::placeholder': { color: '#929292' },
        },
        invalid: { color: '#ef4444' },
      },
    });
    cardElement.mount('#card-element');
    cardElement.on('change', (e) => {
      document.getElementById('card-errors').textContent = e.error ? e.error.message : '';
    });

    initTerminal();
    bindEvents();
  }

  function initTerminal() {
    try {
      terminal = StripeTerminal.create({
        onFetchConnectionToken: async () => {
          const res = await fetch('/api/terminal/connection-token', { method: 'POST' });
          const data = await res.json();
          return data.secret;
        },
        onUnexpectedReaderDisconnect: () => {
          showTerminalMessage('Reader disconnected. Reconnect to continue.');
        },
      });
    } catch (e) {
      console.log('Terminal SDK not available:', e.message);
    }
  }

  // --- Cart ---
  function addToCart(product, qty, price) {
    cart.push({ product, qty, price, id: Date.now() });
    renderCart();
  }

  function removeFromCart(id) {
    cart = cart.filter((item) => item.id !== id);
    renderCart();
  }

  function clearCart() {
    cart = [];
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
    const termBtn = document.getElementById('terminalBtn');
    const cashBtn = document.getElementById('cashBtn');
    const clearBtn = document.getElementById('clearCartBtn');

    if (cart.length === 0) {
      emptyEl.style.display = 'block';
      itemsEl.innerHTML = '';
      totalEl.style.display = 'none';
      chargeBtn.disabled = true;
      termBtn.disabled = true;
      cashBtn.disabled = true;
      clearBtn.disabled = true;
      return;
    }

    emptyEl.style.display = 'none';
    totalEl.style.display = 'flex';
    chargeBtn.disabled = false;
    termBtn.disabled = false;
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
      if (doorQty < 50) {
        doorQty++;
        document.getElementById('doorQty').textContent = doorQty;
      }
    });

    document.getElementById('addDoorTicket').addEventListener('click', () => {
      addToCart('Door Ticket' + (doorQty > 1 ? 's' : ''), doorQty, doorQty * 30);
      doorQty = 1;
      document.getElementById('doorQty').textContent = 1;
    });

    // Clear cart
    document.getElementById('clearCartBtn').addEventListener('click', clearCart);

    // --- Card ---
    document.getElementById('chargeCardBtn').addEventListener('click', () => {
      const total = getTotal();
      if (total < 0.5) return;
      document.getElementById('modalAmount').textContent = total.toFixed(2);
      document.getElementById('paymentModal').classList.remove('hidden');
    });

    document.getElementById('closePayment').addEventListener('click', () => {
      document.getElementById('paymentModal').classList.add('hidden');
    });

    document.getElementById('payBtn').addEventListener('click', handleCardPayment);

    // --- Terminal ---
    document.getElementById('terminalBtn').addEventListener('click', handleTerminalPayment);

    document.getElementById('closeTerminal').addEventListener('click', () => {
      if (terminal) terminal.cancelCollectPaymentMethod?.();
      document.getElementById('terminalModal').classList.add('hidden');
    });

    document.getElementById('cancelTerminal').addEventListener('click', () => {
      if (terminal) terminal.cancelCollectPaymentMethod?.();
      document.getElementById('terminalModal').classList.add('hidden');
    });

    // --- Cash ---
    document.getElementById('cashBtn').addEventListener('click', () => {
      const total = getTotal();
      if (total < 0.01) return;
      document.getElementById('cashAmount').textContent = total.toFixed(2);
      document.getElementById('cashModal').classList.remove('hidden');
    });

    document.getElementById('closeCash').addEventListener('click', () => {
      document.getElementById('cashModal').classList.add('hidden');
    });

    document.getElementById('confirmCashBtn').addEventListener('click', handleCashPayment);

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
  }

  // --- Card Payment ---
  async function handleCardPayment() {
    const total = getTotal();
    if (total < 0.5) return;
    const payBtn = document.getElementById('payBtn');
    payBtn.disabled = true;
    payBtn.textContent = 'Processing...';

    try {
      const res = await fetch('/api/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: total, description: getDescription() }),
      });
      const { clientSecret, paymentIntentId, error } = await res.json();
      if (error) throw new Error(error);

      const result = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card: cardElement },
      });

      if (result.error) {
        document.getElementById('card-errors').textContent = result.error.message;
      } else if (result.paymentIntent.status === 'succeeded') {
        // Record in local log
        await fetch('/api/record-card-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: total,
            description: getDescription(),
            method: 'card',
            paymentIntentId,
          }),
        });
        document.getElementById('paymentModal').classList.add('hidden');
        showSuccess(total, 'Card');
      }
    } catch (err) {
      document.getElementById('card-errors').textContent = err.message;
    } finally {
      payBtn.disabled = false;
      payBtn.textContent = 'Pay Now';
    }
  }

  // --- Terminal Payment ---
  async function handleTerminalPayment() {
    const total = getTotal();
    if (total < 0.5) return;
    if (!terminal) {
      alert('Stripe Terminal is not available.');
      return;
    }

    document.getElementById('terminalAmount').textContent = total.toFixed(2);
    document.getElementById('terminalModal').classList.remove('hidden');

    try {
      showTerminalMessage('Discovering readers...');
      const discoverResult = await terminal.discoverReaders({ simulated: false });

      if (discoverResult.error) {
        showTerminalMessage('No readers found. Check your reader is on and nearby.');
        return;
      }
      if (discoverResult.discoveredReaders.length === 0) {
        showTerminalMessage('No readers found nearby.');
        return;
      }

      const reader = discoverResult.discoveredReaders[0];
      showTerminalMessage('Connecting to ' + (reader.label || 'reader') + '...');
      const connectResult = await terminal.connectReader(reader);

      if (connectResult.error) {
        showTerminalMessage('Failed to connect: ' + connectResult.error.message);
        return;
      }

      showTerminalMessage('Ready - present card');
      const res = await fetch('/api/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: total, description: getDescription() }),
      });
      const { clientSecret, paymentIntentId, error } = await res.json();
      if (error) throw new Error(error);

      const collectResult = await terminal.collectPaymentMethod(clientSecret);
      if (collectResult.error) {
        showTerminalMessage('Cancelled or failed: ' + collectResult.error.message);
        return;
      }

      showTerminalMessage('Processing...');
      const processResult = await terminal.processPayment(collectResult.paymentIntent);
      if (processResult.error) {
        showTerminalMessage('Payment failed: ' + processResult.error.message);
        return;
      }

      await fetch('/api/terminal/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId }),
      });

      // Record in local log
      await fetch('/api/record-card-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: total,
          description: getDescription(),
          method: 'terminal',
          paymentIntentId,
        }),
      });

      document.getElementById('terminalModal').classList.add('hidden');
      showSuccess(total, 'Terminal');
    } catch (err) {
      showTerminalMessage('Error: ' + err.message);
    }
  }

  function showTerminalMessage(msg) {
    document.getElementById('terminalMessage').textContent = msg;
  }

  // --- Cash Payment ---
  async function handleCashPayment() {
    const total = getTotal();
    const btn = document.getElementById('confirmCashBtn');
    btn.disabled = true;
    btn.textContent = 'Recording...';

    try {
      const res = await fetch('/api/cash-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: total, description: getDescription() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      document.getElementById('cashModal').classList.add('hidden');
      showSuccess(total, 'Cash');
    } catch (err) {
      alert('Error recording cash payment: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm Cash Received';
    }
  }

  // --- Success ---
  function showSuccess(amount, method) {
    document.getElementById('successAmount').textContent = '$' + amount.toFixed(2);
    document.getElementById('successMethod').textContent = method ? 'Paid via ' + method : '';
    document.getElementById('successOverlay').classList.remove('hidden');
    clearCart();
  }

  // --- History ---
  async function loadHistory() {
    document.getElementById('historyScreen').classList.remove('hidden');
    document.getElementById('transactionList').innerHTML = '<p class="loading">Loading...</p>';

    try {
      const res = await fetch('/api/transactions');
      const txns = await res.json();

      if (txns.length === 0) {
        document.getElementById('transactionList').innerHTML =
          '<p class="loading">No transactions yet</p>';
        return;
      }

      document.getElementById('transactionList').innerHTML = txns
        .map(
          (t) => `
        <div class="transaction-item">
          <div class="txn-info">
            <span class="txn-desc">${escapeHtml(t.description)}</span>
            <span class="txn-date">${escapeHtml(formatDate(t.created))}</span>
          </div>
          <div class="txn-right">
            <span class="txn-amount">$${t.amount}</span>
            <span class="txn-method ${t.method}">${t.method}</span>
          </div>
        </div>
      `
        )
        .join('');
    } catch (err) {
      document.getElementById('transactionList').innerHTML =
        '<p class="loading">Error loading transactions</p>';
    }
  }

  // --- Report ---
  async function loadReport() {
    document.getElementById('reportScreen').classList.remove('hidden');
    document.getElementById('reportContent').innerHTML = '<p class="loading">Loading...</p>';

    try {
      const res = await fetch('/api/report');
      const data = await res.json();

      document.getElementById('reportContent').innerHTML = `
        <div class="report-hero">
          <div class="report-total-label">Total Revenue</div>
          <div class="report-total-amount">$${data.totalRevenue}</div>
          <div class="report-total-count">${data.totalSales} sale${data.totalSales !== 1 ? 's' : ''}</div>
        </div>

        <div class="report-breakdown">
          <div class="report-card">
            <div class="report-card-icon cash-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Cash</span>
              <span class="report-card-count">${data.cash.count} sales</span>
            </div>
            <span class="report-card-amount">$${data.cash.total}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon card-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Card</span>
              <span class="report-card-count">${data.card.count} sales</span>
            </div>
            <span class="report-card-amount">$${data.card.total}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon terminal-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Terminal</span>
              <span class="report-card-count">${data.terminal.count} sales</span>
            </div>
            <span class="report-card-amount">$${data.terminal.total}</span>
          </div>
        </div>

        <div class="report-section-title">Recent Transactions</div>
        <div class="report-transactions">
          ${data.transactions.length === 0 ? '<p class="loading">No transactions yet</p>' : ''}
          ${data.transactions
            .slice(0, 50)
            .map(
              (t) => `
            <div class="transaction-item">
              <div class="txn-info">
                <span class="txn-desc">${escapeHtml(t.description)}</span>
                <span class="txn-date">${escapeHtml(formatDate(t.created))}</span>
              </div>
              <div class="txn-right">
                <span class="txn-amount">$${t.amount}</span>
                <span class="txn-method ${t.method}">${t.method}</span>
              </div>
            </div>
          `
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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Start ---
  init();
})();
