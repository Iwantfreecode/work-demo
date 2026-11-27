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

// How the LINE side looks and behaves
const BRAND_COLOR = '#24392D';    // card and button colour (the order page has its own --brand in its CSS)
const USE_ACCEPT_STEP = true;     // false = skip "Accepted": New → Ready → Picked up (good for small shops)
// "Order for later": the first alert only asks Accept / Cancel. A second alert comes LEAD_MIN minutes before pickup
// (07:00 order → alert at 06:45), and Ready / Picked up stay locked until then.
// It costs one extra LINE message per owner per later order. 0 = off: later orders alert once, like ASAP orders.
// After changing it: redeploy, then run setupStartAlerts once.
const LEAD_MIN = 15;
const TAP_ECHO = true;            // a button tap shows "✓ รับ #3" in the chat at once, before the answer arrives
// Shortcuts to 📋 Orders and 📊 Summary for the owner. Pick one:
//   'bar'   = permanent bar at the bottom of the chat (Rich menu). Never covers a message.
//   'chips' = floating buttons under each message (they cover the bottom of the last message)
//   'both'  or 'none'
// After changing it: redeploy, then run setupRichMenu once. It adds or removes the bar to match this choice.
const SHORTCUTS = 'bar';
const QUICK_REPLIES = SHORTCUTS === 'chips' || SHORTCUTS === 'both';
const BOARD_MAX = 10;             // rows shown on the order board

// Rich menu: a permanent bar (📋 Orders, 📊 Summary) at the bottom of the owner's chat. Set up once with setupRichMenu.
const RICH_MENU_NAME = 'owner-menu';
const RICH_MENU_IMAGE_URL = 'https://iwantfreecode.github.io/work-demo/order-system/richmenu.png';   // 2500x843 PNG, under 1 MB

// ---------- 2. Sheet layout ----------
const SHEET_NAME = 'Orders';
const HEADERS = ['เลขที่ / No.', 'เวลาสั่ง / Time', 'ชื่อ / Name', 'เบอร์โทร / Phone', 'รายการ / Items',
                 'ยอดรวม / Total', 'เวลารับ / Pickup', 'หมายเหตุ / Note', 'สถานะ / Status', 'การชำระเงิน / Payment',
                 'เวลารับ (ใช้เรียงลำดับ) / Pickup sort key', 'แจ้งเตือนเริ่มทำ (ระบบใช้) / Start alert (system)'];
const COL = { id: 1, time: 2, name: 3, phone: 4, items: 5, total: 6, pickup: 7, note: 8, status: 9, payment: 10, pickupAt: 11, alert: 12 };

// Last column: where a later order is in the two-alert flow. Empty = not a later order (or an old row).
const ALERT = {
  later: 'later',                  // waiting for its start time
  sent:  'sent',                   // start alert done
};

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

// Words that open the order board
const BOARD_WORDS = ['ออเดอร์', 'orders', 'board'];

// Messages starting with this are the "echo" of a button tap. We ignore them, the postback does the work.
const ECHO_MARK = '✓';

const HELP_TEXT =
  'คำสั่ง / Commands (หรือกดปุ่มในออเดอร์ / or tap the buttons)\n' +
  'รับ 12 / accept 12 = ยืนยันออเดอร์ / confirm order\n' +
  'เสร็จ 12 / ready 12 = พร้อมให้รับ / ready for pickup\n' +
  'รับแล้ว 12 / picked 12 = ลูกค้ารับแล้ว จ่ายแล้ว / picked up and paid\n' +
  'ยกเลิก 12 / cancel 12 = ยกเลิก / cancel\n' +
  'ออเดอร์ / orders = รายการที่ค้าง / active orders\n' +
  'สรุป / summary = ยอดวันนี้ / today\'s sales';

