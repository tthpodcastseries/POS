require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public', { dotfiles: 'allow' }));

// Simple API key auth for write endpoints
const API_KEY = process.env.POS_API_KEY;
function requireAuth(req, res, next) {
  if (!API_KEY) return next(); // skip if not configured
  if (req.headers['x-pos-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

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

// Resend email setup
const resend = new Resend(process.env.RESEND_API_KEY);

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

async function checkInventory(description) {
  const inv = await loadInventory();
  const items = description.split(', ');
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
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

// Update inventory counts
app.post('/api/inventory/update', requireAuth, async (req, res) => {
  try {
    const { items } = req.body; // [{ name, remaining }]
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    for (const item of items) {
      if (item.name && typeof item.remaining === 'number' && item.remaining >= 0) {
        await saveInventoryItem(item.name, item.remaining);
      }
    }
    const inv = await loadInventory();
    res.json(inv);
  } catch (err) {
    console.error('Error updating inventory:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 50/50 Ticket Assignment ---

// Count how many 50/50 tickets are in a description
function count5050Tickets(description) {
  let total = 0;
  const items = description.split(', ');
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
      if (name === '50/50 Tickets') {
        total += qty;
      }
    }
  }
  return total;
}

// Randomly assign available ticket numbers (race-safe)
async function assignTickets(qty, email, txId, buyerInfo = {}) {
  const assigned = [];
  let attempts = 0;
  const maxAttempts = qty + 10; // safety valve

  while (assigned.length < qty && attempts < maxAttempts) {
    attempts++;

    // Grab a batch of available tickets
    const { data: available, error } = await supabase
      .from('tickets_5050')
      .select('id, ticket_number')
      .eq('status', 'available')
      .limit(Math.max(50, (qty - assigned.length) * 3));

    if (error) {
      console.error('Error fetching available tickets:', error.message);
      return { ok: false, error: 'Could not fetch ticket pool' };
    }

    if (!available || available.length === 0) {
      break; // no more tickets
    }

    // Shuffle and pick what we still need
    const needed = qty - assigned.length;
    const shuffled = available.sort(() => Math.random() - 0.5);
    const candidates = shuffled.slice(0, needed);

    // Try to claim each one atomically - only update if still available
    for (const ticket of candidates) {
      if (assigned.length >= qty) break;

      const { data: updated, error: updateError } = await supabase
        .from('tickets_5050')
        .update({
          status: 'sold',
          buyer_email: email,
          buyer_name: buyerInfo.name || null,
          buyer_phone: buyerInfo.phone || null,
          newsletter_opt_in: buyerInfo.newsletterOptIn || false,
          sold_at: new Date().toISOString(),
          transaction_id: txId,
        })
        .eq('id', ticket.id)
        .eq('status', 'available') // only claim if still available
        .select('ticket_number');

      if (!updateError && updated && updated.length > 0) {
        assigned.push(updated[0].ticket_number);
      }
      // If update matched 0 rows, another device grabbed it first - just skip
    }
  }

  if (assigned.length < qty) {
    // Couldn't get enough - release what we did grab
    if (assigned.length > 0) {
      await supabase
        .from('tickets_5050')
        .update({ status: 'available', buyer_email: null, buyer_name: null, buyer_phone: null, newsletter_opt_in: false, sold_at: null, transaction_id: null })
        .eq('transaction_id', txId);
    }
    return { ok: false, error: `Only ${assigned.length} 50/50 tickets available, needed ${qty}` };
  }

  return { ok: true, ticketNumbers: assigned };
}

// Send ticket email
async function sendTicketEmail(email, ticketNumbers, amount, buyerName) {
  const ticketList = ticketNumbers.map(n => `<li style="font-size:18px;padding:4px 0;"><strong>${n}</strong></li>`).join('');

  try {
    const { data, error } = await resend.emails.send({
      from: 'TTH Podcast Series <onboarding@resend.dev>',
      replyTo: 'tthpodcastseries@gmail.com',
      to: email,
      subject: 'Your 50/50 Draw Ticket Numbers - An Evening for Sara J',
      html: `
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#140038;color:#d9d9d9;border-radius:12px;overflow:hidden;">
          <div style="padding:30px 24px;text-align:center;">
            <h1 style="color:#ffffff;margin:0 0 8px;">Your 50/50 Tickets</h1>
            <p style="color:#929292;margin:0;">An Evening for Sara J</p>
          </div>
          <div style="background:#1a0045;padding:24px;margin:0 16px;border-radius:8px;">
            <p style="margin:0 0 12px;color:#d9d9d9;">Hey${buyerName ? ' ' + buyerName : ''}! Here are your 50/50 draw ticket numbers:</p>
            <ul style="list-style:none;padding:0;margin:16px 0;text-align:center;color:#22c55e;">
              ${ticketList}
            </ul>
            <p style="margin:16px 0 0;color:#929292;font-size:14px;">
              ${ticketNumbers.length} ticket${ticketNumbers.length > 1 ? 's' : ''} - $${parseFloat(amount).toFixed(2)} CAD
            </p>
          </div>
          <div style="padding:20px 24px;text-align:center;">
            <p style="color:#929292;font-size:13px;margin:0;">
              Hold onto this email - you'll need your ticket numbers for the draw!<br>
              Good luck and thanks for supporting the cause.
            </p>
            <p style="color:#646464;font-size:11px;margin:16px 0 0;">TTH Podcast Series</p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Error sending ticket email:', error);
      return false;
    }
    console.log('Ticket email sent to', email, '- tickets:', ticketNumbers.join(', '));
    return true;
  } catch (err) {
    console.error('Error sending ticket email:', err.message);
    return false;
  }
}

// After a successful payment, handle 50/50 ticket assignment + email
async function handle5050IfNeeded(description, email, amount, txId, buyerInfo = {}) {
  const ticketCount = count5050Tickets(description);
  if (ticketCount === 0 || !email) return { assigned: false };

  const result = await assignTickets(ticketCount, email, txId, buyerInfo);
  if (!result.ok) {
    console.error('Ticket assignment failed:', result.error);
    return { assigned: false, error: result.error };
  }

  const emailSent = await sendTicketEmail(email, result.ticketNumbers, amount, buyerInfo.name);
  return {
    assigned: true,
    ticketNumbers: result.ticketNumbers,
    emailSent,
  };
}

// --- API: Get available 50/50 ticket count ---
app.get('/api/tickets-5050/available', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('tickets_5050')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'available');
    if (error) throw error;
    res.json({ available: count || 0 });
  } catch (err) {
    console.error('Error counting 50/50 tickets:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- API: Get 50/50 jackpot (sold count * $5 / 2) ---
app.get('/api/tickets-5050/jackpot', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('tickets_5050')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sold');
    if (error) throw error;
    const soldCount = count || 0;
    const totalSales = soldCount * 5;
    const jackpot = totalSales / 2;
    res.json({ soldCount, totalSales, jackpot });
  } catch (err) {
    console.error('Error calculating jackpot:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    apiKey: process.env.POS_API_KEY || '',
  });
});

// Create a payment using Square
app.post('/api/create-payment', requireAuth, async (req, res) => {
  try {
    const { sourceId, amount, description, method, email, buyerName, buyerPhone, newsletterOptIn } = req.body;
    const amountCents = Math.round(amount * 100);

    if (amountCents < 100) {
      return res.status(400).json({ error: 'Amount must be at least $1.00' });
    }

    // Check 50/50 ticket availability
    const ticketCount = count5050Tickets(description);
    if (ticketCount > 0) {
      if (!email) {
        return res.status(400).json({ error: 'Email required for 50/50 tickets' });
      }
      const { count } = await supabase
        .from('tickets_5050')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'available');
      if ((count ?? 0) < ticketCount) {
        return res.status(400).json({ error: `Only ${count ?? 0} 50/50 tickets remaining` });
      }
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
    const txId = payment.id;

    // Record in Supabase
    await saveTransaction({
      tx_id: txId,
      amount: (Number(payment.amountMoney.amount) / 100).toFixed(2),
      description: description || 'Sale',
      method: method || 'card',
      status: payment.status.toLowerCase(),
      created: new Date().toISOString(),
    });

    // Decrement inventory after successful charge
    await decrementInventory(description);

    // Handle 50/50 ticket assignment + email
    const ticketResult = await handle5050IfNeeded(description, email, amount, txId, { name: buyerName, phone: buyerPhone, newsletterOptIn });

    res.json({
      paymentId: txId,
      status: payment.status,
      ticketNumbers: ticketResult.ticketNumbers || null,
      emailSent: ticketResult.emailSent || false,
    });
  } catch (err) {
    console.error('Error creating payment:', err);
    const message = err.errors ? err.errors.map(e => e.detail).join(', ') : err.message;
    res.status(500).json({ error: message });
  }
});

// Record a cash payment
app.post('/api/cash-payment', requireAuth, async (req, res) => {
  try {
    const { amount, description, email, buyerName, buyerPhone, newsletterOptIn } = req.body;
    if (!amount || amount < 0.01) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Check 50/50 ticket availability
    const ticketCount = count5050Tickets(description);
    if (ticketCount > 0) {
      if (!email) {
        return res.status(400).json({ error: 'Email required for 50/50 tickets' });
      }
      const { count } = await supabase
        .from('tickets_5050')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'available');
      if ((count ?? 0) < ticketCount) {
        return res.status(400).json({ error: `Only ${count ?? 0} 50/50 tickets remaining` });
      }
    }

    // Check inventory before recording
    const invCheck = await checkInventory(description);
    if (!invCheck.ok) {
      return res.status(400).json({ error: invCheck.error });
    }

    // Decrement inventory
    await decrementInventory(description);

    const txId = 'cash_' + Date.now() + '-' + Math.random().toString(36).slice(2);

    await saveTransaction({
      tx_id: txId,
      amount: parseFloat(amount).toFixed(2),
      description: description || 'Cash Sale',
      method: 'cash',
      status: 'completed',
      created: new Date().toISOString(),
    });

    // Handle 50/50 ticket assignment + email
    const ticketResult = await handle5050IfNeeded(description, email, amount, txId, { name: buyerName, phone: buyerPhone, newsletterOptIn });

    res.json({
      status: 'succeeded',
      ticketNumbers: ticketResult.ticketNumbers || null,
      emailSent: ticketResult.emailSent || false,
    });
  } catch (err) {
    console.error('Error recording cash payment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Transactions & Reporting ---

app.get('/api/transactions', async (req, res) => {
  try {
    const txns = await loadTransactions();
    res.json(txns);
  } catch (err) {
    console.error('Error fetching transactions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/report', async (req, res) => {
  try {
    const txns = await loadTransactions();
    const succeeded = txns.filter((t) => t.status === 'succeeded' || t.status === 'completed');
    const refunded = txns.filter((t) => t.status === 'refunded');

    const totalSales = succeeded.length;
    const totalRevenue = succeeded.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const refundedTotal = refunded.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const netRevenue = totalRevenue - refundedTotal;

    const cashTxns = succeeded.filter((t) => t.method === 'cash');
    const cardTxns = succeeded.filter((t) => t.method === 'card');
    const cashTotal = cashTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const cardTotal = cardTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);

    // Get 50/50 ticket stats
    const { count: ticketsSold } = await supabase
      .from('tickets_5050')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sold');
    const { count: ticketsAvailable } = await supabase
      .from('tickets_5050')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'available');

    // Include all non-failed transactions (succeeded + completed + refunded) for display
    const allDisplayable = txns.filter((t) =>
      t.status === 'succeeded' || t.status === 'completed' || t.status === 'refunded'
    );

    res.json({
      totalSales,
      totalRevenue: totalRevenue.toFixed(2),
      netRevenue: netRevenue.toFixed(2),
      refunds: { count: refunded.length, total: refundedTotal.toFixed(2) },
      cash: { count: cashTxns.length, total: cashTotal.toFixed(2) },
      card: { count: cardTxns.length, total: cardTotal.toFixed(2) },
      tickets5050: { sold: ticketsSold || 0, available: ticketsAvailable || 0 },
      transactions: allDisplayable,
    });
  } catch (err) {
    console.error('Error generating report:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Restore inventory from a transaction description
async function restoreInventory(description) {
  const inv = await loadInventory();
  const items = description.split(', ');
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
      const key = name === 'Door Tickets' ? 'Door Ticket' : name;
      if (key in inv) {
        await saveInventoryItem(key, inv[key] + qty);
      }
    }
  }
}

// Refund a payment
app.post('/api/refund', requireAuth, async (req, res) => {
  try {
    const { paymentId, amount } = req.body;

    // Look up the transaction in Supabase
    const { data: txData } = await supabase
      .from('transactions')
      .select('*')
      .eq('tx_id', paymentId)
      .single();

    // Prevent double refund
    if (txData && txData.status === 'refunded') {
      return res.status(400).json({ error: 'This transaction has already been refunded' });
    }

    // For card payments, process refund through Square
    if (!paymentId.startsWith('cash_')) {
      const idempotencyKey = `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const refundRequest = {
        paymentId,
        idempotencyKey,
        reason: 'Requested by seller',
      };

      if (amount) {
        refundRequest.amountMoney = {
          amount: BigInt(Math.round(amount * 100)),
          currency: 'CAD',
        };
      }

      await squareClient.refunds.refundPayment(refundRequest);
    }

    // Update transaction status in Supabase
    const { error: updateError } = await supabase
      .from('transactions')
      .update({ status: 'refunded' })
      .eq('tx_id', paymentId);
    if (updateError) console.error('Error updating transaction status:', updateError.message);

    // Restore inventory counts
    if (txData && txData.description) {
      await restoreInventory(txData.description);
    }

    // Release 50/50 tickets back to available
    const { error: ticketError } = await supabase
      .from('tickets_5050')
      .update({ status: 'available', buyer_email: null, buyer_name: null, buyer_phone: null, newsletter_opt_in: false, sold_at: null, transaction_id: null })
      .eq('transaction_id', paymentId);
    if (ticketError) console.error('Error releasing 50/50 tickets:', ticketError.message);

    res.json({ status: 'refunded' });
  } catch (err) {
    console.error('Error creating refund:', err);
    const message = err.errors ? err.errors.map(e => e.detail).join(', ') : err.message;
    res.status(500).json({ error: message });
  }
});

// --- 50/50 Draw ---
app.post('/api/draw-5050', requireAuth, async (req, res) => {
  try {
    // Get all sold tickets
    const { data: soldTickets, error } = await supabase
      .from('tickets_5050')
      .select('ticket_number, buyer_email, buyer_name, buyer_phone')
      .eq('status', 'sold');

    if (error) throw error;

    if (!soldTickets || soldTickets.length === 0) {
      return res.status(400).json({ error: 'No sold tickets to draw from' });
    }

    // Pick one at random
    const winner = soldTickets[Math.floor(Math.random() * soldTickets.length)];

    res.json({
      ticketNumber: winner.ticket_number,
      email: winner.buyer_email,
      name: winner.buyer_name,
      phone: winner.buyer_phone,
      totalSold: soldTickets.length,
    });
  } catch (err) {
    console.error('Error running 50/50 draw:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`POS server running on http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'NOT configured'}`);
  console.log(`Resend: ${process.env.RESEND_API_KEY ? 'configured' : 'NOT configured'}`);
});
