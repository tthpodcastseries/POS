require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { SquareClient, SquareEnvironment } = require('square');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
app.use(cors({
  origin: process.env.APP_ORIGIN || true,
  credentials: true,
}));
app.use(express.json());
app.use(express.static('public', { dotfiles: 'allow' }));

// --- Session-based auth (replaces exposed API key) ---
const API_KEY = process.env.POS_API_KEY;
const OPERATOR_PIN = process.env.OPERATOR_PIN || API_KEY; // PIN to unlock POS
const activeSessions = new Map(); // token -> { createdAt, ip }
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 hours

// Rate limiting for auth attempts
const pinAttempts = new Map(); // ip -> { count, firstAttempt }
const adminAttempts = new Map(); // ip -> { count, firstAttempt }
const MAX_AUTH_ATTEMPTS = 3;
const AUTH_WINDOW = 15 * 60 * 1000; // 15 min lockout

function checkRateLimit(ip, type = 'pin') {
  const store = type === 'admin' ? adminAttempts : pinAttempts;
  const now = Date.now();
  const record = store.get(ip);
  if (!record || (now - record.firstAttempt) > AUTH_WINDOW) {
    store.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  record.count++;
  return record.count <= MAX_AUTH_ATTEMPTS;
}

function requireAuth(req, res, next) {
  // Support both session token and legacy API key
  const token = req.headers['x-session-token'];
  const legacyKey = req.headers['x-pos-key'];

  if (token && activeSessions.has(token)) {
    const session = activeSessions.get(token);
    if (Date.now() - session.createdAt < SESSION_TTL) return next();
    activeSessions.delete(token); // expired
  }
  if (legacyKey && legacyKey === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Admin password auth (for draw, reset, PII reports)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD not set in env vars - admin endpoints will be locked');
}
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'Admin not configured' });
  const pw = req.headers['x-admin-pw'] || req.query.pw;
  if (pw === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Admin password required' });
}

// Session login endpoint
app.post('/api/session/login', (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const { pin } = req.body;
  if (pin === OPERATOR_PIN) {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, { createdAt: Date.now(), ip });
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Incorrect PIN' });
});

// Clean up expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL) activeSessions.delete(token);
  }
}, 60 * 60 * 1000);

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

// Aggregate quantities per product from a description string
function aggregateQuantities(description) {
  const totals = {};
  const items = description.split(', ');
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
      const key = name === 'Door Tickets' ? 'Door Ticket' : name;
      totals[key] = (totals[key] || 0) + qty;
    }
  }
  return totals;
}

async function checkInventory(description) {
  const inv = await loadInventory();
  const totals = aggregateQuantities(description);
  for (const [key, qty] of Object.entries(totals)) {
    if (key in inv && qty > inv[key]) {
      return { ok: false, error: `Only ${inv[key]} ${key} remaining` };
    }
  }
  return { ok: true };
}

