/**
 * ระบบรับออเดอร์ร้าน: หน้าเว็บ → Google Sheets → แจ้งเตือน LINE (ไทย / English)
 * Order system: website form → Google Sheet → LINE alert to the shop (Thai / English).
 *
 * Paste this whole file into Extensions → Apps Script of a Google Sheet.
 * Then add 3 Script properties (Project Settings → Script properties):
 *   LINE_TOKEN     Channel access token from LINE Developers (Messaging API tab)
 *   WEBHOOK_KEY    any random text. Also goes at the end of the webhook URL (?key=...)
 *   REGISTER_CODE  a code the shop owner types in LINE once
 * ADMIN_IDS and LAST_ID are saved by the script itself.
 * Full steps: SETUP.md
 */

// ---------- 1. Settings you edit per shop ----------

// Prices live HERE, not in the web page. Anyone can edit a web page in their browser,
// so the script always recalculates the total from this list.
const MENU = {
  oliang:     { th: 'โอเลี้ยง',        en: 'Oliang',           price: 45 },
  icedcoffee: { th: 'กาแฟเย็นแก้วโหล', en: 'Thai iced coffee', price: 55 },
  icedlatte:  { th: 'ลาเต้เย็น',        en: 'Iced latte',       price: 65 },
  hotlatte:   { th: 'ลาเต้ร้อน',        en: 'Hot latte',        price: 60 },
  americano:  { th: 'อเมริกาโน่',       en: 'Americano',        price: 55 },
  thaitea:    { th: 'ชาไทย',           en: 'Thai tea',         price: 50 },
};

const SHOP_NAME = 'เหมือนเดิม';
const SUMMARY_HOUR = 21;          // daily summary at 21:00
const TZ = 'Asia/Bangkok';

// Pickup rules. The order page has the same numbers at the top of its script: change both together.
const OPEN_HOUR = 7;              // shop opens 07:00
const CLOSE_HOUR = 16;            // last pickup 16:00
const PREP_MIN = 15;              // minutes the shop needs to make an order
const DAYS_AHEAD = 7;             // "order for later" up to 7 days ahead
const SLOT_MIN = 15;              // later pickups are every 15 minutes

// ---------- 2. Sheet layout ----------
const SHEET_NAME = 'Orders';
const HEADERS = ['เลขที่ / No.', 'เวลาสั่ง / Time', 'ชื่อ / Name', 'เบอร์โทร / Phone', 'รายการ / Items',
                 'ยอดรวม / Total', 'เวลารับ / Pickup', 'หมายเหตุ / Note', 'สถานะ / Status', 'การชำระเงิน / Payment'];
const COL = { id: 1, time: 2, name: 3, phone: 4, items: 5, total: 6, pickup: 7, note: 8, status: 9, payment: 10 };

const STATUS = {
  new:       'ใหม่ / New',
  accepted:  'ยืนยันแล้ว / Accepted',
  ready:     'พร้อมรับ / Ready',
  picked:    'รับแล้ว / Picked up',
  cancelled: 'ยกเลิก / Cancelled',
};

// Payment is its own column: it is not the same question as "how far is the order".
// Today everyone pays at the shop, so tapping "Picked up" marks it paid.
// An online-payment add-on would write PAY.paid earlier.
const PAY = {
  atPickup: 'จ่ายหน้าร้าน / Pay at pickup',
  paid:     'จ่ายแล้ว / Paid',
};

// What each action does. Buttons and typed commands both go through these.
// An order only moves forward (rank goes up) or gets cancelled, so an old button can't undo anything.
const ACTIONS = {
  accept: STATUS.accepted,
  ready:  STATUS.ready,
  picked: STATUS.picked,
  cancel: STATUS.cancelled,
};
const RANK = { [STATUS.new]: 0, [STATUS.accepted]: 1, [STATUS.ready]: 2, [STATUS.picked]: 3 };

// Owner commands: Thai or English word → action
const COMMANDS = {
  'รับ': 'accept',      'accept': 'accept',
  'เสร็จ': 'ready',      'ready': 'ready',
  'รับแล้ว': 'picked',   'picked': 'picked',
  'ยกเลิก': 'cancel',    'cancel': 'cancel',
};

