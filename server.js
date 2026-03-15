require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { SquareClient, SquareEnvironment } = require('square');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public', { dotfiles: 'allow' }));

// Square client setup
const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox,
});

const locationId = process.env.SQUARE_LOCATION_ID;

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

// Expose config to frontend
app.get('/api/config', (req, res) => {
  res.json({
    applicationId: process.env.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
  });
});

// Create a payment using Square
app.post('/api/create-payment', async (req, res) => {
  try {
    const { sourceId, amount, description, method } = req.body;
    const amountCents = Math.round(amount * 100);

    if (amountCents < 100) {
      return res.status(400).json({ error: 'Amount must be at least $1.00' });
    }

    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const response = await squareClient.payments.create({
      sourceId,
      idempotencyKey,
      amountMoney: {
        amount: BigInt(amountCents),
        currency: 'CAD',
      },
      locationId,
      note: description || 'POS Sale',
    });

    const payment = response.payment;

    // Record in local log
    saveTransaction({
      id: payment.id,
      amount: (Number(payment.amountMoney.amount) / 100).toFixed(2),
      description: description || 'Sale',
      method: method || 'card',
      status: payment.status.toLowerCase(),
      created: new Date().toISOString(),
    });

    res.json({
      paymentId: payment.id,
      status: payment.status,
    });
  } catch (err) {
    console.error('Error creating payment:', err);
    const message = err.errors ? err.errors.map(e => e.detail).join(', ') : err.message;
    res.status(500).json({ error: message });
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
      status: 'completed',
      created: new Date().toISOString(),
    });
    res.json({ status: 'succeeded' });
  } catch (err) {
    console.error('Error recording cash payment:', err.message);
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
    const succeeded = txns.filter((t) => t.status === 'succeeded' || t.status === 'completed');

    const totalSales = succeeded.length;
    const totalRevenue = succeeded.reduce((sum, t) => sum + parseFloat(t.amount), 0);

    const cashTxns = succeeded.filter((t) => t.method === 'cash');
    const cardTxns = succeeded.filter((t) => t.method === 'card');
    const cashTotal = cashTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const cardTotal = cardTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);

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
      const key = t.description;
      if (!byProduct[key]) byProduct[key] = { count: 0, revenue: 0 };
      byProduct[key].revenue += parseFloat(t.amount);
    }

    res.json({
      totalSales,
      totalRevenue: totalRevenue.toFixed(2),
      cash: { count: cashTxns.length, total: cashTotal.toFixed(2) },
      card: { count: cardTxns.length, total: cardTotal.toFixed(2) },
      transactions: succeeded,
    });
  } catch (err) {
    console.error('Error generating report:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Refund a payment
app.post('/api/refund', async (req, res) => {
  try {
    const { paymentId, amount } = req.body;
    const idempotencyKey = `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const refundRequest = {
      paymentId,
      idempotencyKey,
      reason: 'Requested by seller',
    };

    // If amount provided, do partial refund
    if (amount) {
      refundRequest.amountMoney = {
        amount: BigInt(Math.round(amount * 100)),
        currency: 'CAD',
      };
    }

    const response = await squareClient.refunds.refundPayment(refundRequest);
    res.json({ status: response.refund.status });
  } catch (err) {
    console.error('Error creating refund:', err);
    const message = err.errors ? err.errors.map(e => e.detail).join(', ') : err.message;
    res.status(500).json({ error: message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`POS server running on http://localhost:${PORT}`);
  console.log(`Access from iPhone: http://<your-local-ip>:${PORT}`);
});
