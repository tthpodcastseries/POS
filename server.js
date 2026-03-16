require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');

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

// Supabase client setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// --- Transactions (Supabase) ---

async function loadTransactions() {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('created', { ascending: false });
  if (error) {
    console.error('Error loading transactions:', error.message);
    return [];
  }
  return data;
}

async function saveTransaction(tx) {
  const { error } = await supabase.from('transactions').insert(tx);
  if (error) console.error('Error saving transaction:', error.message);
}

// --- Inventory (Supabase) ---

const DEFAULT_INVENTORY = {
  'Early Bird Ticket': 20,
  'GA Ticket': 65,
  'Door Ticket': 15,
};

async function loadInventory() {
  const { data, error } = await supabase
    .from('inventory')
    .select('*');
  if (error) {
    console.error('Error loading inventory:', error.message);
    return { ...DEFAULT_INVENTORY };
  }
  if (!data || data.length === 0) {
    // First run - seed defaults
    const rows = Object.entries(DEFAULT_INVENTORY).map(([name, remaining]) => ({
      name,
      remaining,
    }));
    await supabase.from('inventory').insert(rows);
    return { ...DEFAULT_INVENTORY };
  }
  const inv = {};
  for (const row of data) {
    inv[row.name] = row.remaining;
  }
  return inv;
}

async function saveInventoryItem(name, remaining) {
  const { error } = await supabase
    .from('inventory')
    .update({ remaining })
    .eq('name', name);
  if (error) console.error('Error saving inventory:', error.message);
}

// Check if inventory is available for cart items
async function checkInventory(description) {
  const inv = await loadInventory();
  const items = description.split(', ');
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
      // Map "Door Tickets" alias to "Door Ticket"
      const key = name === 'Door Tickets' ? 'Door Ticket' : name;
      if (key in inv) {
        if (qty > inv[key]) {
          return { ok: false, error: `Only ${inv[key]} ${key} remaining` };
        }
      }
    }
  }
  return { ok: true };
}

// Decrement inventory after successful payment
async function decrementInventory(description) {
  const inv = await loadInventory();
  const items = description.split(', ');
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
      const key = name === 'Door Tickets' ? 'Door Ticket' : name;
      if (key in inv) {
        const newCount = Math.max(0, inv[key] - qty);
        await saveInventoryItem(key, newCount);
      }
    }
  }
}

// Get current inventory
app.get('/api/inventory', async (req, res) => {
  try {
    const inv = await loadInventory();
    res.json(inv);
  } catch (err) {
    console.error('Error fetching inventory:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

    // Check inventory before charging
    const invCheck = await checkInventory(description);
    if (!invCheck.ok) {
      return res.status(400).json({ error: invCheck.error });
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

    // Record in Supabase
    await saveTransaction({
      tx_id: payment.id,
      amount: (Number(payment.amountMoney.amount) / 100).toFixed(2),
      description: description || 'Sale',
      method: method || 'card',
      status: payment.status.toLowerCase(),
      created: new Date().toISOString(),
    });

    // Decrement inventory after successful charge
    await decrementInventory(description);

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
app.post('/api/cash-payment', async (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount || amount < 0.01) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Check inventory before recording
    const invCheck = await checkInventory(description);
    if (!invCheck.ok) {
      return res.status(400).json({ error: invCheck.error });
    }

    // Decrement inventory
    await decrementInventory(description);

    await saveTransaction({
      tx_id: 'cash_' + Date.now(),
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

// Get all transactions
app.get('/api/transactions', async (req, res) => {
  try {
    const txns = await loadTransactions();
    res.json(txns);
  } catch (err) {
    console.error('Error fetching transactions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get sales report summary
app.get('/api/report', async (req, res) => {
  try {
    const txns = await loadTransactions();
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
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'NOT configured'}`);
});