const BRAND_COLOR = '#24392D';    // button card colour (same green as the order page)

const HELP_TEXT =
  'คำสั่ง / Commands (หรือกดปุ่มในออเดอร์ / or tap the buttons)\n' +
  'รับ 12 / accept 12 = ยืนยันออเดอร์ / confirm order\n' +
  'เสร็จ 12 / ready 12 = พร้อมให้รับ / ready for pickup\n' +
  'รับแล้ว 12 / picked 12 = ลูกค้ารับแล้ว จ่ายแล้ว / picked up and paid\n' +
  'ยกเลิก 12 / cancel 12 = ยกเลิก / cancel\n' +
  'สรุป / summary = ยอดวันนี้ / today\'s sales';

const props = PropertiesService.getScriptProperties();


// ========== Entry point: every request comes in here ==========
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'bad request' });
  }

  // LINE sends {"events":[...]}. Apps Script can't read LINE's signature header,
  // so the secret key in the webhook URL is what proves the request came from our LINE setup.
  if (body.events) {
    if (e.parameter.key !== props.getProperty('WEBHOOK_KEY')) return json({ ok: false });
    body.events.forEach(handleLineEvent);
    return json({ ok: true });
  }

  // Our order page sends {"type":"order", ...}
  if (body.type === 'order') return json(handleOrder(body));

  return json({ ok: false, error: 'unknown request' });
}


// ========== Orders from the web page ==========
function handleOrder(order) {
  // Bots fill every field, people don't see this one. If it has text, it's spam.
  if (order.website) return { ok: true, id: 0 };

  const name = String(order.name || '').trim().slice(0, 50);
  const phone = String(order.phone || '').replace(/\D/g, '');
  const note = String(order.note || '').trim().slice(0, 120);

  if (!name) return { ok: false, error: 'กรุณาใส่ชื่อ / Please enter your name' };
  if (phone.length < 9 || phone.length > 10) return { ok: false, error: 'เบอร์โทรไม่ถูกต้อง / Invalid phone number' };

  // The page sends {type:'asap'} or {type:'later', date:'2026-11-28', time:'07:30'}.
  // We check it against the shop's hours ourselves and write the text ourselves,
  // so nothing the customer's browser sends is shown to the shop as it is.
  const now = bangkokNow();
  const when = resolvePickup(order.pickup, now.today, now.minutes);
  if (!when.ok) return when;
  const pickup = when.text;

  // Rebuild the item list from MENU so prices can't be faked.
  const lines = [];
  let total = 0;
  (order.items || []).forEach(item => {
    const m = MENU[item.id];
    const qty = Math.min(Math.max(parseInt(item.qty, 10) || 0, 0), 20);
    if (!m || qty === 0) return;
    lines.push(`${m.th} (${m.en}) x${qty}`);
    total += m.price * qty;
  });
  if (lines.length === 0) return { ok: false, error: 'ยังไม่ได้เลือกเมนู / No drinks selected' };

  // One order per phone number every 30 seconds, so double-taps don't create two orders.
  const cache = CacheService.getScriptCache();
  if (cache.get('recent-' + phone)) return { ok: false, error: 'เพิ่งสั่งไป รอสักครู่ / Just ordered, please wait a moment' };
  cache.put('recent-' + phone, '1', 30);

  // The lock makes sure two orders at the same moment don't get the same number.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let id;
  try {
    const sheet = getSheet();
    // A saved counter, not the row count, so deleting a row never repeats a number.
    id = Number(props.getProperty('LAST_ID') || 0) + 1;
    props.setProperty('LAST_ID', String(id));
    sheet.appendRow([id, new Date(), name, "'" + phone, lines.join('\n'), total, pickup, note, STATUS.new, PAY.atPickup]);
  } finally {
    lock.releaseLock();
  }

  pushOrderCard({ id: id, name: name, phone: phone, items: lines, total: total, pickup: pickup, note: note,
                  status: STATUS.new, payment: PAY.atPickup });

  return { ok: true, id: id, total: total, pickup: pickup };
}


