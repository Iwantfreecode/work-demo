/**
 * ระบบรับออเดอร์ร้าน: หน้าเว็บ → Google Sheets → แจ้งเตือน LINE
 * Order system: website form → Google Sheet → LINE alert to the shop.
 *
 * Paste this whole file into Extensions → Apps Script of a Google Sheet.
 * Then add 3 Script properties (Project Settings → Script properties):
 *   LINE_TOKEN     Channel access token from LINE Developers (Messaging API tab)
 *   WEBHOOK_KEY    any random text, e.g. kx81-mo2q. Also goes at the end of the webhook URL
 *   REGISTER_CODE  a code the shop owner types in LINE once, e.g. 4821
 * ADMIN_IDS is saved by the script itself when the owner registers.
 * Full steps: SETUP.md
 */

// ---------- 1. Settings you edit per shop ----------

// Prices live HERE, not in the web page. Anyone can edit a web page in their browser,
// so the script always recalculates the total from this list.
const MENU = {
  oliang:     { name: 'โอเลี้ยง',         price: 45 },
  icedcoffee: { name: 'กาแฟเย็นแก้วโหล',  price: 55 },
  icedlatte:  { name: 'ลาเต้เย็น',         price: 65 },
  hotlatte:   { name: 'ลาเต้ร้อน',         price: 60 },
  americano:  { name: 'อเมริกาโน่',        price: 55 },
  thaitea:    { name: 'ชาไทย',            price: 50 },
};

const SHOP_NAME = 'เหมือนเดิม';
const SUMMARY_HOUR = 21;          // daily summary at 21:00
const TZ = 'Asia/Bangkok';

// ---------- 2. Sheet layout ----------
const SHEET_NAME = 'Orders';
const HEADERS = ['เลขที่', 'เวลาสั่ง', 'ชื่อ', 'เบอร์โทร', 'รายการ', 'ยอดรวม', 'เวลารับ', 'หมายเหตุ', 'สถานะ'];
const COL = { id: 1, time: 2, status: 9 };   // column numbers we read or change later

const STATUS = { new: 'ใหม่', accepted: 'รับแล้ว', ready: 'พร้อมรับ', cancelled: 'ยกเลิก' };

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

  if (!name) return { ok: false, error: 'กรุณาใส่ชื่อ' };
  if (phone.length < 9 || phone.length > 10) return { ok: false, error: 'เบอร์โทรไม่ถูกต้อง' };

  // Rebuild the item list from MENU so prices can't be faked.
  const lines = [];
  let total = 0;
  (order.items || []).forEach(item => {
    const menuItem = MENU[item.id];
    const qty = Math.min(Math.max(parseInt(item.qty, 10) || 0, 0), 20);
    if (!menuItem || qty === 0) return;
    lines.push(`${menuItem.name} x${qty}`);
    total += menuItem.price * qty;
  });
  if (lines.length === 0) return { ok: false, error: 'ยังไม่ได้เลือกเมนู' };

  // One order per phone number every 30 seconds, so double-taps don't create two orders.
  const cache = CacheService.getScriptCache();
  if (cache.get('recent-' + phone)) return { ok: false, error: 'เพิ่งสั่งไป รอสักครู่แล้วลองใหม่' };
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
    `🧾 ออเดอร์ใหม่ #${id}\n` +
    `คุณ${name} ${formatPhone(phone)}\n` +
    lines.map(l => '• ' + l).join('\n') + '\n' +
    `รวม ${total} บาท\n` +
    `รับเวลา ${pickup || 'ไม่ระบุ'}` +
    (note ? `\nหมายเหตุ: ${note}` : '') +
    `\n\nตอบ "รับ ${id}" เพื่อยืนยัน`
  );

  return { ok: true, id: id, total: total };
}


// ========== Messages the shop owner sends to the LINE OA ==========
function handleLineEvent(ev) {
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = ev.message.text.trim();
  const userId = ev.source.userId;
  const admins = getAdmins();

  // First-time setup: owner types "ลงทะเบียน 4821"
  const reg = text.match(/^ลงทะเบียน\s*(\S+)$/);
  if (reg) {
    if (reg[1] !== props.getProperty('REGISTER_CODE')) return reply(ev.replyToken, 'รหัสไม่ถูกต้อง');
    if (!admins.includes(userId)) {
      admins.push(userId);
      props.setProperty('ADMIN_IDS', JSON.stringify(admins));
    }
    return reply(ev.replyToken, `ลงทะเบียนแล้ว ✓\nออเดอร์ใหม่จะแจ้งมาที่นี่\n\n${HELP_TEXT}`);
  }

  // Customers chatting with the shop: leave them to the shop's normal LINE chat.
  if (!admins.includes(userId)) return;

  // "รับ 12" / "เสร็จ 12" / "ยกเลิก 12"
  const cmd = text.match(/^(รับ|เสร็จ|ยกเลิก)\s*#?(\d+)$/);
  if (cmd) {
    const newStatus = { 'รับ': STATUS.accepted, 'เสร็จ': STATUS.ready, 'ยกเลิก': STATUS.cancelled }[cmd[1]];
    const found = setStatus(Number(cmd[2]), newStatus);
    return reply(ev.replyToken, found ? `#${cmd[2]} → ${newStatus} ✓` : `ไม่พบออเดอร์ #${cmd[2]}`);
  }

  if (text === 'สรุป') return reply(ev.replyToken, buildSummary());

  return reply(ev.replyToken, HELP_TEXT);
}

const HELP_TEXT =
  'คำสั่งที่ใช้ได้\n' +
  'รับ 12 = ยืนยันออเดอร์ #12\n' +
  'เสร็จ 12 = ชงเสร็จ พร้อมให้ลูกค้ารับ\n' +
  'ยกเลิก 12 = ยกเลิกออเดอร์\n' +
  'สรุป = ยอดวันนี้และออเดอร์ที่ยังค้าง';


// ========== Daily summary ==========
function buildSummary() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const rows = getSheet().getDataRange().getValues().slice(1);   // skip header

  const todays = rows.filter(r => r[COL.time - 1] instanceof Date &&
    Utilities.formatDate(r[COL.time - 1], TZ, 'yyyy-MM-dd') === today);
  const valid = todays.filter(r => r[COL.status - 1] !== STATUS.cancelled);
  const sales = valid.reduce((sum, r) => sum + Number(r[5]), 0);
  const pending = todays.filter(r => r[COL.status - 1] === STATUS.new || r[COL.status - 1] === STATUS.accepted);

  return `📊 สรุปวันนี้ (${SHOP_NAME})\n` +
    `ออเดอร์ ${valid.length} รายการ\n` +
    `ยอดขาย ${sales.toLocaleString()} บาท` +
    (pending.length ? `\nยังค้าง: ${pending.map(r => '#' + r[0]).join(' ')}` : '\nไม่มีออเดอร์ค้าง ✓');
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
  const ids = sheet.getRange(2, COL.id, Math.max(sheet.getLastRow() - 1, 1)).getValues().flat();
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
  pushToAdmins('ทดสอบ ✓ ระบบออเดอร์เชื่อมกับ LINE แล้ว');
}