const LINE_API = 'https://api.line.me/v2/bot';
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

  // Later orders get two alerts: now (Accept / Cancel) and again LEAD_MIN minutes before pickup.
  // If the start time has already passed (ordering 10 minutes before a later slot), the first alert is the full one.
  let alert = '';
  if (LEAD_MIN > 0 && when.kind === 'later') alert = minusMinutes(when.at, LEAD_MIN) > now.key ? ALERT.later : ALERT.sent;

  // The lock makes sure two orders at the same moment don't get the same number.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let id;
  try {
    const sheet = getSheet();
    // A saved counter, not the row count, so deleting a row never repeats a number.
    id = Number(props.getProperty('LAST_ID') || 0) + 1;
    props.setProperty('LAST_ID', String(id));
    sheet.appendRow([id, new Date(), name, "'" + phone, lines.join('\n'), total, pickup, note, STATUS.new, PAY.atPickup, "'" + when.at, alert]);
  } finally {
    lock.releaseLock();
  }

  pushOrderCard({ id: id, name: name, phone: phone, items: lines, total: total, pickup: pickup, note: note,
                  status: STATUS.new, payment: PAY.atPickup, at: when.at, alert: alert });

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
  const today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  // key = 'yyyy-MM-dd HH:mm', the same shape as the sort key in the sheet, so times compare as plain text
  return { today: today, minutes: h * 60 + m, key: today + ' ' + hhmm(h * 60 + m) };
}

function nowKey() {
  return bangkokNow().key;
}

// 'yyyy-MM-dd HH:mm' minus some minutes, same shape back. Counts on a plain calendar (UTC), so zones can't shift it.
function minusMinutes(at, min) {
  const m = String(at).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return '';
  const iso = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - min * 60000).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
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
// Returns { ok: true, text, at } with the text for LINE and the sheet (at = 'yyyy-MM-dd HH:mm', used to sort the board), or { ok: false, error }.
function resolvePickup(pickup, today, nowMin) {
  const open = OPEN_HOUR * 60, close = CLOSE_HOUR * 60;
  const bad = { ok: false, error: 'เวลารับไม่ถูกต้อง รีเฟรชหน้าแล้วลองใหม่ / Invalid pickup time, please refresh and try again' };
  if (!pickup || typeof pickup !== 'object') return bad;

  if (pickup.type === 'asap') {
    if (nowMin < open || nowMin + PREP_MIN > close) {
      return { ok: false, error: `ร้านปิดแล้ว เลือก "สั่งล่วงหน้า" / Shop is closed, please choose "Order for later"` };
    }
    return { ok: true, kind: 'asap', text: `รับเลย / ASAP ~${hhmm(nowMin + PREP_MIN)}`, at: `${today} ${hhmm(nowMin + PREP_MIN)}` };
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
    return { ok: true, kind: 'later', at: `${pickup.date} ${hhmm(mins)}`,
             text: `${TH_DAYS[wd]} ${d} ${TH_MONTHS[mo]} / ${EN_DAYS[wd]} ${d} ${EN_MONTHS[mo]} ${hhmm(mins)}` };
  }

  return bad;
}


// ========== Messages the shop owner sends to the LINE OA ==========
function handleLineEvent(ev) {
  // A button tap on an order card
  if (ev.type === 'postback') return handlePostback(ev);
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = ev.message.text.trim();
  if (text.startsWith(ECHO_MARK)) return;            // echo of a button tap, already handled as a postback
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

  if (BOARD_WORDS.includes(text.toLowerCase())) return replyBoard(ev.replyToken, '');
  if (text === 'สรุป' || text.toLowerCase() === 'summary') return reply(ev.replyToken, buildSummary());

  return reply(ev.replyToken, HELP_TEXT);
}


// Button data looks like "accept:12" (or "accept:12:b" from the board). Only registered owners can use the buttons.
function handlePostback(ev) {
  if (!getAdmins().includes(ev.source.userId)) return;
  const m = String(ev.postback.data).match(/^(accept|ready|picked|cancel|view):(\d+)(:b)?$/);   // ":b" = tapped on the board
  if (!m) return;
  const id = Number(m[2]);
  if (m[1] === 'view') {
    const found = findOrder(id);
    return found ? replyCard(ev.replyToken, found.order) : reply(ev.replyToken, `ไม่พบออเดอร์ / Order not found #${id}`);
  }
  runAction(ev.replyToken, m[1], id, Boolean(m[3]));
}