// ========== Pickup time ==========
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Today's date and minutes since midnight, in Bangkok time (the server's own clock zone doesn't matter).
function bangkokNow() {
  const now = new Date();
  const [h, m] = Utilities.formatDate(now, TZ, 'HH:mm').split(':').map(Number);
  return { today: Utilities.formatDate(now, TZ, 'yyyy-MM-dd'), minutes: h * 60 + m };
}

function hhmm(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

// "2026-11-28" → a UTC Date at midnight, or null if it isn't a real date.
// UTC is only used here to count days and find the weekday, so Bangkok vs server time can't shift it.
function parseDay(text) {
  const m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}

// Pure function (no Google services), so it can be tested outside Apps Script.
// today = 'yyyy-MM-dd' in Bangkok, nowMin = minutes since midnight in Bangkok.
// Returns { ok: true, text } with the text for LINE and the sheet, or { ok: false, error }.
function resolvePickup(pickup, today, nowMin) {
  const open = OPEN_HOUR * 60, close = CLOSE_HOUR * 60;
  const bad = { ok: false, error: 'เวลารับไม่ถูกต้อง รีเฟรชหน้าแล้วลองใหม่ / Invalid pickup time, please refresh and try again' };
  if (!pickup || typeof pickup !== 'object') return bad;

  if (pickup.type === 'asap') {
    if (nowMin < open || nowMin + PREP_MIN > close) {
      return { ok: false, error: `ร้านปิดแล้ว เลือก "สั่งล่วงหน้า" / Shop is closed, please choose "Order for later"` };
    }
    return { ok: true, text: `รับเลย / ASAP ~${hhmm(nowMin + PREP_MIN)}` };
  }

  if (pickup.type === 'later') {
    const day = parseDay(pickup.date);
    const t = String(pickup.time || '').match(/^(\d{2}):(\d{2})$/);
    if (!day || !t) return bad;
    const mins = +t[1] * 60 + +t[2];
    if (+t[2] > 59 || mins % SLOT_MIN !== 0 || mins < open || mins > close) {
      return { ok: false, error: `ร้านเปิด ${hhmm(open)}–${hhmm(close)} / Open ${hhmm(open)}–${hhmm(close)}` };
    }
    const daysAway = Math.round((day - parseDay(today)) / 86400000);
    if (daysAway < 0 || daysAway > DAYS_AHEAD) {
      return { ok: false, error: `สั่งล่วงหน้าได้ไม่เกิน ${DAYS_AHEAD} วัน / Up to ${DAYS_AHEAD} days ahead only` };
    }
    if (daysAway === 0 && mins < nowMin + PREP_MIN) {
      return { ok: false, error: 'เวลานี้ผ่านไปแล้ว เลือกเวลาใหม่ / That time has passed, please pick another' };
    }
    const wd = day.getUTCDay(), d = day.getUTCDate(), mo = day.getUTCMonth();
    return { ok: true, text: `${TH_DAYS[wd]} ${d} ${TH_MONTHS[mo]} / ${EN_DAYS[wd]} ${d} ${EN_MONTHS[mo]} ${hhmm(mins)}` };
  }

  return bad;
}


// ========== Messages the shop owner sends to the LINE OA ==========
function handleLineEvent(ev) {
  // A button tap on an order card
  if (ev.type === 'postback') return handlePostback(ev);
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = ev.message.text.trim();
  const userId = ev.source.userId;
  const admins = getAdmins();

  // Owner setup: "ลงทะเบียน 5917" or "register 5917"
  const reg = text.match(/^(?:ลงทะเบียน|register)\s*(\S+)$/i);
  if (reg) return handleRegister(ev, userId, reg[1], admins);

  // Customers chatting with the shop: leave them to the shop's normal LINE chat.
  if (!admins.includes(userId)) return;

  // "รับ 12" / "accept 12" / "เสร็จ 12" / "ready 12" / "รับแล้ว 12" / "picked 12" / "ยกเลิก 12" / "cancel 12"
  const cmd = text.match(/^(\S+)\s*#?(\d+)$/);
  const action = cmd && COMMANDS[cmd[1].toLowerCase()];
  if (action) return runAction(ev.replyToken, action, Number(cmd[2]));

  if (text === 'สรุป' || text.toLowerCase() === 'summary') return reply(ev.replyToken, buildSummary());

  return reply(ev.replyToken, HELP_TEXT);
}


// Button data looks like "accept:12". Only registered owners can use the buttons.
function handlePostback(ev) {
  if (!getAdmins().includes(ev.source.userId)) return;
  const m = String(ev.postback.data).match(/^(accept|ready|picked|cancel):(\d+)$/);
  if (m) runAction(ev.replyToken, m[1], Number(m[2]));
}

// Same path for typed commands and button taps: change the order, then answer with the new card.
function runAction(replyToken, action, id) {
  const result = applyAction(action, id);
  if (!result.order) return reply(replyToken, result.text);
  replyCard(replyToken, result.order);
}


// ========== Owner registration ==========
// The code works ONCE: after a successful register it is deleted, so nobody else can reuse it.
// To add a staff member later: set a new REGISTER_CODE in Script properties, they register, it's deleted again.
// Owners see customers' names and phone numbers, so this door has to stay shut.
function handleRegister(ev, userId, code, admins) {
  if (admins.includes(userId)) return reply(ev.replyToken, 'ลงทะเบียนไว้แล้ว / Already registered ✓');

  // 5 wrong codes → this LINE user is ignored for an hour (stops guessing)
  const cache = CacheService.getScriptCache();
  const triesKey = 'tries-' + userId;
  const tries = Number(cache.get(triesKey) || 0);
  if (tries >= 5) return;

  const realCode = props.getProperty('REGISTER_CODE');
  if (!realCode || code !== realCode) {
    cache.put(triesKey, String(tries + 1), 3600);
    return reply(ev.replyToken, 'รหัสไม่ถูกต้อง / Wrong code');
  }

  // Tell the existing owners someone new was added, so a stranger getting in can't go unnoticed.
  pushToAdmins('⚠️ มีผู้ดูแลใหม่ลงทะเบียน / A new admin just registered.\nถ้าไม่ใช่คนที่รู้จัก ลบ ADMIN_IDS ใน Script properties\nIf you don\'t know who this is, delete ADMIN_IDS in Script properties.');

  admins.push(userId);
  props.setProperty('ADMIN_IDS', JSON.stringify(admins));
  props.deleteProperty('REGISTER_CODE');            // one-time code: used up now

  return reply(ev.replyToken, 'ลงทะเบียนแล้ว ✓ / Registered ✓\nออเดอร์ใหม่จะแจ้งมาที่นี่ / New orders will arrive here\n\n' + HELP_TEXT);
}


// ========== Daily summary ==========
function buildSummary() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const rows = getSheet().getDataRange().getValues().slice(1);   // skip header

  const todays = rows.filter(r => r[COL.time - 1] instanceof Date &&
    Utilities.formatDate(r[COL.time - 1], TZ, 'yyyy-MM-dd') === today);
  const valid = todays.filter(r => r[COL.status - 1] !== STATUS.cancelled);
  // Sales only count orders the customer has picked up and paid for.
  const sales = valid.filter(r => r[COL.status - 1] === STATUS.picked)
    .reduce((sum, r) => sum + Number(r[COL.total - 1]), 0);
  const pending = valid.filter(r => r[COL.status - 1] !== STATUS.picked);

  return `📊 สรุปวันนี้ / Today (${SHOP_NAME})\n` +
    `ออเดอร์ / Orders: ${valid.length}\n` +
    `ยอดขาย / Sales: ${sales.toLocaleString()} บาท (เฉพาะที่รับแล้ว / picked-up only)` +
    (pending.length
      ? `\nยังค้าง / Pending: ${pending.map(r => '#' + r[0]).join(' ')}`
      : '\nไม่มีออเดอร์ค้าง / Nothing pending ✓');
}

// Runs every day at SUMMARY_HOUR (set up once with setupDailySummary)
function sendDailySummary() {
  pushToAdmins(buildSummary());
}

// Run this ONE time from the Apps Script editor to turn on the daily summary.
function setupDailySummary() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendDailySummary')
    .forEach(t => ScriptApp.deleteTrigger(t));      // avoid duplicates if run twice
  ScriptApp.newTrigger('sendDailySummary').timeBased().atHour(SUMMARY_HOUR).everyDays(1).inTimezone(TZ).create();
}


