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

// API key auth for write endpoints
const API_KEY = process.env.POS_API_KEY;
function requireAuth(req, res, next) {
  if (!API_KEY) {
    console.warn('WARNING: POS_API_KEY not set - rejecting request for safety');
    return res.status(500).json({ error: 'Server misconfigured - API key not set' });
  }
  if (req.headers['x-pos-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Admin password auth (for draw screen, reports with PII, reset)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '7132';
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-pw'] || req.query.pw;
  if (pw === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Admin password required' });
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

// Resend email setup (HTTP-based, works on Render)
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
      console.error('Resend error:', error);
      return false;
    }
    console.log('Ticket email sent to', email, '- tickets:', ticketNumbers.join(', '), '- id:', data?.id);
    return true;
  } catch (err) {
    console.error('Error sending ticket email:', err.message);
    return false;
  }
}

// Send winner notification email
async function sendWinnerEmail(email, name, ticketNumber, jackpotAmount) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'TTH Podcast Series <onboarding@resend.dev>',
      to: email,
      subject: 'You Won the 50/50 Draw! - An Evening for Sara J',
      html: `
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#140038;color:#d9d9d9;border-radius:12px;overflow:hidden;">
          <div style="padding:30px 24px;text-align:center;">
            <h1 style="color:#22c55e;margin:0 0 8px;font-size:28px;">You're a Winner!</h1>
            <p style="color:#929292;margin:0;">An Evening for Sara J - 50/50 Draw</p>
          </div>
          <div style="background:#1a0045;padding:24px;margin:0 16px;border-radius:8px;text-align:center;">
            <p style="margin:0 0 16px;color:#d9d9d9;font-size:16px;">Hey${name ? ' ' + name : ''}! Congratulations!</p>
            <p style="margin:0 0 8px;color:#929292;font-size:14px;">Your winning ticket number:</p>
            <p style="margin:0 0 20px;color:#22c55e;font-size:32px;font-weight:bold;">${ticketNumber}</p>
            <p style="margin:0 0 8px;color:#929292;font-size:14px;">Your prize:</p>
            <p style="margin:0;color:#ffffff;font-size:36px;font-weight:bold;">$${jackpotAmount} CAD</p>
          </div>
          <div style="padding:20px 24px;text-align:center;">
            <p style="color:#929292;font-size:13px;margin:0;">
              Please see the event organizers to claim your prize.<br>
              Thanks for supporting the cause - and congrats again!
            </p>
            <p style="color:#646464;font-size:11px;margin:16px 0 0;">TTH Podcast Series</p>
          </div>
        </div>
      `,
    });
    if (error) {
      console.error('Resend winner email error:', error);
      return false;
    }
    console.log('Winner email sent to', email, '- ticket:', ticketNumber, '- id:', data?.id);
    return true;
  } catch (err) {
    console.error('Error sending winner email:', err.message);
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

  // Fire-and-forget email - don't block payment response
  sendTicketEmail(email, result.ticketNumbers, amount, buyerInfo.name).catch(err => {
    console.error('Background email send failed:', err.message);
  });

  return {
    assigned: true,
    ticketNumbers: result.ticketNumbers,
    emailSent: true, // optimistic - email is queued
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

// --- API: Get 50/50 jackpot (50% of actual 50/50 revenue) ---
app.get('/api/tickets-5050/jackpot', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('tickets_5050')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sold');
    if (error) throw error;
    const soldCount = count || 0;
    const totalSales = fiftyFiftyRevenue;
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
    const { sourceId, amount, description, method, email, buyerName, buyerPhone, newsletterOptIn, fiftyFiftyAmount } = req.body;
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
      if (!buyerName || !buyerName.trim()) {
        return res.status(400).json({ error: 'Name required for 50/50 tickets' });
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

    // Track 50/50 revenue for jackpot calculation
    if (fiftyFiftyAmount && fiftyFiftyAmount > 0) {
      fiftyFiftyRevenue += parseFloat(fiftyFiftyAmount);
    }

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
    const { amount, description, email, buyerName, buyerPhone, newsletterOptIn, fiftyFiftyAmount } = req.body;
    if (!amount || amount < 0.01) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Check 50/50 ticket availability
    const ticketCount = count5050Tickets(description);
    if (ticketCount > 0) {
      if (!email) {
        return res.status(400).json({ error: 'Email required for 50/50 tickets' });
      }
      if (!buyerName || !buyerName.trim()) {
        return res.status(400).json({ error: 'Name required for 50/50 tickets' });
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

    // Track 50/50 revenue for jackpot calculation
    if (fiftyFiftyAmount && fiftyFiftyAmount > 0) {
      fiftyFiftyRevenue += parseFloat(fiftyFiftyAmount);
    }

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

app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const txns = await loadTransactions();
    res.json(txns);
  } catch (err) {
    console.error('Error fetching transactions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/report', requireAuth, async (req, res) => {
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

    // Count unique newsletter subscribers
    const { count: newsletterCount } = await supabase
      .from('tickets_5050')
      .select('buyer_email', { count: 'exact', head: true })
      .eq('status', 'sold')
      .eq('newsletter_opt_in', true);

    res.json({
      totalSales,
      totalRevenue: totalRevenue.toFixed(2),
      netRevenue: netRevenue.toFixed(2),
      refunds: { count: refunded.length, total: refundedTotal.toFixed(2) },
      cash: { count: cashTxns.length, total: cashTotal.toFixed(2) },
      card: { count: cardTxns.length, total: cardTotal.toFixed(2) },
      tickets5050: { sold: ticketsSold || 0, available: ticketsAvailable || 0 },
      newsletterSubscribers: newsletterCount || 0,
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

    // Release 50/50 tickets back to available and adjust revenue
    const { data: releasedTickets, error: ticketError } = await supabase
      .from('tickets_5050')
      .update({ status: 'available', buyer_email: null, buyer_name: null, buyer_phone: null, newsletter_opt_in: false, sold_at: null, transaction_id: null })
      .eq('transaction_id', paymentId)
      .select('id');
    if (ticketError) console.error('Error releasing 50/50 tickets:', ticketError.message);

    // If 50/50 tickets were released, recalculate revenue from scratch
    if (releasedTickets && releasedTickets.length > 0) {
      await recalcFiftyFiftyRevenue();
    }

    res.json({ status: 'refunded' });
  } catch (err) {
    console.error('Error creating refund:', err);
    const message = err.errors ? err.errors.map(e => e.detail).join(', ') : err.message;
    res.status(500).json({ error: message });
  }
});

// --- 50/50 Draw (with persistence) ---

// In-memory draw result (persists across requests, resets on server restart)
let currentDrawResult = null;

// In-memory 50/50 revenue tracker (rebuilt on startup from transactions)
let fiftyFiftyRevenue = 0;

async function recalcFiftyFiftyRevenue() {
  try {
    const txns = await loadTransactions();
    // For transactions that are purely 50/50, use the full amount
    // For mixed transactions, we can't determine the split - but the in-memory
    // tracker handles new sales accurately. This fallback is only for server restarts.
    fiftyFiftyRevenue = txns
      .filter(t => (t.status === 'succeeded' || t.status === 'completed') && t.description && t.description.includes('50/50'))
      .reduce((sum, t) => {
        // If description ONLY contains 50/50 items, use full amount
        const items = t.description.split(', ');
        const allFiftyFifty = items.every(item => item.startsWith('50/50'));
        if (allFiftyFifty) return sum + parseFloat(t.amount);
        // Mixed cart - estimate 50/50 portion by subtracting known item prices
        let otherAmount = 0;
        for (const item of items) {
          const match = item.match(/^(.+?)\s*\((\d+)\)$/);
          if (match) {
            const name = match[1].trim();
            const qty = parseInt(match[2]);
            if (name === 'Early Bird') otherAmount += qty * 20;
            else if (name === 'GA') otherAmount += qty * 25;
            else if (name === 'Door Tickets') otherAmount += qty * 30;
            else if (name === 'Raffle Tickets') otherAmount += qty * 5;
          }
        }
        return sum + Math.max(0, parseFloat(t.amount) - otherAmount);
      }, 0);
    console.log('50/50 revenue recalculated:', fiftyFiftyRevenue);
  } catch (err) {
    console.error('Error recalculating 50/50 revenue:', err.message);
  }
}
// Recalculate on startup (deferred to avoid blocking)
setTimeout(() => recalcFiftyFiftyRevenue(), 2000);

// Server-side admin password verification
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// Get current draw result (if one exists)
app.post('/api/draw-5050/current', requireAuth, async (req, res) => {
  if (currentDrawResult) {
    // Also fetch fresh jackpot data
    const { count } = await supabase
      .from('tickets_5050')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sold');
    res.json({ ...currentDrawResult, totalSold: count || 0 });
  } else {
    res.json({ winner: null });
  }
});

// Run the draw
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

    const result = {
      ticketNumber: winner.ticket_number,
      email: winner.buyer_email,
      name: winner.buyer_name,
      phone: winner.buyer_phone,
      totalSold: soldTickets.length,
      drawnAt: new Date().toISOString(),
    };

    // Persist the result
    currentDrawResult = result;

    // Email the winner (fire-and-forget)
    if (winner.buyer_email) {
      const jackpot = (fiftyFiftyRevenue / 2).toFixed(2);
      sendWinnerEmail(winner.buyer_email, winner.buyer_name, winner.ticket_number, jackpot).catch(err => {
        console.error('Winner email failed:', err.message);
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Error running 50/50 draw:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clear draw result (used by factory reset)
app.post('/api/draw-5050/clear', requireAuth, async (req, res) => {
  currentDrawResult = null;
  res.json({ ok: true });
});

// --- Newsletter Subscribers Export (Mailchimp-ready CSV) ---
app.get('/api/newsletter-export', requireAuth, async (req, res) => {
  try {
    // Get all sold tickets where newsletter_opt_in is true, deduplicate by email
    const { data: subscribers, error } = await supabase
      .from('tickets_5050')
      .select('buyer_name, buyer_email, buyer_phone')
      .eq('status', 'sold')
      .eq('newsletter_opt_in', true);

    if (error) throw error;

    // Deduplicate by email (keep first occurrence)
    const seen = new Set();
    const unique = [];
    for (const sub of (subscribers || [])) {
      const email = (sub.buyer_email || '').toLowerCase();
      if (email && !seen.has(email)) {
        seen.add(email);
        unique.push(sub);
      }
    }

    // Build CSV - Mailchimp standard columns
    const rows = [['First Name', 'Last Name', 'Email Address', 'Phone Number']];
    for (const sub of unique) {
      const fullName = (sub.buyer_name || '').trim();
      const parts = fullName.split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      const email = sub.buyer_email || '';
      const phone = sub.buyer_phone || '';
      rows.push([csvEscape(firstName), csvEscape(lastName), csvEscape(email), csvEscape(phone)]);
    }

    const csv = rows.map(r => r.join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="yer-letter-subscribers.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting newsletter subscribers:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function csvEscape(value) {
  if (!value) return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

// --- Factory Reset (for testing) ---
app.post('/api/reset', requireAuth, async (req, res) => {
  try {
    // 1. Delete all transactions
    const { error: txErr } = await supabase
      .from('transactions')
      .delete()
      .neq('id', 0); // delete all rows
    if (txErr) console.error('Reset transactions error:', txErr.message);

    // 2. Reset all 50/50 tickets back to available
    const { error: ticketErr } = await supabase
      .from('tickets_5050')
      .update({
        status: 'available',
        buyer_email: null,
        buyer_name: null,
        buyer_phone: null,
        newsletter_opt_in: false,
        sold_at: null,
        transaction_id: null,
      })
      .neq('id', 0); // update all rows
    if (ticketErr) console.error('Reset tickets error:', ticketErr.message);

    // 3. Reset inventory to defaults
    for (const [name, remaining] of Object.entries(DEFAULT_INVENTORY)) {
      await saveInventoryItem(name, remaining);
    }

    // 4. Clear draw result and 50/50 revenue
    currentDrawResult = null;
    fiftyFiftyRevenue = 0;

    console.log('Factory reset completed');
    res.json({ status: 'reset', inventory: DEFAULT_INVENTORY });
  } catch (err) {
    console.error('Error during reset:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Email Test (admin diagnostic) ---
app.post('/api/test-email', requireAuth, async (req, res) => {
  try {
    if (!process.env.RESEND_API_KEY) {
      return res.json({ ok: false, error: 'RESEND_API_KEY not set' });
    }
    const { data, error } = await resend.emails.send({
      from: 'TTH POS <onboarding@resend.dev>',
      to: 'tthpodcastseries@gmail.com',
      subject: 'POS Email Test',
      text: 'If you receive this, email delivery is working on Render via Resend.',
    });
    if (error) return res.json({ ok: false, error });
    res.json({ ok: true, id: data?.id });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`POS server running on http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'NOT configured'}`);
  console.log(`Resend email: ${process.env.RESEND_API_KEY ? 'configured' : 'NOT configured'}`);
});