async function decrementInventory(description) {
  const inv = await loadInventory();
  const totals = aggregateQuantities(description);
  for (const [key, qty] of Object.entries(totals)) {
    if (key in inv) {
      const newCount = Math.max(0, inv[key] - qty);
      await saveInventoryItem(key, newCount);
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

// Reallocate unsold tickets from one tier to another
app.post('/api/inventory/reallocate', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.body; // e.g. { from: 'Early Bird Ticket', to: 'GA Ticket' }
    const validTiers = ['Early Bird Ticket', 'GA Ticket', 'Door Ticket'];
    if (!validTiers.includes(from) || !validTiers.includes(to) || from === to) {
      return res.status(400).json({ error: 'Invalid reallocation' });
    }
    const inv = await loadInventory();
    const moveQty = inv[from] || 0;
    if (moveQty === 0) {
      return res.status(400).json({ error: `No ${from} tickets to reallocate` });
    }
    await saveInventoryItem(from, 0);
    await saveInventoryItem(to, (inv[to] || 0) + moveQty);
    const updated = await loadInventory();
    console.log(`Reallocated ${moveQty} tickets: ${from} -> ${to}`);
    res.json({ moved: moveQty, from, to, inventory: updated });
  } catch (err) {
    console.error('Error reallocating inventory:', err.message);
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
          buyer_birthday: buyerInfo.birthday || null,
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
        .update({ status: 'available', buyer_email: null, buyer_name: null, buyer_phone: null, buyer_birthday: null, newsletter_opt_in: false, sold_at: null, transaction_id: null })
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
      from: 'TTH Podcast Series <5050@tthpods.com>',
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
      from: 'TTH Podcast Series <5050@tthpods.com>',
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
          <div style="background:#1a0045;padding:20px;margin:0 16px 12px;border-radius:8px;text-align:center;">
            <p style="margin:0 0 8px;color:#929292;font-size:13px;">To arrange payment, contact:</p>
            <p style="margin:0 0 4px;color:#d9d9d9;font-size:16px;font-weight:600;">jD</p>
            <a href="mailto:jd@tthpods.com" style="color:#22c55e;font-size:14px;text-decoration:none;">jd@tthpods.com</a>
          </div>
          <div style="padding:20px 24px;text-align:center;">
            <p style="color:#929292;font-size:13px;margin:0;">
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

// Send sale notification email to fundraising
async function sendSaleNotificationEmail(txId, amount, description, method, buyerName, buyerEmail, ticketNumbers) {
  try {
    const now = new Date();
    const timestamp = now.toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' });

    // Parse description into line items
    const items = description ? description.split(', ') : [];
    const itemRows = items.map(item => {
      const match = item.match(/^(.+?)\s*\((\d+)\)$/);
      if (match) {
        return `<tr><td style="padding:6px 12px;border-bottom:1px solid #2a1060;color:#d9d9d9;">${match[1].trim()}</td><td style="padding:6px 12px;border-bottom:1px solid #2a1060;color:#d9d9d9;text-align:center;">${match[2]}</td></tr>`;
      }
      return `<tr><td style="padding:6px 12px;border-bottom:1px solid #2a1060;color:#d9d9d9;" colspan="2">${item}</td></tr>`;
    }).join('');

    const methodLabel = method === 'cash' ? 'Cash' : method === 'applepay' ? 'Apple Pay' : 'Card';

    const ticketSection = ticketNumbers && ticketNumbers.length > 0
      ? `<tr><td style="padding:6px 12px;color:#929292;">50/50 Ticket Numbers</td><td style="padding:6px 12px;color:#22c55e;text-align:center;">${ticketNumbers.join(', ')}</td></tr>`
      : '';

    const buyerSection = buyerName || buyerEmail
      ? `<div style="background:#1a0045;padding:16px;margin:0 16px 12px;border-radius:8px;">
           <p style="margin:0 0 4px;color:#929292;font-size:13px;">Buyer Info</p>
           ${buyerName ? `<p style="margin:0 0 2px;color:#d9d9d9;">${buyerName}</p>` : ''}
           ${buyerEmail ? `<p style="margin:0;color:#d9d9d9;font-size:14px;">${buyerEmail}</p>` : ''}
         </div>`
      : '';

    const { data, error } = await resend.emails.send({
      from: 'TTH POS <5050@tthpods.com>',
      to: 'fundraising@tthpods.com',
      subject: `Sale Completed - $${parseFloat(amount).toFixed(2)} CAD (${methodLabel})`,
      html: `
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#140038;color:#d9d9d9;border-radius:12px;overflow:hidden;">
          <div style="padding:30px 24px 16px;text-align:center;">
            <h1 style="color:#ffffff;margin:0 0 4px;font-size:22px;">Sale Notification</h1>
            <p style="color:#929292;margin:0;font-size:13px;">${timestamp} ET</p>
          </div>
          <div style="background:#1a0045;padding:16px;margin:0 16px 12px;border-radius:8px;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr>
                  <th style="padding:6px 12px;text-align:left;color:#929292;font-size:13px;border-bottom:2px solid #2a1060;">Item</th>
                  <th style="padding:6px 12px;text-align:center;color:#929292;font-size:13px;border-bottom:2px solid #2a1060;">Qty</th>
                </tr>
              </thead>
              <tbody>
                ${itemRows}
                ${ticketSection}
              </tbody>
            </table>
          </div>
          <div style="background:#1a0045;padding:16px;margin:0 16px 12px;border-radius:8px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 12px;color:#929292;">Total</td><td style="padding:6px 12px;color:#ffffff;font-weight:bold;text-align:right;font-size:18px;">$${parseFloat(amount).toFixed(2)} CAD</td></tr>
              <tr><td style="padding:6px 12px;color:#929292;">Payment Method</td><td style="padding:6px 12px;color:#d9d9d9;text-align:right;">${methodLabel}</td></tr>
              <tr><td style="padding:6px 12px;color:#929292;">Transaction ID</td><td style="padding:6px 12px;color:#929292;text-align:right;font-size:11px;">${txId}</td></tr>
            </table>
          </div>
          ${buyerSection}
          <div style="padding:16px 24px;text-align:center;">
            <p style="color:#646464;font-size:11px;margin:0;">TTH POS - Automated Sale Notification</p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Sale notification email error:', error);
      return false;
    }
    console.log('Sale notification sent to fundraising@tthpods.com - tx:', txId, '- id:', data?.id);
    return true;
  } catch (err) {
    console.error('Error sending sale notification email:', err.message);
    return false;
  }
}

// --- Event Ticket Number Generation ---

// Count event tickets (Early Bird, GA, Door) in a description
function countEventTickets(description) {
  let total = 0;
  const eventTypes = ['Early Bird Ticket', 'GA Ticket', 'Door Tickets'];
  const items = description ? description.split(', ') : [];
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
      if (eventTypes.includes(name)) {
        total += qty;
      }
    }
  }
  return total;
}

// Parse which event ticket types and quantities are in the description
function parseEventTickets(description) {
  const tickets = [];
  const eventTypes = { 'Early Bird Ticket': 'EB', 'GA Ticket': 'GA', 'Door Tickets': 'DOOR' };
  const items = description ? description.split(', ') : [];
  for (const item of items) {
    const match = item.match(/^(.+?)\s*\((\d+)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseInt(match[2]);
      if (eventTypes[name]) {
        for (let i = 0; i < qty; i++) {
          tickets.push({ type: name, prefix: eventTypes[name] });
        }
      }
    }
  }
  return tickets;
}

// Generate unique event ticket numbers using Supabase counter
async function generateEventTicketNumbers(tickets, txId, buyerInfo = {}) {
  const assigned = [];

  for (const ticket of tickets) {
    // Use timestamp + random for uniqueness, format: GED-EB-0001
    // We'll use a Supabase-based counter via an RPC or just use a unique approach
    const now = Date.now();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const seq = (now % 100000).toString().padStart(5, '0');
    const ticketNumber = `GED-${ticket.prefix}-${seq}${rand}`;

    assigned.push({
      ticketNumber,
      type: ticket.type,
    });
  }

  // Store in Supabase for record keeping (use event_tickets table)
  for (const t of assigned) {
    try {
      await supabase.from('event_tickets').insert({
        ticket_number: t.ticketNumber,
        ticket_type: t.type,
        buyer_email: buyerInfo.email || null,
        buyer_name: buyerInfo.name || null,
        buyer_phone: buyerInfo.phone || null,
        transaction_id: txId,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Error storing event ticket:', err.message);
      // Non-fatal - ticket number is still valid
    }
  }

  return assigned;
}

// Send event ticket confirmation email
async function sendEventTicketEmail(email, tickets, buyerName) {
  const ticketRows = tickets.map(t =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a1060;color:#22c55e;font-size:16px;font-weight:bold;">${t.ticketNumber}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a1060;color:#d9d9d9;font-size:14px;">${t.type}</td>
    </tr>`
  ).join('');

  try {
    const { data, error } = await resend.emails.send({
      from: 'TTH Podcast Series <tickets@tthpods.com>',
      to: email,
      subject: 'Your Ticket Confirmation - An Evening for Sara J',
      html: `
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#140038;color:#d9d9d9;border-radius:12px;overflow:hidden;">
          <div style="padding:30px 24px;text-align:center;">
            <h1 style="color:#ffffff;margin:0 0 4px;font-size:24px;">You're In!</h1>
            <p style="color:#929292;margin:0;font-size:14px;">An Evening for Sara J</p>
          </div>

          <div style="background:#1a0045;padding:20px;margin:0 16px 12px;border-radius:8px;">
            <p style="margin:0 0 12px;color:#d9d9d9;">Hey${buyerName ? ' ' + buyerName : ''}! Here are your ticket details:</p>
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr>
                  <th style="padding:8px 12px;text-align:left;color:#929292;font-size:12px;border-bottom:2px solid #2a1060;">Ticket #</th>
                  <th style="padding:8px 12px;text-align:left;color:#929292;font-size:12px;border-bottom:2px solid #2a1060;">Type</th>
                </tr>
              </thead>
              <tbody>
                ${ticketRows}
              </tbody>
            </table>
          </div>

          <div style="background:#1a0045;padding:20px;margin:0 16px 12px;border-radius:8px;">
            <h2 style="color:#ffffff;margin:0 0 12px;font-size:16px;">Event Details</h2>
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;width:90px;">Event</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">An Evening for Sara J</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">Date</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">Saturday, April 11, 2026</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">Venue</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">The Firkin on Yonge</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">Address</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">207 Yonge St, Toronto, ON</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">Doors</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">7:30 PM</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">Show</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">8:00 PM</td>
              </tr>
            </table>
          </div>

          <div style="background:#1a0045;padding:20px;margin:0 16px 12px;border-radius:8px;">
            <h2 style="color:#ffffff;margin:0 0 12px;font-size:16px;">Agenda</h2>
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;width:90px;">7:30 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">Doors Open</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">8:00 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">jD And Patrick Downie - Intimate And Interactive Live Podcast Recording</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">8:45 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">Intermission</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">9:00 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">Forever Hip</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">10:00 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">Intermission</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">10:15 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">Forever Hip</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">11:15 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">50/50 And Raffle Prizes Awarded</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#929292;font-size:13px;">11:30 PM</td>
                <td style="padding:6px 0;color:#d9d9d9;font-size:14px;">Lights Out</td>
              </tr>
            </table>
          </div>

          <div style="padding:20px 24px;text-align:center;">
            <p style="color:#929292;font-size:13px;margin:0 0 8px;">
              Show this email at the door for entry.<br>
              All proceeds support The GoFundMe for Sara J.
            </p>
            <p style="color:#646464;font-size:11px;margin:8px 0 0;">TTH Podcast Series</p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Event ticket email error:', error);
      return false;
    }
    console.log('Event ticket email sent to', email, '- tickets:', tickets.map(t => t.ticketNumber).join(', '), '- id:', data?.id);
    return true;
  } catch (err) {
    console.error('Error sending event ticket email:', err.message);
    return false;
  }
}

// After a successful payment, handle event ticket generation + email
async function handleEventTicketsIfNeeded(description, email, txId, buyerInfo = {}) {
  const ticketList = parseEventTickets(description);
  if (ticketList.length === 0 || !email) return { assigned: false };

  const tickets = await generateEventTicketNumbers(ticketList, txId, buyerInfo);

  // Fire-and-forget email
  sendEventTicketEmail(email, tickets, buyerInfo.name).catch(err => {
    console.error('Event ticket email failed:', err.message);
  });

  return {
    assigned: true,
    eventTickets: tickets,
    eventEmailSent: true,
  };
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
app.get('/api/tickets-5050/available', requireAuth, async (req, res) => {
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
app.get('/api/tickets-5050/jackpot', requireAuth, async (req, res) => {
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
app.get('/api/inventory', requireAuth, async (req, res) => {
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

    // Handle event ticket generation + email
    const eventResult = await handleEventTicketsIfNeeded(description, email, txId, { name: buyerName, email, phone: buyerPhone });

    // Fire-and-forget sale notification to fundraising
    sendSaleNotificationEmail(txId, amount, description, method || 'card', buyerName, email, ticketResult.ticketNumbers).catch(err => {
      console.error('Sale notification email failed:', err.message);
    });

    res.json({
      paymentId: txId,
      status: payment.status,
      ticketNumbers: ticketResult.ticketNumbers || null,
      emailSent: ticketResult.emailSent || false,
      eventTickets: eventResult.eventTickets || null,
      eventEmailSent: eventResult.eventEmailSent || false,
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

    // Handle event ticket generation + email
    const eventResult = await handleEventTicketsIfNeeded(description, email, txId, { name: buyerName, email, phone: buyerPhone });

    // Fire-and-forget sale notification to fundraising
    sendSaleNotificationEmail(txId, amount, description, 'cash', buyerName, email, ticketResult.ticketNumbers).catch(err => {
      console.error('Sale notification email failed:', err.message);
    });

    res.json({
      status: 'succeeded',
      ticketNumbers: ticketResult.ticketNumbers || null,
      emailSent: ticketResult.emailSent || false,
      eventTickets: eventResult.eventTickets || null,
      eventEmailSent: eventResult.eventEmailSent || false,
    });
  } catch (err) {
    console.error('Error recording cash payment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Log a sale (tracker mode - no payment processing)
app.post('/api/log-sale', requireAuth, async (req, res) => {
  try {
    const { amount, description, email, buyerName, buyerPhone, buyerBirthday, newsletterOptIn, fiftyFiftyAmount } = req.body;
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

    const txId = 'log_' + Date.now() + '-' + Math.random().toString(36).slice(2);

    await saveTransaction({
      tx_id: txId,
      amount: parseFloat(amount).toFixed(2),
      description: description || 'Logged Sale',
      method: 'logged',
      status: 'completed',
      created: new Date().toISOString(),
    });

    // Track 50/50 revenue for jackpot calculation
    if (fiftyFiftyAmount && fiftyFiftyAmount > 0) {
      fiftyFiftyRevenue += parseFloat(fiftyFiftyAmount);
    }

    // Handle 50/50 ticket assignment + email
    const ticketResult = await handle5050IfNeeded(description, email, amount, txId, { name: buyerName, phone: buyerPhone, birthday: buyerBirthday, newsletterOptIn });

    // Handle event ticket generation + email
    const eventResult = await handleEventTicketsIfNeeded(description, email, txId, { name: buyerName, email, phone: buyerPhone });

    // Fire-and-forget sale notification to fundraising
    sendSaleNotificationEmail(txId, amount, description, 'logged', buyerName, email, ticketResult.ticketNumbers).catch(err => {
      console.error('Sale notification email failed:', err.message);
    });

    res.json({
      status: 'succeeded',
      ticketNumbers: ticketResult.ticketNumbers || null,
      emailSent: ticketResult.emailSent || false,
      eventTickets: eventResult.eventTickets || null,
      eventEmailSent: eventResult.eventEmailSent || false,
    });
  } catch (err) {
    console.error('Error logging sale:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Record an expense
app.post('/api/expense', requireAuth, async (req, res) => {
  try {
    const { amount, category } = req.body;
    const validCategories = ['Advertising', 'Fees', 'Supplies', 'Refund', 'Misc'];
    if (!amount || amount < 0.01) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!category || !validCategories.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const txId = 'exp_' + Date.now() + '-' + Math.random().toString(36).slice(2);

    await saveTransaction({
      tx_id: txId,
      amount: parseFloat(amount).toFixed(2),
      description: `Expense: ${category}`,
      method: 'expense',
      status: 'completed',
      created: new Date().toISOString(),
    });

    res.json({ status: 'recorded', txId });
  } catch (err) {
    console.error('Error recording expense:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- GoFundMe Tracker ---

app.get('/api/gofundme', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('transactions')
      .select('amount')
      .eq('tx_id', 'gofundme_total')
      .single();
    res.json({ total: data ? parseFloat(data.amount) : 0 });
  } catch (err) {
    res.json({ total: 0 });
  }
});

app.post('/api/gofundme', requireAuth, async (req, res) => {
  try {
    const { total } = req.body;
    if (total === undefined || total < 0) {
      return res.status(400).json({ error: 'Invalid total' });
    }
    // Upsert via delete + insert (no unique constraint assumption)
    await supabase.from('transactions').delete().eq('tx_id', 'gofundme_total');
    await supabase.from('transactions').insert({
      tx_id: 'gofundme_total',
      amount: parseFloat(total).toFixed(2),
      description: 'GoFundMe',
      method: 'gofundme',
      status: 'completed',
      created: new Date().toISOString(),
    });
    res.json({ status: 'saved', total: parseFloat(total).toFixed(2) });
  } catch (err) {
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
    const allTxns = await loadTransactions();
    // Separate GoFundMe row from regular transactions
    const gfmRow = allTxns.find(t => t.tx_id === 'gofundme_total');
    const txns = allTxns.filter(t => t.tx_id !== 'gofundme_total');
    const succeeded = txns.filter((t) => (t.status === 'succeeded' || t.status === 'completed') && t.method !== 'expense');
    const refunded = txns.filter((t) => t.status === 'refunded');
    const expenses = txns.filter((t) => t.method === 'expense' && t.status === 'completed');

    const totalSales = succeeded.length;
    const totalRevenue = succeeded.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const refundedTotal = refunded.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const expenseTotal = expenses.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const netRevenue = totalRevenue - refundedTotal - expenseTotal;

    const cashTxns = succeeded.filter((t) => t.method === 'cash');
    const cardTxns = succeeded.filter((t) => t.method === 'card');
    const applePayTxns = succeeded.filter((t) => t.method === 'applepay');
    const loggedTxns = succeeded.filter((t) => t.method === 'logged');
    const cashTotal = cashTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const cardTotal = cardTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const applePayTotal = applePayTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const loggedTotal = loggedTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);

    // Count raffle, 50/50, and event ticket sales from descriptions
    let raffleSold = 0;
    let raffleRevenue = 0;
    let fiftyFiftySold = 0;
    let fiftyFiftyRevenueCalc = 0;
    let eventTicketsSold = 0;
    let eventTicketsRevenue = 0;
    const ticketPrices = { 'Early Bird Ticket': 20, 'GA Ticket': 25, 'Door Tickets': 30 };
    const fiftyFiftyPrices = { 1: 5, 5: 20, 15: 50, 35: 100 };
    for (const t of succeeded) {
      if (t.description) {
        const items = t.description.split(', ');
        for (const item of items) {
          const match = item.match(/^(.+?)\s*\((\d+)\)$/);
          if (!match) continue;
          const name = match[1].trim();
          const qty = parseInt(match[2]);
          if (name === 'Raffle Tickets') {
            raffleSold += qty;
            if (qty === 1) raffleRevenue += 5;
            else if (qty === 5) raffleRevenue += 20;
            else if (qty === 15) raffleRevenue += 50;
            else if (qty === 35) raffleRevenue += 100;
            else raffleRevenue += qty * 5;
          } else if (name === '50/50 Tickets') {
            fiftyFiftySold += qty;
            if (fiftyFiftyPrices[qty]) fiftyFiftyRevenueCalc += fiftyFiftyPrices[qty];
            else fiftyFiftyRevenueCalc += qty * 5;
          } else if (ticketPrices[name] !== undefined) {
            eventTicketsSold += qty;
            eventTicketsRevenue += qty * ticketPrices[name];
          }
        }
      }
    }

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

    // Build expense breakdown by category
    const expensesByCategory = {};
    for (const exp of expenses) {
      const cat = exp.description.replace('Expense: ', '');
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + parseFloat(exp.amount);
    }

    const gfmTotal = gfmRow ? parseFloat(gfmRow.amount) : 0;
    const jackpotHalf = fiftyFiftyRevenueCalc / 2;
    const grandTotal = netRevenue + gfmTotal + jackpotHalf;

    res.json({
      totalSales,
      totalRevenue: totalRevenue.toFixed(2),
      netRevenue: netRevenue.toFixed(2),
      grandTotal: grandTotal.toFixed(2),
      refunds: { count: refunded.length, total: refundedTotal.toFixed(2) },
      expenses: { count: expenses.length, total: expenseTotal.toFixed(2), byCategory: expensesByCategory },
      cash: { count: cashTxns.length, total: cashTotal.toFixed(2) },
      card: { count: cardTxns.length, total: cardTotal.toFixed(2) },
      applePay: { count: applePayTxns.length, total: applePayTotal.toFixed(2) },
      logged: { count: loggedTxns.length, total: loggedTotal.toFixed(2) },
      raffle: { sold: raffleSold, total: raffleRevenue.toFixed(2) },
      eventTickets: { sold: eventTicketsSold, total: eventTicketsRevenue.toFixed(2) },
      tickets5050: { sold: ticketsSold || 0, available: ticketsAvailable || 0, total: fiftyFiftyRevenueCalc.toFixed(2) },
      gofundme: { total: gfmTotal.toFixed(2) },
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
  const totals = aggregateQuantities(description);
  for (const [key, qty] of Object.entries(totals)) {
    if (key in inv) {
      await saveInventoryItem(key, inv[key] + qty);
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
    if (!paymentId.startsWith('cash_') && !paymentId.startsWith('log_')) {
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
      .update({ status: 'available', buyer_email: null, buyer_name: null, buyer_phone: null, buyer_birthday: null, newsletter_opt_in: false, sold_at: null, transaction_id: null })
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
  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
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
app.post('/api/draw-5050', requireAuth, requireAdmin, async (req, res) => {
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
app.post('/api/draw-5050/clear', requireAuth, requireAdmin, async (req, res) => {
  currentDrawResult = null;
  res.json({ ok: true });
});

// --- Newsletter Subscribers Export (Mailchimp-ready CSV) ---
app.get('/api/newsletter-export', requireAuth, async (req, res) => {
  try {
    // Get all sold tickets where newsletter_opt_in is true, deduplicate by email
    const { data: subscribers, error } = await supabase
      .from('tickets_5050')
      .select('buyer_name, buyer_email, buyer_phone, buyer_birthday')
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

    // Build CSV - Mailchimp standard columns + birthday
    const rows = [['First Name', 'Last Name', 'Email Address', 'Phone Number', 'Birthday']];
    for (const sub of unique) {
      const fullName = (sub.buyer_name || '').trim();
      const parts = fullName.split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      const email = sub.buyer_email || '';
      const phone = sub.buyer_phone || '';
      const birthday = sub.buyer_birthday || '';
      rows.push([csvEscape(firstName), csvEscape(lastName), csvEscape(email), csvEscape(phone), csvEscape(birthday)]);
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
app.post('/api/reset', requireAuth, requireAdmin, async (req, res) => {
  try {
    // 0. Preserve GoFundMe total across reset
    const { data: gfmBackup } = await supabase
      .from('transactions')
      .select('*')
      .eq('tx_id', 'gofundme_total')
      .single();

    // 1. Delete all transactions
    const { error: txErr } = await supabase
      .from('transactions')
      .delete()
      .neq('id', 0); // delete all rows
    if (txErr) console.error('Reset transactions error:', txErr.message);

    // 1b. Restore GoFundMe row if it existed
    if (gfmBackup) {
      delete gfmBackup.id; // let Supabase assign new id
      await supabase.from('transactions').insert(gfmBackup);
    }

    // 2. Reset all 50/50 tickets back to available
    const { error: ticketErr } = await supabase
      .from('tickets_5050')
      .update({
        status: 'available',
        buyer_email: null,
        buyer_name: null,
        buyer_phone: null,
        buyer_birthday: null,
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
      from: 'TTH POS <5050@tthpods.com>',
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