// ========== Helpers ==========
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  // Sheets made before the Payment column existed get its header added once.
  if (!sheet.getRange(1, COL.payment).getValue()) {
    sheet.getRange(1, COL.payment).setValue(HEADERS[COL.payment - 1]).setFontWeight('bold');
  }
  return sheet;
}

// Find one order by its number. Returns { row, order } or null.
function findOrder(id) {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (Number(r[COL.id - 1]) !== id) continue;
    return { row: i + 1, order: {
      id: id,
      name: String(r[COL.name - 1]),
      phone: String(r[COL.phone - 1]),
      items: String(r[COL.items - 1]).split('\n'),
      total: r[COL.total - 1],
      pickup: String(r[COL.pickup - 1]),
      note: String(r[COL.note - 1]),
      status: r[COL.status - 1],
      payment: r[COL.payment - 1] || PAY.atPickup,     // rows from before the Payment column
    } };
  }
  return null;
}

// Move an order to its next status. Returns { order } on success or { text } with the reason.
// The lock matters: two quick taps can't both pass the check and both change the row.
function applyAction(action, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const found = findOrder(id);
    if (!found) return { text: `ไม่พบออเดอร์ / Order not found #${id}` };

    const order = found.order, target = ACTIONS[action];
    const closed = order.status === STATUS.cancelled || order.status === STATUS.picked;
    const backwards = action !== 'cancel' && RANK[target] <= RANK[order.status];
    if (closed || backwards) {
      return { text: `#${id} ตอนนี้ / now: ${order.status}\nทำรายการนี้ไม่ได้ / Can't do that now` };
    }

    const sheet = getSheet();
    sheet.getRange(found.row, COL.status).setValue(target);
    order.status = target;
    if (target === STATUS.picked && order.payment === PAY.atPickup) {
      order.payment = PAY.paid;                       // paid at the counter
      sheet.getRange(found.row, COL.payment).setValue(PAY.paid);
    }
    return { order: order };
  } finally {
    lock.releaseLock();
  }
}