// Same path for typed commands and button taps: change the order, then answer with the new card (or the refreshed board).
function runAction(replyToken, action, id, fromBoard) {
  const result = applyAction(action, id);
  if (fromBoard) return replyBoard(replyToken, result.order ? '' : result.text);     // the board refreshes after every tap
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
  linkRichMenu(userId);                             // the new owner gets the bottom bar too

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
      : '\nไม่มีออเดอร์ค้าง / Nothing pending ✓') +
    quotaLine();
}

// How much of LINE's monthly free message limit is used. Alerts count, replies don't. Empty if LINE doesn't answer
// or the account has no limit.
function quotaLine() {
  try {
    const limit = JSON.parse(lineCall('get', LINE_API + '/message/quota').text);
    const used = JSON.parse(lineCall('get', LINE_API + '/message/quota/consumption').text);
    if (limit.type !== 'limited' || typeof used.totalUsage !== 'number') return '';
    const warn = used.totalUsage >= limit.value * 0.8 ? '  ⚠️ ใกล้เต็ม / almost full' : '';
    return `\nข้อความ LINE เดือนนี้ / LINE messages this month: ${used.totalUsage}/${limit.value}${warn}`;
  } catch (err) {
    return '';
  }
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


// ========== Start alerts for "order for later" ==========
// A timer runs sendStartAlerts every 5 minutes. For each later order whose start time (pickup minus LEAD_MIN) has come,
// it sends the card again with the Ready button unlocked, then marks the row "sent" so it never repeats.
// Apps Script timers are not exact: an alert can come a few minutes late, so keep LEAD_MIN at 10 or more.
function sendStartAlerts() {
  if (LEAD_MIN <= 0) return;
  const now = bangkokNow();
  if (now.minutes < OPEN_HOUR * 60 - LEAD_MIN || now.minutes > CLOSE_HOUR * 60) return;    // nothing can be due outside shop hours

  // Same lock as button taps, so two timer runs (or a tap) can't send the same alert twice.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
    const last = sheet.getLastRow();
    if (last < 2) return;
    const first = Math.max(2, last - 199);
    sheet.getRange(first, 1, last - first + 1, COL.alert).getValues().forEach((r, i) => {
      if (r[COL.alert - 1] !== ALERT.later) return;
      const o = rowToOrder(r);
      if (isWaiting(o, now.key)) return;                                     // not time yet
      const closed = o.status === STATUS.picked || o.status === STATUS.cancelled;
      // If LINE refused every owner, leave the row as it is and try again in 5 minutes.
      if (!closed && pushOrderCard(Object.assign({}, o, { startNow: true })) === 0) return;
      sheet.getRange(first + i, COL.alert).setValue(ALERT.sent);
    });
  } finally {
    lock.releaseLock();
  }
}

// Run this ONE time from the Apps Script editor (and again after changing LEAD_MIN).
function setupStartAlerts() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendStartAlerts')
    .forEach(t => ScriptApp.deleteTrigger(t));
  if (LEAD_MIN <= 0) { console.log('LEAD_MIN is 0: start alerts are off, timer removed.'); return; }
  ScriptApp.newTrigger('sendStartAlerts').timeBased().everyMinutes(5).create();
  console.log('Start alerts on: checking every 5 minutes, ' + LEAD_MIN + ' minutes before pickup.');
}


