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

## Commands in LINE (owner only, Thai or English)
- `รับ 12` / `accept 12`: accept order 12
- `เสร็จ 12` / `ready 12`: drink ready
- `ยกเลิก 12` / `cancel 12`: cancel
- `สรุป` / `summary`: today's sales and orders still pending
- `ลงทะเบียน <code>` / `register <code>`: become an owner (once)

## Limits to tell clients
- Each new order sends 1 LINE message per registered owner. LINE's free plan has a monthly limit (check the number in LINE OA Manager → plan). Replies to the owner's commands are free.
- Changed `Code.gs`? **Deploy → Manage deployments → Edit → New version**, or the old code keeps running.
- Keep `LINE_TOKEN` private. Never put it in the web page.
