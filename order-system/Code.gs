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

// ---------- 2. Sheet layout ----------
const SHEET_NAME = 'Orders';
const HEADERS = ['เลขที่ / No.', 'เวลาสั่ง / Time', 'ชื่อ / Name', 'เบอร์โทร / Phone', 'รายการ / Items',
                 'ยอดรวม / Total', 'เวลารับ / Pickup', 'หมายเหตุ / Note', 'สถานะ / Status'];
const COL = { id: 1, time: 2, total: 6, status: 9 };   // column numbers we read or change later

const STATUS = {
  new:       'ใหม่ / New',
  accepted:  'รับแล้ว / Accepted',
  ready:     'พร้อมรับ / Ready',
  cancelled: 'ยกเลิก / Cancelled',
};

// Owner commands: Thai or English word → status
const COMMANDS = {
  'รับ': STATUS.accepted,    'accept': STATUS.accepted,
  'เสร็จ': STATUS.ready,      'ready': STATUS.ready,
  'ยกเลิก': STATUS.cancelled, 'cancel': STATUS.cancelled,
};

const HELP_TEXT =
  'คำสั่ง / Commands\n' +
  'รับ 12 / accept 12 = ยืนยันออเดอร์ / confirm order\n' +
  'เสร็จ 12 / ready 12 = พร้อมให้รับ / ready for pickup\n' +
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
  const pickup = String(order.pickup || '').slice(0, 20);
  const note = String(order.note || '').trim().slice(0, 120);

  if (!name) return { ok: false, error: 'กรุณาใส่ชื่อ / Please enter your name' };
  if (phone.length < 9 || phone.length > 10) return { ok: false, error: 'เบอร์โทรไม่ถูกต้อง / Invalid phone number' };

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
    sheet.appendRow([id, new Date(), name, "'" + phone, lines.join('\n'), total, pickup, note, STATUS.new]);
  } finally {
    lock.releaseLock();
  }

  pushToAdmins(
    `🧾 ออเดอร์ใหม่ / New order #${id}\n` +
    `${name} ${formatPhone(phone)}\n` +
    lines.map(l => '• ' + l).join('\n') + '\n' +
    `รวม / Total: ${total} บาท\n` +
    `รับเวลา / Pickup: ${pickup || '-'}` +
    (note ? `\nหมายเหตุ / Note: ${note}` : '') +
    `\n\nตอบ / Reply "รับ ${id}" หรือ / or "accept ${id}"`
  );

  return { ok: true, id: id, total: total };
}


// ========== Messages the shop owner sends to the LINE OA ==========
function handleLineEvent(ev) {
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = ev.message.text.trim();
  const userId = ev.source.userId;
  const admins = getAdmins();

  // First-time setup: owner types "ลงทะเบียน 5917" or "register 5917"
  const reg = text.match(/^(?:ลงทะเบียน|register)\s*(\S+)$/i);
  if (reg) {
    if (reg[1] !== props.getProperty('REGISTER_CODE')) return reply(ev.replyToken, 'รหัสไม่ถูกต้อง / Wrong code');
    if (!admins.includes(userId)) {
      admins.push(userId);
      props.setProperty('ADMIN_IDS', JSON.stringify(admins));
    }
    return reply(ev.replyToken, 'ลงทะเบียนแล้ว ✓ / Registered ✓\nออเดอร์ใหม่จะแจ้งมาที่นี่ / New orders will arrive here\n\n' + HELP_TEXT);
  }

  // Customers chatting with the shop: leave them to the shop's normal LINE chat.
  if (!admins.includes(userId)) return;

  // "รับ 12" / "accept 12" / "เสร็จ 12" / "ready 12" / "ยกเลิก 12" / "cancel 12"
  const cmd = text.match(/^(\S+)\s*#?(\d+)$/);
  const newStatus = cmd && COMMANDS[cmd[1].toLowerCase()];
  if (newStatus) {
    const found = setStatus(Number(cmd[2]), newStatus);
    return reply(ev.replyToken, found ? `#${cmd[2]} → ${newStatus} ✓` : `ไม่พบออเดอร์ / Order not found #${cmd[2]}`);
  }

  if (text === 'สรุป' || text.toLowerCase() === 'summary') return reply(ev.replyToken, buildSummary());

  return reply(ev.replyToken, HELP_TEXT);
}


// ========== Daily summary ==========
function buildSummary() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const rows = getSheet().getDataRange().getValues().slice(1);   // skip header

  const todays = rows.filter(r => r[COL.time - 1] instanceof Date &&
    Utilities.formatDate(r[COL.time - 1], TZ, 'yyyy-MM-dd') === today);
  const valid = todays.filter(r => r[COL.status - 1] !== STATUS.cancelled);
  const sales = valid.reduce((sum, r) => sum + Number(r[COL.total - 1]), 0);
  const pending = todays.filter(r => r[COL.status - 1] === STATUS.new || r[COL.status - 1] === STATUS.accepted);

  return `📊 สรุปวันนี้ / Today (${SHOP_NAME})\n` +
    `ออเดอร์ / Orders: ${valid.length}\n` +
    `ยอดขาย / Sales: ${sales.toLocaleString()} บาท` +
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
  return sheet;
}

function setStatus(id, status) {
  const sheet = getSheet();
  if (sheet.getLastRow() < 2) return false;
  const ids = sheet.getRange(2, COL.id, sheet.getLastRow() - 1).getValues().flat();
  const index = ids.indexOf(id);
  if (index === -1) return false;
  sheet.getRange(index + 2, COL.status).setValue(status);
  return true;
}

function getAdmins() {
  return JSON.parse(props.getProperty('ADMIN_IDS') || '[]');
}

// Push = the shop starts the message. Counts toward the LINE monthly free quota (1 per admin).
function pushToAdmins(text) {
  getAdmins().forEach(to => lineApi('push', { to: to, messages: [{ type: 'text', text: text }] }));
}

// Reply = answering the owner's message. Free, doesn't use the quota.
function reply(replyToken, text) {
  lineApi('reply', { replyToken: replyToken, messages: [{ type: 'text', text: text }] });
}

function lineApi(kind, payload) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + kind, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + props.getProperty('LINE_TOKEN') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) console.error('LINE error', res.getResponseCode(), res.getContentText());
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