// ========== Rich menu (permanent bottom bar for owners) ==========
// Only owners get it: it is linked to each owner one by one, so customers chatting with the shop never see it.
// Run setupRichMenu once from the editor, after richmenu.png is online. Run it again to replace the menu.
// (It follows the SHORTCUTS setting: with 'chips' or 'none' it removes the bar instead.)
// Run removeRichMenu to take it away.
function setupRichMenu() {
  if (!['bar', 'chips', 'both', 'none'].includes(SHORTCUTS)) throw new Error('SHORTCUTS must be bar, chips, both or none (it is "' + SHORTCUTS + '")');
  if (SHORTCUTS === 'chips' || SHORTCUTS === 'none') {
    removeRichMenu();                               // make the chat match the choice: no bar
    console.log('SHORTCUTS is "' + SHORTCUTS + '": no bottom bar. Removed it if it was there.');
    return;
  }

  // Download the image first, so a missing image fails before anything is changed.
  const image = UrlFetchApp.fetch(RICH_MENU_IMAGE_URL, { muteHttpExceptions: true });
  if (image.getResponseCode() !== 200) {
    throw new Error('Could not download the menu image from ' + RICH_MENU_IMAGE_URL + '. Is GitHub Pages updated yet? Wait a minute and run again.');
  }

  removeRichMenu();                                 // so running twice doesn't pile up old menus
  const created = lineCall('post', LINE_API + '/richmenu', {
    size: { width: 2500, height: 843 }, selected: true, name: RICH_MENU_NAME, chatBarText: 'เมนู / Menu',
    areas: [
      { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: { type: 'message', label: 'ออเดอร์ / Orders', text: 'ออเดอร์' } },
      { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: 'message', label: 'สรุป / Summary', text: 'สรุป' } },
    ],
  });
  if (!created.ok) throw new Error('LINE refused the menu: ' + created.text);
  const id = JSON.parse(created.text).richMenuId;

  const uploaded = lineCall('post', 'https://api-data.line.me/v2/bot/richmenu/' + id + '/content', image.getBlob().getBytes(), 'image/png');
  if (!uploaded.ok) throw new Error('LINE refused the image (it must be PNG or JPEG, 2500x843, under 1 MB): ' + uploaded.text);

  props.setProperty('RICH_MENU_ID', id);
  getAdmins().forEach(linkRichMenu);
  console.log('Rich menu ready for ' + getAdmins().length + ' owner(s).');
}

// Deletes only the menu this script made (by name). Deleting it also removes it from every owner.
function removeRichMenu() {
  const list = lineCall('get', LINE_API + '/richmenu/list');
  if (!list.ok) throw new Error('Could not read the menu list from LINE: ' + list.text);
  JSON.parse(list.text).richmenus
    .filter(m => m.name === RICH_MENU_NAME)
    .forEach(m => lineCall('delete', LINE_API + '/richmenu/' + m.richMenuId));
  props.deleteProperty('RICH_MENU_ID');
}

function linkRichMenu(userId) {
  const id = props.getProperty('RICH_MENU_ID');
  if (id) lineCall('post', `${LINE_API}/user/${userId}/richmenu/${id}`);
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
  // Sheets made before the Payment / sort-key / start-alert columns existed get those headers added once.
  // Checked at most every 6 hours, so a button tap doesn't spend time on it.
  const cache = CacheService.getScriptCache();
  if (!cache.get('headers-ok-2')) {
    if (sheet.getMaxColumns() < COL.alert) sheet.insertColumnsAfter(sheet.getMaxColumns(), COL.alert - sheet.getMaxColumns());
    [COL.payment, COL.pickupAt, COL.alert].forEach(c => {
      if (!sheet.getRange(1, c).getValue()) sheet.getRange(1, c).setValue(HEADERS[c - 1]).setFontWeight('bold');
    });
    cache.put('headers-ok-2', '1', 21600);
  }
  return sheet;
}

// Google Sheets quietly turns text that looks like a date into a real date. Turn it back so the board can read it.
function cellText(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v || '');
}

