(() => {
  let stripe, elements, cardElement;
  let paymentRequest, prButton;
  let cart = [];
  let doorQty = 1;

  // --- Init ---
  async function init() {
    // Bind buttons first so the UI is always responsive
    bindEvents();

    try {
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

      // Setup Apple Pay / Google Pay via Payment Request API
      setupPaymentRequest();
    } catch (err) {
      console.error('Stripe init error:', err);
    }
  }

  // --- Apple Pay / Google Pay ---
  function setupPaymentRequest() {
    paymentRequest = stripe.paymentRequest({
      country: 'US',
      currency: 'usd',
      total: {
        label: 'TTH Podcast Series',
        amount: 100, // placeholder, updated when user taps Pay
      },
      requestPayerName: false,
      requestPayerEmail: false,
    });

    prButton = elements.create('paymentRequestButton', {
      paymentRequest: paymentRequest,
      style: {
        paymentRequestButton: {
          type: 'default',
          theme: 'dark',
          height: '48px',
        },
      },
    });

    // Check if Apple Pay / Google Pay is available
    paymentRequest.canMakePayment().then((result) => {
      if (result) {
        document.getElementById('applePayBtn').dataset.available = 'true';
      } else {
        // Keep button visible but mark as unavailable
        document.getElementById('applePayBtn').dataset.available = 'false';
      }
    });

    // Handle the payment
    paymentRequest.on('paymentmethod', async (ev) => {
      const total = getTotal();
      try {
        const res = await fetch('/api/create-payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: total, description: getDescription() }),
        });
        const { clientSecret, paymentIntentId, error } = await res.json();
        if (error) {
          ev.complete('fail');
          return;
        }

        const { paymentIntent, error: confirmError } = await stripe.confirmCardPayment(
          clientSecret,
          { payment_method: ev.paymentMethod.id },
          { handleActions: false }
        );

        if (confirmError) {
          ev.complete('fail');
          document.getElementById('applePay-errors').textContent = confirmError.message;
          return;
        }

        if (paymentIntent.status === 'requires_action') {
          const { error: actionError } = await stripe.confirmCardPayment(clientSecret);
          if (actionError) {
            ev.complete('fail');
            document.getElementById('applePay-errors').textContent = actionError.message;
            return;
          }
        }

        ev.complete('success');

        // Record in local log
        await fetch('/api/record-card-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: total,
            description: getDescription(),
            method: 'applepay',
            paymentIntentId,
          }),
        });

        document.getElementById('applePayModal').classList.add('hidden');
        showSuccess(total, 'Apple Pay');
      } catch (err) {
        ev.complete('fail');
        document.getElementById('applePay-errors').textContent = err.message;
      }
    });
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
    const applePayBtn = document.getElementById('applePayBtn');
    const cashBtn = document.getElementById('cashBtn');
    const clearBtn = document.getElementById('clearCartBtn');

    if (cart.length === 0) {
      emptyEl.style.display = 'block';
      itemsEl.innerHTML = '';
      totalEl.style.display = 'none';
      chargeBtn.disabled = true;
      applePayBtn.disabled = true;
      cashBtn.disabled = true;
      clearBtn.disabled = true;
      return;
    }

    emptyEl.style.display = 'none';
    totalEl.style.display = 'flex';
    chargeBtn.disabled = false;
    applePayBtn.disabled = false;
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

    // --- Apple Pay ---
    document.getElementById('applePayBtn').addEventListener('click', () => {
      const total = getTotal();
      if (total < 0.5) return;
      const btn = document.getElementById('applePayBtn');
      if (!paymentRequest || btn.dataset.available === 'false') {
        alert('Apple Pay is not available. You may need to verify your domain in Stripe Dashboard > Settings > Payments > Apple Pay.');
        return;
      }

      // Update the payment request amount
      paymentRequest.update({
        total: {
          label: 'TTH Podcast Series',
          amount: Math.round(total * 100),
        },
      });

      document.getElementById('applePayAmount').textContent = total.toFixed(2);
      document.getElementById('applePay-errors').textContent = '';
      document.getElementById('applePayModal').classList.remove('hidden');

      // Mount the payment request button
      const container = document.getElementById('payment-request-button');
      container.innerHTML = '';
      prButton.mount('#payment-request-button');
    });

    document.getElementById('closeApplePay').addEventListener('click', () => {
      document.getElementById('applePayModal').classList.add('hidden');
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
            <div class="report-card-icon applepay-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.72 6.56c-.95 1.13-2.5 2-3.98 1.87-.19-1.52.56-3.13 1.43-4.13.95-1.1 2.58-1.9 3.91-1.96.16 1.58-.47 3.13-1.36 4.22zM18.35 8.65c-2.2-.13-4.08 1.25-5.13 1.25-1.05 0-2.65-1.19-4.38-1.16-2.25.03-4.33 1.31-5.48 3.33-2.35 4.05-.6 10.06 1.68 13.36 1.13 1.63 2.47 3.45 4.23 3.39 1.69-.07 2.33-1.09 4.38-1.09 2.04 0 2.62 1.09 4.41 1.06 1.83-.03 2.99-1.66 4.12-3.3 1.28-1.88 1.81-3.7 1.84-3.8-.04-.01-3.53-1.35-3.56-5.37-.03-3.36 2.74-4.97 2.87-5.06-1.57-2.32-4.02-2.58-4.88-2.63l-.1.02z"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Apple Pay</span>
              <span class="report-card-count">${data.applepay.count} sales</span>
            </div>
            <span class="report-card-amount">$${data.applepay.total}</span>
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
