# Order system setup (about 20 minutes, on a laptop)

Website order form → Google Sheet → LINE message to the shop.

You need: a Google account, a LINE account.

---

## Part 1: LINE (10 min)

1. Go to **manager.line.biz** and log in with LINE. Create an Official Account (free plan).
2. In that account: **Settings → Messaging API → Enable Messaging API**. Create a provider when it asks (any name, e.g. your name).
3. Go to **developers.line.biz/console**, open the channel that was just made, tab **Messaging API**.
4. Scroll to **Channel access token** → **Issue**. Copy it somewhere safe. This is `LINE_TOKEN`.
5. Leave this tab open. You come back for the webhook in Part 3.

## Part 2: Google Sheet + script (5 min)

1. Make a new Google Sheet. Name it e.g. `Orders - เหมือนเดิม`.
2. **Extensions → Apps Script**. Delete what's there, paste all of `Code.gs`, press Save.
3. **Project Settings** (gear icon) → **Script properties** → add 3:

   | Property | Value |
   |---|---|
   | `LINE_TOKEN` | the token from Part 1 |
   | `WEBHOOK_KEY` | any random text, e.g. `kx81-mo2q` |
   | `REGISTER_CODE` | a short code, e.g. `4821` |

4. **Deploy → New deployment** → type **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Press Deploy, allow the permissions Google asks for, and copy the **Web app URL**.

## Part 3: Connect them (5 min)

1. Back in LINE Developers → Messaging API tab → **Webhook URL**:
   `<your Web app URL>?key=<your WEBHOOK_KEY>`
   Turn on **Use webhook**.
   (The **Verify** button may show an error because Apps Script answers with a redirect. That's a known quirk; test by sending a message instead.)
2. Add your Official Account as a friend in LINE (QR code on manager.line.biz).
3. In the chat, send: `ลงทะเบียน 4821` or `register 4821` (your REGISTER_CODE). It should reply "ลงทะเบียนแล้ว ✓ / Registered ✓".
4. In Apps Script, pick `testLineMessage` in the function menu and press **Run**. You should get "ทดสอบ ✓" in LINE.
5. Pick `setupDailySummary` and press **Run** once. Now you get a summary at 21:00 every day.

## Part 4: Turn on the order page

In `index.html`, set:
```js
const SCRIPT_URL = "<your Web app URL>";
```
Push to GitHub. Place a test order. You should see a new row in the sheet and a LINE message.

---

## Buttons in LINE (owner only)
Every new order arrives as a card with a big button for the next step:
**รับ / Accept** → **พร้อมรับ / Ready** → **รับแล้ว / Picked up**, plus a quiet **ยกเลิก / Cancel**.
- An order only moves forward. Tapping an old button again says "Can't do that now" and changes nothing.
- **Picked up** marks the order paid (everyone pays at the shop for now). Daily sales count only picked-up orders.
- If LINE ever refuses the card, the shop gets the same order as plain text with the typed command to reply.
- The sheet has a **Payment** column. Old sheets get its header added automatically.

## Typed commands (owner only, Thai or English, same result as the buttons)
- `รับ 12` / `accept 12`: accept order 12
- `เสร็จ 12` / `ready 12`: drink ready
- `รับแล้ว 12` / `picked 12`: customer picked up and paid
- `ยกเลิก 12` / `cancel 12`: cancel
- `สรุป` / `summary`: today's sales and orders still pending
- `ลงทะเบียน <code>` / `register <code>`: become an owner (once)

## Owner security
- The REGISTER_CODE works **once**. After someone registers, the script deletes it.
- To add staff: set a new `REGISTER_CODE` in Script properties, they register, it's deleted again. Existing owners get a ⚠️ alert.
- 5 wrong codes from one LINE user = ignored for an hour.
- To remove everyone: delete `ADMIN_IDS` in Script properties, then register again with a new code.

## Limits to tell clients
- Each new order sends 1 LINE message per registered owner. LINE's free plan has a monthly limit (check the number in LINE OA Manager → plan). Replies to the owner's commands and button taps are free.
- Changed `Code.gs`? **Deploy → Manage deployments → Edit → New version**, or the old code keeps running.
- Keep `LINE_TOKEN` private. Never put it in the web page.