// One sheet row → the order object the cards and the board use.
function rowToOrder(r) {
  return {
    id: Number(r[COL.id - 1]),
    time: r[COL.time - 1],
    name: String(r[COL.name - 1]),
    phone: String(r[COL.phone - 1]),
    items: String(r[COL.items - 1]).split('\n'),
    total: r[COL.total - 1],
    pickup: String(r[COL.pickup - 1]),
    note: String(r[COL.note - 1]),
    status: r[COL.status - 1],
    payment: r[COL.payment - 1] || PAY.atPickup,       // rows from before the Payment column
    at: cellText(r[COL.pickupAt - 1]),                 // 'yyyy-MM-dd HH:mm', empty on old rows
    alert: String(r[COL.alert - 1] || ''),             // '' / 'later' / 'sent', see ALERT
  };
}

// The moment a later order's start alert is due ('yyyy-MM-dd HH:mm'), or '' for orders without one.
function startKey(o) {
  return o.alert === ALERT.later ? minusMinutes(o.at, LEAD_MIN) : '';
}

// A later order that hasn't reached its start time yet: Ready and Picked up are locked.
function isWaiting(o, key) {
  const start = startKey(o);
  return LEAD_MIN > 0 && start !== '' && start > key;
}

// The next step an order can take right now. null = nothing to tap (finished, or a later order that is still waiting;
// a waiting order that isn't accepted yet can still be accepted).
function stepFor(o, key) {
  if (!isWaiting(o, key)) return nextStep(o.status);
  return o.status === STATUS.new && USE_ACCEPT_STEP ? nextStep(o.status) : null;
}

// Find one order by its number (reads only that row). Returns { row, order } or null.
function findOrder(id) {
  const sheet = getSheet();
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const ids = sheet.getRange(2, COL.id, last - 1, 1).getValues();       // only the number column
  let row = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    if (Number(ids[i][0]) === id) { row = i + 2; break; }
  }
  if (!row) return null;
  return { row: row, order: rowToOrder(sheet.getRange(row, 1, 1, COL.alert).getValues()[0]) };
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
    // A later order can't be made Ready or Picked up before its start time (an old card might still show the button).
    if ((action === 'ready' || action === 'picked') && isWaiting(order, nowKey())) {
      const start = shortPickup({ at: startKey(order) }, bangkokNow().today);
      return { text: `#${id} ยังไม่ถึงเวลาเริ่มทำ (${start}) / Too early, opens at ${start}` };
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


// ========== The order board (all active orders in one list) ==========
// For a busy shop: one list, soonest pickup first, one tap per order. It refreshes after every tap,
// so the owner never has to scroll back through old cards.
function activeOrders() {
  const sheet = getSheet();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const first = Math.max(2, last - 199);                    // the newest 200 rows are plenty
  const key = o => o.at || (o.time instanceof Date ? Utilities.formatDate(o.time, TZ, 'yyyy-MM-dd HH:mm') : '');
  return sheet.getRange(first, 1, last - first + 1, COL.alert).getValues()
    .filter(r => RANK[r[COL.status - 1]] !== undefined && RANK[r[COL.status - 1]] < RANK[STATUS.picked])
    .map(rowToOrder)
    .sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id);
}

// "07:00" for today, "2/12 14:45" for another day
function shortPickup(o, today) {
  if (!o.at) return '-';
  return o.at.slice(0, 10) === today ? o.at.slice(11) : `${+o.at.slice(8, 10)}/${+o.at.slice(5, 7)} ${o.at.slice(11)}`;
}