// ========== The order card (buttons in LINE) ==========
// One card is used for the new-order alert and for every answer after a tap,
// so the order always looks the same and shows only the next step.
function orderText(o) {
  const title = o.status === STATUS.new ? 'ออเดอร์ใหม่ / New order' : 'ออเดอร์ / Order';
  return `🧾 ${title} #${o.id} · ${o.status}\n` +
    `${o.name} ${formatPhone(o.phone)}\n` +
    o.items.map(l => '• ' + l).join('\n') + '\n' +
    `รวม / Total: ${o.total} บาท\n` +
    `รับเวลา / Pickup: ${o.pickup || '-'}\n` +
    `ชำระเงิน / Payment: ${o.payment}` +
    (o.note ? `\nหมายเหตุ / Note: ${o.note}` : '');
}

function orderCard(o) {
  const text = (t, extra) => Object.assign({ type: 'text', text: String(t), wrap: true, size: 'md', color: '#222222' }, extra);
  const caption = t => text(t, { size: 'sm', color: '#707070' });
  const field = (label, value) => ({ type: 'box', layout: 'vertical', spacing: '4px', contents: [caption(label), text(value, { weight: 'bold' })] });

  const body = [
    text(`${o.name}  ${formatPhone(o.phone)}`, { weight: 'bold' }),
    { type: 'box', layout: 'vertical', spacing: '4px', contents: o.items.map(l => text('• ' + l)) },
    { type: 'separator' },
    { type: 'box', layout: 'horizontal', contents: [
      text('รวม / Total', { flex: 1 }), text(`${o.total} บาท`, { weight: 'bold', align: 'end', flex: 0, wrap: false }) ] },
    field('รับเวลา / Pickup', o.pickup || '-'),
  ];
  if (o.note) body.push(field('หมายเหตุ / Note', o.note));
  body.push(field('การชำระเงิน / Payment', o.payment));

  const bubble = {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: BRAND_COLOR, paddingAll: '16px', spacing: '4px', contents: [
      text(`ออเดอร์ #${o.id} / Order #${o.id}`, { size: 'lg', weight: 'bold', color: '#FFFFFF' }),
      text(o.status, { size: 'sm', color: '#DCE5DF' }) ] },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: '12px', contents: body },
  };
  const buttons = cardButtons(o);
  if (buttons.length) bubble.footer = { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: '8px', contents: buttons };

  return { type: 'flex', altText: orderText(o).slice(0, 400), contents: bubble };     // altText = the lock-screen preview
}

