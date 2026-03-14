require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public', { dotfiles: 'allow' }));

// --- Local transaction log (persists cash + card sales) ---
const TX_FILE = path.join(__dirname, 'transactions.json');

function loadTransactions() {
  try {
    if (fs.existsSync(TX_FILE)) {
      return JSON.parse(fs.readFileSync(TX_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading transactions file:', e.message);
  }
  return [];
}

function saveTransaction(tx) {
  const txns = loadTransactions();
  txns.unshift(tx);
  fs.writeFileSync(TX_FILE, JSON.stringify(txns, null, 2));
}

// Expose publishable key to frontend
app.get('/api/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// Create a PaymentIntent (used for both manual and terminal payments)
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, description } = req.body;
    const amountCents = Math.round(amount * 100);

    if (amountCents < 50) {
      return res.status(400).json({ error: 'Amount must be at least $0.50' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'cad',
      description: description || 'POS Sale',
      payment_method_types: ['card'],
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error('Error creating PaymentIntent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Record a successful card payment in local log
app.post('/api/record-card-payment', (req, res) => {
  try {
    const { amount, description, method, paymentIntentId } = req.body;
    saveTransaction({
      id: paymentIntentId || 'card_' + Date.now(),
      amount: parseFloat(amount).toFixed(2),
      description: description || 'Sale',
      method: method || 'card',
      status: 'succeeded',
      created: new Date().toISOString(),
    });
    res.json({ status: 'recorded' });
  } catch (err) {
    console.error('Error recording payment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Record a cash payment
app.post('/api/cash-payment', (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount || amount < 0.01) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    saveTransaction({
      id: 'cash_' + Date.now(),
      amount: parseFloat(amount).toFixed(2),
      description: description || 'Cash Sale',
      method: 'cash',
      status: 'succeeded',
      created: new Date().toISOString(),
    });
    res.json({ status: 'succeeded' });
  } catch (err) {
    console.error('Error recording cash payment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Stripe Terminal endpoints ---

app.post('/api/terminal/connection-token', async (req, res) => {
  try {
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ secret: connectionToken.secret });
  } catch (err) {
    console.error('Error creating connection token:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/terminal/capture', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const captured = await stripe.paymentIntents.capture(paymentIntentId);
    res.json({ status: captured.status });
  } catch (err) {
    console.error('Error capturing payment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Transactions & Reporting ---

// Get all local transactions
app.get('/api/transactions', (req, res) => {
  try {
    const txns = loadTransactions();
    res.json(txns);
  } catch (err) {
    console.error('Error fetching transactions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get sales report summary
app.get('/api/report', (req, res) => {
  try {
    const txns = loadTransactions();
    const succeeded = txns.filter((t) => t.status === 'succeeded');

    const totalSales = succeeded.length;
    const totalRevenue = succeeded.reduce((sum, t) => sum + parseFloat(t.amount), 0);

    const cashTxns = succeeded.filter((t) => t.method === 'cash');
    const cardTxns = succeeded.filter((t) => t.method === 'card');
    const applePayTxns = succeeded.filter((t) => t.method === 'applepay');

    const cashTotal = cashTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const cardTotal = cardTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const applePayTotal = applePayTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);

    // Group by product description
    const byProduct = {};
    for (const t of succeeded) {
      const items = t.description.split(', ');
      for (const item of items) {
        const match = item.match(/^(.+?)\s*\((\d+)\)$/);
        if (match) {
          const name = match[1].trim();
          const qty = parseInt(match[2]);
          if (!byProduct[name]) byProduct[name] = { count: 0, revenue: 0 };
          byProduct[name].count += qty;
        } else {
          if (!byProduct[item]) byProduct[item] = { count: 0, revenue: 0 };
          byProduct[item].count += 1;
        }
      }
      // Distribute revenue to the whole transaction
      const key = t.description;
      if (!byProduct[key]) byProduct[key] = { count: 0, revenue: 0 };
      byProduct[key].revenue += parseFloat(t.amount);
    }

    res.json({
      totalSales,
      totalRevenue: totalRevenue.toFixed(2),
      cash: { count: cashTxns.length, total: cashTotal.toFixed(2) },
      card: { count: cardTxns.length, total: cardTotal.toFixed(2) },
      applepay: { count: applePayTxns.length, total: applePayTotal.toFixed(2) },
      transactions: succeeded,
    });
  } catch (err) {
    console.error('Error generating report:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Refund a charge
app.post('/api/refund', async (req, res) => {
  try {
    const { chargeId } = req.body;
    const refund = await stripe.refunds.create({ charge: chargeId });
    res.json({ status: refund.status });
  } catch (err) {
    console.error('Error creating refund:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`POS server running on http://localhost:${PORT}`);
  console.log(`Access from iPhone: http://<your-local-ip>:${PORT}`);
});