function boardMessage(orders) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const now = Utilities.formatDate(new Date(), TZ, 'HH:mm');
  const text = (t, extra) => Object.assign({ type: 'text', text: String(t), size: 'md', color: '#222222' }, extra);

  // Later orders that haven't reached their start time sit in their own group at the bottom, with no Ready button.
  const key = nowKey();
  const waiting = o => isWaiting(o, key);
  const working = orders.filter(o => !waiting(o));
  const later = orders.filter(waiting);

  const counts = [[STATUS.new, 'ใหม่', 'New'], [STATUS.accepted, 'ยืนยันแล้ว', 'Accepted'], [STATUS.ready, 'พร้อมรับ', 'Ready']]
    .map(([st, th, en]) => ({ n: working.filter(o => o.status === st).length, th: th, en: en })).filter(c => c.n > 0);
  if (later.length) counts.push({ n: later.length, th: 'ล่วงหน้า', en: 'Later' });

  const row = o => {
    const step = stepFor(o, key);
    const cups = o.items.reduce((sum, l) => sum + Number((l.match(/x(\d+)$/) || [0, 1])[1]), 0);
    const name = o.name.length > 12 ? o.name.slice(0, 11) + '…' : o.name;
    const box = { type: 'box', layout: 'vertical', width: '96px', height: '48px', justifyContent: 'center', alignItems: 'center', cornerRadius: '8px' };
    const right = step
      ? Object.assign(box, { backgroundColor: BRAND_COLOR,
          action: tapAction(`${step.th} / ${step.en}`, `${step.action}:${o.id}:b`, `${ECHO_MARK} ${step.th} #${o.id}`),
          contents: [ text(step.th, { weight: 'bold', color: '#FFFFFF', align: 'center' }),
                      text(step.en, { size: 'sm', color: '#DCE5DF', align: 'center' }) ] })
      // nothing to tap yet: show when the start alert comes
      : Object.assign(box, { borderWidth: '1px', borderColor: '#D0D0D0',
          contents: [ text('⏰ ' + shortPickup({ at: startKey(o) }, today), { size: 'sm', weight: 'bold', color: '#555555', align: 'center', wrap: false }),
                      text('เริ่มทำ / Start', { size: 'xs', color: '#707070', align: 'center', wrap: false }) ] });
    return { type: 'box', layout: 'horizontal', spacing: '12px', alignItems: 'center', contents: [
      // tapping the left side opens the full card
      { type: 'box', layout: 'vertical', flex: 1, spacing: '4px', justifyContent: 'center',
        action: tapAction('ดู / View', `view:${o.id}`, `${ECHO_MARK} ดู #${o.id}`), contents: [
          text(`#${o.id}  ${name}`, { weight: 'bold', wrap: false }),
          text(`${shortPickup(o, today)} · ${cups} แก้ว · ฿${o.total}`, { size: 'sm', color: '#707070', wrap: false }) ] },
      right,
    ] };
  };

  const body = [];
  const shown = working.concat(later).slice(0, BOARD_MAX);
  shown.forEach((o, i) => {
    if (i) body.push({ type: 'separator' });
    if (waiting(o) && (i === 0 || !waiting(shown[i - 1]))) body.push(text('ล่วงหน้า / Later', { size: 'sm', weight: 'bold', color: '#707070' }));
    body.push(row(o));
  });
  const rows = shown;
  if (!rows.length) body.push(text('ไม่มีออเดอร์ค้าง / Nothing pending ✓', { weight: 'bold' }));
  if (orders.length > BOARD_MAX) {
    body.push(text(`อีก ${orders.length - BOARD_MAX} ออเดอร์ ทำรายการข้างบนก่อน / ${orders.length - BOARD_MAX} more, finish the top ones first`,
                   { size: 'sm', color: '#707070', wrap: true }));
  }

  const header = [ text('ออเดอร์ที่ค้าง / Active orders', { size: 'lg', weight: 'bold', color: '#FFFFFF' }) ];
  if (counts.length) {
    header.push(text(counts.map(c => `${c.th} ${c.n}`).join(' · '), { size: 'sm', color: '#DCE5DF' }));
    header.push(text(counts.map(c => `${c.en} ${c.n}`).join(' · '), { size: 'sm', color: '#DCE5DF' }));
  }
  return { type: 'flex', altText: `📋 ออเดอร์ที่ค้าง / Active orders: ${orders.length}`, contents: { type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: BRAND_COLOR, paddingAll: '16px', spacing: '4px', contents: header },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: '12px', contents: body },
    // With the chips on, LINE draws them over the bottom ~45px of the last message. This strip sits under
    // the last button so the chips cover it, not a button. It also shows how fresh the list is.
    footer: { type: 'box', layout: 'vertical', height: QUICK_REPLIES ? '56px' : '40px', justifyContent: 'center', paddingStart: '16px', paddingEnd: '16px',
              contents: [ text(`อัปเดต ${now} / Updated ${now}`, { size: 'sm', color: '#707070' }) ] } } };
}

