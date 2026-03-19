(() => {
  let payments, card;

  let cart = [];
  let doorQty = 1;
  let appConfig = {};
  let pendingPaymentType = null; // 'logSale', 'addProduct', etc.
  let buyerEmail = '';
  let buyerName = '';
  let buyerPhone = '';
  let buyerNewsletter = false;
  let cartIdCounter = 0;
  let expenseValue = '';
  let gfmValue = '';
  let pendingProduct = null; // for admin-locked product buttons

  // --- Modal focus trapping ---
  let activeModalStack = [];
  let previousFocusEl = null;

  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    previousFocusEl = document.activeElement;
    modal.classList.remove('hidden');
    activeModalStack.push(modalId);
    // Focus first focusable element
    const focusable = modal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) setTimeout(() => focusable[0].focus(), 100);
    modal._trapHandler = (e) => {
      if (e.key === 'Tab') {
        const nodes = modal.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      if (e.key === 'Escape') closeModal(modalId);
    };
    modal.addEventListener('keydown', modal._trapHandler);
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('hidden');
    if (modal._trapHandler) {
      modal.removeEventListener('keydown', modal._trapHandler);
      modal._trapHandler = null;
    }
    activeModalStack = activeModalStack.filter(id => id !== modalId);
    if (previousFocusEl && activeModalStack.length === 0) {
      previousFocusEl.focus();
      previousFocusEl = null;
    }
  }

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
      openModal('confirmModal');

      function cleanup(result) {
        closeModal('confirmModal');
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

  // --- Session token management ---
  let sessionToken = sessionStorage.getItem('pos-session') || '';

  // Authenticated POST helper
  function authPost(url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (sessionToken) headers['X-Session-Token'] = sessionToken;
    if (appConfig.apiKey) headers['X-POS-Key'] = appConfig.apiKey;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  // Authenticated GET helper (for protected read endpoints)
  function authGet(url) {
    const headers = {};
    if (sessionToken) headers['X-Session-Token'] = sessionToken;
    if (appConfig.apiKey) headers['X-POS-Key'] = appConfig.apiKey;
    return fetch(url, { headers });
  }

  // --- PIN login ---
  async function requireSession() {
    // If we already have a valid session, skip
    if (sessionToken) {
      const test = await fetch('/api/inventory', { headers: { 'X-Session-Token': sessionToken } });
      if (test.ok) return true;
      // Session expired
      sessionToken = '';
      sessionStorage.removeItem('pos-session');
    }

    // Show PIN screen
    return new Promise((resolve) => {
      const splash = document.getElementById('loadingSplash');
      if (splash) splash.style.display = 'none';
      const pinScreen = document.getElementById('pinScreen');
      const pinInput = document.getElementById('pinInput');
      const pinSubmit = document.getElementById('pinSubmit');
      const pinError = document.getElementById('pinError');
      pinScreen.style.display = 'flex';
      pinInput.value = '';
      pinError.textContent = '';
      pinInput.focus();

      let pinAttempts = 0;
      const MAX_PIN_ATTEMPTS = 3;

      async function tryLogin() {
        const pin = pinInput.value.trim();
        if (!pin) return;
        pinSubmit.disabled = true;
        try {
          const res = await fetch('/api/session/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
          });
          if (res.ok) {
            const data = await res.json();
            sessionToken = data.token;
            sessionStorage.setItem('pos-session', sessionToken);
            pinScreen.style.display = 'none';
            resolve(true);
          } else if (res.status === 429) {
            pinInput.style.display = 'none';
            pinSubmit.style.display = 'none';
            pinError.textContent = 'Locked out. Wait 15 minutes.';
            pinError.style.fontSize = '14px';
          } else {
            pinAttempts++;
            const remaining = MAX_PIN_ATTEMPTS - pinAttempts;
            if (remaining <= 0) {
              pinInput.style.display = 'none';
              pinSubmit.style.display = 'none';
              pinError.textContent = 'Locked out. Wait 15 minutes.';
              pinError.style.fontSize = '14px';
            } else {
              pinError.textContent = `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`;
              pinInput.value = '';
              pinInput.focus();
            }
          }
        } catch (e) {
          pinError.textContent = 'Connection error';
        }
        pinSubmit.disabled = false;
      }

      pinSubmit.onclick = tryLogin;
      pinInput.onkeydown = (e) => { if (e.key === 'Enter') tryLogin(); };
    });
  }

  // --- Init ---
  async function init() {
    bindEvents();
    updateOnlineStatus();

    try {
      // Require PIN before anything loads
      await requireSession();

      const res = await fetch('/api/config');
      appConfig = await res.json();

      // Square SDK kept dormant - tracker mode
      // SDK can be loaded manually if card payments are needed later

      refreshInventory();
      refreshGoFundMe();

      // Hide loading splash
      const splash = document.getElementById('loadingSplash');
      if (splash) splash.remove();
    } catch (err) {
      console.error('Init error:', err);
      const splash = document.getElementById('loadingSplash');
      if (splash) splash.remove();
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

  // --- Check if cart needs buyer info (any tickets) ---
  function cartNeedsBuyerInfo() {
    return cart.some(item =>
      item.product === '50/50 Tickets' ||
      item.product === 'Door Tickets' ||
      item.product === 'Early Bird Ticket' ||
      item.product === 'GA Ticket'
    );
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
    const logSaleBtn = document.getElementById('logSaleBtn');
    const clearBtn = document.getElementById('clearCartBtn');

    if (cart.length === 0) {
      emptyEl.style.display = 'block';
      itemsEl.innerHTML = '';
      totalEl.style.display = 'none';
      logSaleBtn.disabled = true;
      clearBtn.disabled = true;
      return;
    }

    emptyEl.style.display = 'none';
    totalEl.style.display = 'flex';
    logSaleBtn.disabled = false;
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
          <button class="cart-remove" data-id="${item.id}" aria-label="Remove ${escapeHtml(item.product)}">&times;</button>
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
    // Product buttons (raffle, 50/50, event tickets) - all unlocked in tracker mode
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

    // --- Log Sale button ---
    document.getElementById('logSaleBtn').addEventListener('click', () => {
      const total = getTotal();
      if (total < 0.01) return;
      if (cartNeedsBuyerInfo()) {
        pendingPaymentType = 'logSale';
        showEmailModal();
      } else {
        buyerEmail = '';
        buyerName = '';
        buyerPhone = '';
        buyerNewsletter = false;
        handleLogSale();
      }
    });

    // --- Email modal ---
    document.getElementById('closeEmail').addEventListener('click', () => {
      closeModal('emailModal');
      pendingPaymentType = null;
    });

    document.getElementById('confirmEmailBtn').addEventListener('click', handleEmailConfirm);

    // Clear errors on typing, submit on Enter from any field
    ['buyerFirstName', 'buyerLastName', 'buyerEmail', 'buyerPhone'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        document.getElementById('email-errors').textContent = '';
      });
      document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleEmailConfirm();
      });
    });

    // --- Admin password modal ---
    document.getElementById('closeAdmin').addEventListener('click', () => {
      closeModal('adminModal');
    });
    document.getElementById('confirmAdminBtn').addEventListener('click', handleAdminConfirm);
    document.getElementById('adminPasswordInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAdminConfirm();
    });
    document.getElementById('adminPasswordInput').addEventListener('input', () => {
      document.getElementById('admin-errors').textContent = '';
    });

    // --- Expense button (admin password required, inside report screen) ---
    document.getElementById('expenseBtn').addEventListener('click', () => {
      pendingPaymentType = 'expense';
      showAdminModal();
    });

    // --- Expense modal ---
    document.getElementById('closeExpense').addEventListener('click', () => {
      closeModal('expenseModal');
      expenseValue = '';
    });

    document.querySelectorAll('.numpad-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        haptic();
        const val = btn.dataset.val;
        if (val === 'del') {
          expenseValue = expenseValue.slice(0, -1);
        } else if (val === '.') {
          if (!expenseValue.includes('.')) expenseValue += '.';
        } else {
          // Limit to 2 decimal places
          const dotIdx = expenseValue.indexOf('.');
          if (dotIdx >= 0 && expenseValue.length - dotIdx > 2) return;
          // Limit total length
          if (expenseValue.replace('.', '').length >= 7) return;
          expenseValue += val;
        }
        updateExpenseDisplay();
      });
    });

    document.querySelectorAll('.expense-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        haptic();
        submitExpense(btn.dataset.category);
      });
    });

    // --- GoFundMe modal ---
    document.getElementById('editGfmBtn').addEventListener('click', () => {
      gfmValue = '';
      document.getElementById('gfmDisplay').textContent = '$0.00';
      document.getElementById('gfm-errors').textContent = '';
      openModal('gfmModal');
    });
    document.getElementById('closeGfm').addEventListener('click', () => {
      closeModal('gfmModal');
      gfmValue = '';
    });
    document.querySelectorAll('.gfm-numpad-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        haptic();
        const val = btn.dataset.val;
        if (val === 'del') {
          gfmValue = gfmValue.slice(0, -1);
        } else if (val === '.') {
          if (!gfmValue.includes('.')) gfmValue += '.';
        } else {
          const dotIdx = gfmValue.indexOf('.');
          if (dotIdx >= 0 && gfmValue.length - dotIdx > 2) return;
          if (gfmValue.replace('.', '').length >= 7) return;
          gfmValue += val;
        }
        const num = parseFloat(gfmValue) || 0;
        document.getElementById('gfmDisplay').textContent = '$' + num.toFixed(2);
      });
    });
    document.getElementById('saveGfmBtn').addEventListener('click', async () => {
      const val = parseFloat(gfmValue);
      if (isNaN(val) || val < 0) {
        document.getElementById('gfm-errors').textContent = 'Enter a valid amount';
        return;
      }
      try {
        const res = await authPost('/api/gofundme', { total: val });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        showToast('GoFundMe total updated', 'success');
        closeModal('gfmModal');
        gfmValue = '';
        refreshGoFundMe();
      } catch (err) {
        document.getElementById('gfm-errors').textContent = 'Error: ' + err.message;
      }
    });

    // --- New sale ---
    document.getElementById('newSaleBtn').addEventListener('click', () => {
      closeModal('successOverlay');
    });

    // --- History (admin locked) ---
    document.getElementById('historyBtn').addEventListener('click', () => {
      pendingPaymentType = 'history';
      showAdminModal();
    });
    document.getElementById('backBtn').addEventListener('click', () => {
      document.getElementById('historyScreen').classList.add('hidden');
    });

    // --- Report (admin locked) ---
    document.getElementById('reportBtn').addEventListener('click', () => {
      pendingPaymentType = 'report';
      showAdminModal();
    });
    document.getElementById('closeBreakdown').addEventListener('click', () => {
      closeModal('salesBreakdownModal');
    });
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

    // --- Reallocate buttons ---
    document.getElementById('reallocateEBtoGA').addEventListener('click', () => reallocateTickets('Early Bird Ticket', 'GA Ticket'));
    document.getElementById('reallocateGAtoDoor').addEventListener('click', () => reallocateTickets('GA Ticket', 'Door Ticket'));

    // --- 50/50 Draw (admin locked) ---
    document.getElementById('drawBtn').addEventListener('click', () => {
      pendingPaymentType = 'draw';
      showAdminModal();
    });
    document.getElementById('drawBackBtn').addEventListener('click', () => {
      document.getElementById('drawScreen').classList.add('hidden');
    });
    document.getElementById('runDrawBtn').addEventListener('click', () => {
      pendingPaymentType = 'runDraw';
      showAdminModal();
    });
    document.getElementById('redrawBtn').addEventListener('click', () => {
      pendingPaymentType = 'runDraw';
      showAdminModal();
    });

    // Factory Reset
    document.getElementById('resetBtn').addEventListener('click', () => {
      pendingPaymentType = 'factoryReset';
      showAdminModal();
    });
  }

  // --- Buyer Info Modal ---
  function showEmailModal() {
    document.getElementById('buyerFirstName').value = '';
    document.getElementById('buyerLastName').value = '';
    document.getElementById('buyerEmail').value = '';
    document.getElementById('buyerPhone').value = '';
    document.getElementById('buyerNewsletter').checked = false;
    document.getElementById('email-errors').textContent = '';
    openModal('emailModal');
    setTimeout(() => document.getElementById('buyerFirstName').focus(), 300);
  }

  function handleEmailConfirm() {
    const firstName = document.getElementById('buyerFirstName').value.trim();
    const lastName = document.getElementById('buyerLastName').value.trim();
    const email = document.getElementById('buyerEmail').value.trim();
    const phone = document.getElementById('buyerPhone').value.trim();
    const newsletter = document.getElementById('buyerNewsletter').checked;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    const errors = [];
    if (!firstName) errors.push('First name is required');
    if (!lastName) errors.push('Last name is required');
    if (!email || !emailRegex.test(email)) errors.push('Valid email is required');
    if (!phone) errors.push('Phone number is required');

    if (errors.length > 0) {
      document.getElementById('email-errors').textContent = errors.join('. ');
      return;
    }

    buyerName = firstName + ' ' + lastName;
    buyerEmail = email;
    buyerPhone = phone;
    buyerNewsletter = newsletter;
    closeModal('emailModal');

    if (pendingPaymentType === 'logSale') {
      handleLogSale();
    }
    pendingPaymentType = null;
  }

  // --- Admin Password ---
  function showAdminModal() {
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('admin-errors').textContent = '';
    openModal('adminModal');
    setTimeout(() => document.getElementById('adminPasswordInput').focus(), 300);
  }

  async function handleAdminConfirm() {
    const password = document.getElementById('adminPasswordInput').value.trim();
    if (!password) {
      document.getElementById('admin-errors').textContent = 'Password required';
      return;
    }
    const btn = document.getElementById('confirmAdminBtn');
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    try {
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        document.getElementById('admin-errors').textContent = 'Incorrect password';
        return;
      }
      closeModal('adminModal');
      // Password verified - route to appropriate flow
      const flow = pendingPaymentType;
      pendingPaymentType = null;
      if (flow === 'addProduct') {
        if (pendingProduct) {
          addToCart(pendingProduct.product, pendingProduct.qty, pendingProduct.price);
          if (pendingProduct.product === 'Door Tickets') {
            doorQty = 1;
            document.getElementById('doorQty').textContent = 1;
          }
          pendingProduct = null;
        }
      } else if (flow === 'expense') {
        openExpenseModal();
      } else if (flow === 'history') {
        loadHistory();
      } else if (flow === 'report') {
        loadReport();
      } else if (flow === 'draw') {
        openDrawScreen();
      } else if (flow === 'runDraw') {
        runDraw();
      } else if (flow === 'factoryReset') {
        doFactoryReset();
      }
    } catch (err) {
      document.getElementById('admin-errors').textContent = 'Could not verify password';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  }

  // --- Expense Modal ---
  function openExpenseModal() {
    expenseValue = '';
    updateExpenseDisplay();
    document.getElementById('expense-errors').textContent = '';
    openModal('expenseModal');
  }

  function updateExpenseDisplay() {
    const num = parseFloat(expenseValue) || 0;
    document.getElementById('expenseDisplay').textContent = '$' + num.toFixed(2);
    // Disable category buttons if amount is 0
    const cats = document.querySelectorAll('.expense-cat-btn');
    cats.forEach(btn => { btn.disabled = num < 0.01; });
  }

  async function submitExpense(category) {
    const amount = parseFloat(expenseValue);
    if (!amount || amount < 0.01) {
      document.getElementById('expense-errors').textContent = 'Enter an amount first';
      return;
    }

    // Disable buttons during submit
    document.querySelectorAll('.expense-cat-btn').forEach(btn => { btn.disabled = true; });

    try {
      const res = await authPost('/api/expense', { amount, category });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      closeModal('expenseModal');
      expenseValue = '';
      showToast(`Expense logged: $${amount.toFixed(2)} - ${category}`, 'success', 3000);
    } catch (err) {
      document.getElementById('expense-errors').textContent = 'Error: ' + err.message;
    } finally {
      updateExpenseDisplay();
    }
  }

  // --- Factory Reset (admin protected) ---
  async function doFactoryReset() {
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
  }

  // --- Open Draw Screen ---
  async function openDrawScreen() {
    document.getElementById('drawScreen').classList.remove('hidden');
    refreshJackpot();
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
  }

  // --- Log Sale (tracker mode) ---
  async function handleLogSale() {
    const total = getTotal();
    if (total < 0.01) return;
    const btn = document.getElementById('logSaleBtn');
    btn.disabled = true;
    btn.textContent = 'Logging...';

    try {
      const fiftyFiftyAmount = cart.filter(i => i.product === '50/50 Tickets').reduce((s, i) => s + i.price, 0);
      const res = await authPost('/api/log-sale', {
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

      refreshInventory();
      showSuccess(total, 'Logged', data.ticketNumbers, data.emailSent, data.eventTickets, data.eventEmailSent);
    } catch (err) {
      showToast('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Log Sale';
    }
  }

  // --- Success ---
  function showSuccess(amount, method, ticketNumbers, emailSent, eventTickets, eventEmailSent) {
    document.getElementById('successAmount').textContent = '$' + amount.toFixed(2);
    document.getElementById('successTitle').textContent = method === 'Logged' ? 'Sale Logged' : 'Payment Successful';
    document.getElementById('successMethod').textContent = method === 'Logged' ? 'Sale logged' : (method ? 'Paid via ' + method : '');

    const ticketsDiv = document.getElementById('successTickets');
    const ticketListDiv = document.getElementById('ticketNumberList');
    const emailNote = document.getElementById('emailSentNote');

    const has5050 = ticketNumbers && ticketNumbers.length > 0;
    const hasEvent = eventTickets && eventTickets.length > 0;

    if (has5050 || hasEvent) {
      let html = '';

      if (has5050) {
        html += '<p class="tickets-label">50/50 Ticket Numbers:</p>';
        html += ticketNumbers.map(n => `<span class="ticket-number">${n}</span>`).join('');
      }

      if (hasEvent) {
        html += '<p class="tickets-label" style="margin-top:12px;">Event Ticket Numbers:</p>';
        html += eventTickets.map(t => `<span class="ticket-number">${t.ticketNumber}</span>`).join('');
      }

      ticketListDiv.innerHTML = html;

      const emailParts = [];
      if (has5050 && emailSent) emailParts.push('50/50 tickets');
      if (hasEvent && eventEmailSent) emailParts.push('event tickets');
      if (emailParts.length > 0) {
        emailNote.textContent = emailParts.join(' and ') + ' emailed to ' + buyerEmail;
      } else {
        emailNote.textContent = 'Email could not be sent - please note these numbers';
      }

      ticketsDiv.style.display = 'block';
    } else {
      ticketsDiv.style.display = 'none';
    }

    openModal('successOverlay');
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
      const raffle = data.raffle || { sold: 0, total: '0.00' };
      const eventTickets = data.eventTickets || { sold: 0, total: '0.00' };

      const refunds = data.refunds || { count: 0, total: '0.00' };
      const expenses = data.expenses || { count: 0, total: '0.00', byCategory: {} };
      const hasRefunds = refunds.count > 0;
      const hasExpenses = expenses.count > 0;
      const hasDeductions = hasRefunds || hasExpenses;

      const gofundme = data.gofundme || { total: '0.00' };
      const logged = data.logged || { count: 0, total: '0.00' };

      document.getElementById('reportContent').innerHTML = `
        <div class="report-hero">
          <div class="report-total-label">Total Raised</div>
          <div class="report-total-amount">$${data.grandTotal}</div>
          <div class="report-total-count">Sales: $${data.netRevenue} + GoFundMe: $${gofundme.total} + 50/50 Jackpot: $${(parseFloat(tickets5050.total || 0) / 2).toFixed(2)}</div>
          ${hasDeductions ? `
            <div class="report-refund-summary">
              ${hasRefunds ? `<span class="refund-line">- $${refunds.total} refunded (${refunds.count})</span>` : ''}
              ${hasExpenses ? `<span class="refund-line">- $${expenses.total} expenses (${expenses.count})</span>` : ''}
            </div>
          ` : ''}
        </div>

        <div class="report-breakdown">
          <div class="report-card report-card-clickable" id="totalSalesCard"
               data-cash-count="${data.cash.count}" data-cash-total="${data.cash.total}"
               data-card-count="${data.card.count}" data-card-total="${data.card.total}"
               data-logged-count="${logged.count}" data-logged-total="${logged.total}"
>
            <div class="report-card-icon sales-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Total Sales</span>
              <span class="report-card-count">${data.totalSales} sale${data.totalSales !== 1 ? 's' : ''} &rsaquo;</span>
            </div>
            <span class="report-card-amount">$${data.totalRevenue}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon raffle-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 4v16"/><path d="M16 4v16"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Raffle Tickets</span>
              <span class="report-card-count">${raffle.sold} sold</span>
            </div>
            <span class="report-card-amount">$${raffle.total}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon event-ticket-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M7 6v12"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Event Tickets</span>
              <span class="report-card-count">${eventTickets.sold} sold</span>
            </div>
            <span class="report-card-amount">$${eventTickets.total}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon ticket-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 10h20"/><circle cx="12" cy="15" r="1"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">50/50 Tickets</span>
              <span class="report-card-count">${tickets5050.sold} sold / ${tickets5050.available} remaining</span>
            </div>
            <span class="report-card-amount">$${tickets5050.total || '0.00'}</span>
          </div>
          <div class="report-card">
            <div class="report-card-icon gfm-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">GoFundMe</span>
              <span class="report-card-count">External campaign</span>
            </div>
            <span class="report-card-amount">$${gofundme.total}</span>
          </div>
          ${hasExpenses ? `
          <div class="report-card">
            <div class="report-card-icon expense-icon">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M2 12h20"/><line x1="4" y1="4" x2="20" y2="20"/></svg>
            </div>
            <div class="report-card-info">
              <span class="report-card-label">Expenses</span>
              <span class="report-card-count">${Object.entries(expenses.byCategory).map(([cat, amt]) => cat + ': $' + amt.toFixed(2)).join(' / ')}</span>
            </div>
            <span class="report-card-amount expense-amount">-$${expenses.total}</span>
          </div>
          ` : ''}
        </div>

        <div class="gfm-editor">
          <h3>Update GoFundMe Total</h3>
          <div class="gfm-edit-row">
            <span class="gfm-dollar">$</span>
            <input type="number" id="gfmInput" class="form-input" step="0.01" min="0" value="${gofundme.total}" inputmode="decimal">
            <button onclick="window._saveGfm()" class="btn btn-primary gfm-save-btn">Save</button>
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

      // Attach click handler for Total Sales breakdown
      const totalSalesCard = document.getElementById('totalSalesCard');
      if (totalSalesCard) {
        totalSalesCard.addEventListener('click', () => {
          const cashCount = totalSalesCard.dataset.cashCount;
          const cashTotal = totalSalesCard.dataset.cashTotal;
          const cardCount = totalSalesCard.dataset.cardCount;
          const cardTotal = totalSalesCard.dataset.cardTotal;
          const loggedCount = totalSalesCard.dataset.loggedCount;
          const loggedTotal = totalSalesCard.dataset.loggedTotal;

          document.getElementById('breakdownContent').innerHTML = `
            <div class="breakdown-row">
              <div class="breakdown-icon logged-icon">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <span class="breakdown-label">Logged</span>
              <span class="breakdown-count">${loggedCount} sale${loggedCount !== '1' ? 's' : ''}</span>
              <span class="breakdown-amount">$${loggedTotal}</span>
            </div>
            <div class="breakdown-row">
              <div class="breakdown-icon cash-icon">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 10h20"/></svg>
              </div>
              <span class="breakdown-label">Cash</span>
              <span class="breakdown-count">${cashCount} sale${cashCount !== '1' ? 's' : ''}</span>
              <span class="breakdown-amount">$${cashTotal}</span>
            </div>
            <div class="breakdown-row">
              <div class="breakdown-icon card-icon">
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></svg>
              </div>
              <span class="breakdown-label">Card</span>
              <span class="breakdown-count">${cardCount} sale${cardCount !== '1' ? 's' : ''}</span>
              <span class="breakdown-amount">$${cardTotal}</span>
            </div>
          `;
          openModal('salesBreakdownModal');
        });
      }
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

  // Consolidated polling - inventory + jackpot, paused when page hidden
  setInterval(() => {
    if (document.hidden) return;
    const historyVisible = !document.getElementById('historyScreen').classList.contains('hidden');
    const reportVisible = !document.getElementById('reportScreen').classList.contains('hidden');
    const inventoryVisible = !document.getElementById('inventoryScreen').classList.contains('hidden');
    const drawVisible = !document.getElementById('drawScreen').classList.contains('hidden');
    if (!historyVisible && !reportVisible && !inventoryVisible && !drawVisible) {
      refreshInventory();
    }
    refreshJackpot();
  }, 15000);

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

  // --- GoFundMe main screen refresh ---
  async function refreshGoFundMe() {
    try {
      const res = await authGet('/api/gofundme');
      const data = await res.json();
      const el = document.getElementById('gfmMainAmount');
      if (el) el.textContent = '$' + parseFloat(data.total || 0).toFixed(2);
    } catch (e) { /* silent */ }
  }

  // Refresh jackpot on load (ongoing refresh handled by consolidated poll above)
  refreshJackpot();
  refreshGoFundMe();

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

  async function reallocateTickets(from, to) {
    const status = document.getElementById('reallocate-status');
    status.textContent = '';
    const ok = await showConfirm('Reallocate Tickets', `Move ALL remaining ${from} tickets to ${to}?`, 'Move');
    if (!ok) return;
    try {
      const res = await authPost('/api/inventory/reallocate', { from, to });
      const data = await res.json();
      if (data.error) {
        status.style.color = 'var(--danger)';
        status.textContent = data.error;
      } else {
        status.style.color = 'var(--success)';
        status.textContent = `Moved ${data.moved} tickets: ${from} → ${to}`;
        // Refresh the editor inputs
        document.getElementById('invEarlyBird').value = data.inventory['Early Bird Ticket'] ?? 0;
        document.getElementById('invGA').value = data.inventory['GA Ticket'] ?? 0;
        document.getElementById('invDoor').value = data.inventory['Door Ticket'] ?? 0;
        refreshInventory();
      }
    } catch (err) {
      status.style.color = 'var(--danger)';
      status.textContent = 'Error: ' + err.message;
    }
  }

  // --- GoFundMe save ---
  window._saveGfm = async function() {
    const input = document.getElementById('gfmInput');
    const val = parseFloat(input.value);
    if (isNaN(val) || val < 0) { showToast('Enter a valid amount'); return; }
    try {
      const res = await authPost('/api/gofundme', { total: val });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast('GoFundMe total updated', 'success');
      refreshGoFundMe();
      loadReport();
    } catch (err) {
      showToast('Error: ' + err.message);
    }
  };

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