// One big main button for the next step, one quiet Cancel. Nothing after Picked up / Cancelled.
function cardButtons(o) {
  const next = { [STATUS.new]: ['accept', 'รับ / Accept'], [STATUS.accepted]: ['ready', 'พร้อมรับ / Ready'],
                 [STATUS.ready]: ['picked', 'รับแล้ว / Picked up'] }[o.status];
  if (!next) return [];
  return [ cardButton(next[1], `${next[0]}:${o.id}`, true), cardButton('ยกเลิก / Cancel', `cancel:${o.id}`, false) ];
}

// A tappable box (48px tall, easy to hit) instead of LINE's thinner standard button.
function cardButton(label, data, primary) {
  const box = {
    type: 'box', layout: 'vertical', height: '48px', justifyContent: 'center', alignItems: 'center', cornerRadius: '8px',
    action: { type: 'postback', label: label, data: data },
    contents: [{ type: 'text', text: label, size: 'md', weight: primary ? 'bold' : 'regular', color: primary ? '#FFFFFF' : '#555555' }],
  };
  if (primary) box.backgroundColor = BRAND_COLOR;
  else { box.borderWidth = '1px'; box.borderColor = '#D0D0D0'; }
  return box;
}


function getAdmins() {
  return JSON.parse(props.getProperty('ADMIN_IDS') || '[]');
}

// Push = the shop starts the message. Counts toward the LINE monthly free quota (1 per admin).
function pushToAdmins(text) {
  getAdmins().forEach(to => lineApi('push', { to: to, messages: [{ type: 'text', text: text }] }));
}

// New order alert with buttons. If LINE refuses the card for any reason, send the plain text version
// instead, so the shop never misses an order.
function pushOrderCard(o) {
  getAdmins().forEach(to => {
    if (lineApi('push', { to: to, messages: [orderCard(o)] })) return;
    const hint = `\n\nตอบ / Reply "รับ ${o.id}" หรือ / or "accept ${o.id}"`;
    lineApi('push', { to: to, messages: [{ type: 'text', text: orderText(o) + hint }] });
  });
}

// Reply = answering the owner's message. Free, doesn't use the quota.
function reply(replyToken, text) {
  lineApi('reply', { replyToken: replyToken, messages: [{ type: 'text', text: text }] });
}

function replyCard(replyToken, o) {
  if (!lineApi('reply', { replyToken: replyToken, messages: [orderCard(o)] })) reply(replyToken, `#${o.id} → ${o.status} ✓`);
}

// Returns true when LINE accepted the message.
function lineApi(kind, payload) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + kind, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + props.getProperty('LINE_TOKEN') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) console.error('LINE error', res.getResponseCode(), res.getContentText());
  return res.getResponseCode() === 200;
}

function formatPhone(p) {
  return p.length === 10 ? `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}` : p;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run this from the editor after setup to check LINE works without placing an order.
function testLineMessage() {
  pushToAdmins('ทดสอบ ✓ ระบบออเดอร์เชื่อมกับ LINE แล้ว\nTest ✓ The order system is connected to LINE');
}