// Plain text version of the board, if LINE ever refuses the card.
function boardText(orders) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (!orders.length) return 'ไม่มีออเดอร์ค้าง / Nothing pending ✓';
  return '📋 ออเดอร์ที่ค้าง / Active orders\n' +
    orders.slice(0, BOARD_MAX).map(o => `#${o.id} ${o.name} · ${shortPickup(o, today)} · ฿${o.total} · ${o.status}`).join('\n');
}


// ========== The order card (buttons in LINE) ==========
// One card is used for the new-order alert and for every answer after a tap,
// so the order always looks the same and shows only the next step.
// o.startNow = this is the "time to start" alert for a later order, not the first alert.
function orderText(o) {
  const title = o.startNow ? '⏰ ถึงเวลาเริ่มทำ / Time to start' : (o.status === STATUS.new ? 'ออเดอร์ใหม่ / New order' : 'ออเดอร์ / Order');
  const key = nowKey();
  return `🧾 ${title} #${o.id} · ${o.status}\n` +
    `${o.name} ${formatPhone(o.phone)}\n` +
    o.items.map(l => '• ' + l).join('\n') + '\n' +
    `รวม / Total: ${o.total} บาท\n` +
    `รับเวลา / Pickup: ${o.pickup || '-'}\n` +
    (isWaiting(o, key) ? `เริ่มทำ / Start: ${shortPickup({ at: startKey(o) }, bangkokNow().today)} (แจ้งอีกครั้ง / alert again)\n` : '') +
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
  if (isWaiting(o, nowKey())) body.push(field('เริ่มทำ / Start (แจ้งอีกครั้ง / alert again)', shortPickup({ at: startKey(o) }, bangkokNow().today)));
  if (o.note) body.push(field('หมายเหตุ / Note', o.note));
  body.push(field('การชำระเงิน / Payment', o.payment));

  const bubble = {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: BRAND_COLOR, paddingAll: '16px', spacing: '4px', contents: [
      text(`ออเดอร์ #${o.id} / Order #${o.id}`, { size: 'lg', weight: 'bold', color: '#FFFFFF' }),
      text(o.status, { size: 'sm', color: '#DCE5DF' }) ].concat(o.startNow ? [
      text(o.status === STATUS.new && USE_ACCEPT_STEP ? '⏰ ถึงเวลาเริ่มทำ · ยังไม่ได้ยืนยัน / Time to start · not accepted yet' : '⏰ ถึงเวลาเริ่มทำ / Time to start',
           { size: 'sm', weight: 'bold', color: '#FFFFFF' }) ] : []) },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: '12px', contents: body },
  };
  const buttons = cardButtons(o);
  if (buttons.length) bubble.footer = { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: '8px', contents: buttons };

  return { type: 'flex', altText: orderText(o).slice(0, 400), contents: bubble };     // altText = the lock-screen preview
}

// The one next step for an order, or null when it is finished. Small shops can skip "Accepted" (USE_ACCEPT_STEP).
function nextStep(status) {
  const accept = { action: 'accept', th: 'รับ', en: 'Accept' };
  const ready = { action: 'ready', th: 'พร้อมรับ', en: 'Ready' };
  const picked = { action: 'picked', th: 'รับแล้ว', en: 'Picked up' };
  if (status === STATUS.new) return USE_ACCEPT_STEP ? accept : ready;
  if (status === STATUS.accepted) return ready;
  if (status === STATUS.ready) return picked;
  return null;
}

// A postback = a button tap LINE sends to our webhook. displayText makes the tap show up in the chat at once.
function tapAction(label, data, echo) {
  const action = { type: 'postback', label: label, data: data };
  if (TAP_ECHO) action.displayText = echo;
  return action;
}

// One big main button for the next step, one quiet Cancel. Nothing after Picked up / Cancelled.
// A later order that is still waiting for its start time gets only Accept (if new) and Cancel.
function cardButtons(o) {
  if (o.status === STATUS.picked || o.status === STATUS.cancelled) return [];
  const step = stepFor(o, nowKey());
  const cancel = cardButton('ยกเลิก / Cancel', `cancel:${o.id}`, false, `${ECHO_MARK} ยกเลิก #${o.id}`);
  return step
    ? [ cardButton(`${step.th} / ${step.en}`, `${step.action}:${o.id}`, true, `${ECHO_MARK} ${step.th} #${o.id}`), cancel ]
    : [ cancel ];
}

// A tappable box (48px tall, easy to hit) instead of LINE's thinner standard button.
function cardButton(label, data, primary, echo) {
  const box = {
    type: 'box', layout: 'vertical', height: '48px', justifyContent: 'center', alignItems: 'center', cornerRadius: '8px',
    action: tapAction(label, data, echo),
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

// Order alert with buttons (the first alert, or the start alert for a later order). If LINE refuses the card for any
// reason, send the plain text version instead, so the shop never misses an order.
// Returns how many owners got a message (0 = nobody, the caller may try again).
const TYPED = { accept: ['รับ', 'accept'], ready: ['เสร็จ', 'ready'], picked: ['รับแล้ว', 'picked'] };
function pushOrderCard(o) {
  const step = stepFor(o, nowKey());
  const hint = step ? `\n\nตอบ / Reply "${TYPED[step.action][0]} ${o.id}" หรือ / or "${TYPED[step.action][1]} ${o.id}"` : '';
  let delivered = 0;
  getAdmins().forEach(to => {
    if (lineApi('push', { to: to, messages: [orderCard(o)] }) ||
        lineApi('push', { to: to, messages: [{ type: 'text', text: orderText(o) + hint }] })) delivered++;
  });
  return delivered;
}

// Reply = answering the owner's message. Free, doesn't use the quota.
function reply(replyToken, messages) {
  const list = typeof messages === 'string' ? [{ type: 'text', text: messages }] : messages;
  lineApi('reply', { replyToken: replyToken, messages: list });
}

// Answer with the board (and a short text first when something was refused).
function replyBoard(replyToken, note) {
  const orders = activeOrders();
  const messages = note ? [{ type: 'text', text: note }] : [];
  messages.push(boardMessage(orders));
  if (!lineApi('reply', { replyToken: replyToken, messages: messages })) {
    reply(replyToken, [note, boardText(orders)].filter(Boolean).join('\n\n'));
  }
}

function replyCard(replyToken, o) {
  if (!lineApi('reply', { replyToken: replyToken, messages: [orderCard(o)] })) reply(replyToken, `#${o.id} → ${o.status} ✓`);
}

// Shortcut chips LINE shows under the last message
const CHIPS = { items: [
  { type: 'action', action: { type: 'message', label: '📋 ออเดอร์ / Orders', text: 'ออเดอร์' } },
  { type: 'action', action: { type: 'message', label: '📊 สรุป / Summary', text: 'สรุป' } },
] };

// Returns true when LINE accepted the message.
function lineApi(kind, payload) {
  if (QUICK_REPLIES) payload.messages[payload.messages.length - 1].quickReply = CHIPS;
  return lineCall('post', `${LINE_API}/message/${kind}`, payload).ok;
}

// Every call to LINE goes through here. Leave body out for calls without one; pass bytes + contentType for images.
function lineCall(method, url, body, contentType) {
  const options = { method: method, headers: { Authorization: 'Bearer ' + props.getProperty('LINE_TOKEN') }, muteHttpExceptions: true };
  if (body !== undefined) {
    options.contentType = contentType || 'application/json';
    options.payload = contentType ? body : JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch(url, options);
  const ok = res.getResponseCode() === 200;
  if (!ok) console.error('LINE error', res.getResponseCode(), res.getContentText());
  return { ok: ok, text: res.getContentText() };
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
