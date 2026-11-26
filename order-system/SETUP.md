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
- The sheet has a **Payment** column and a **Pickup sort key** column (used to sort the board). Old sheets get both headers added automatically.

## The order board (for a busy shop)
Tap **ออเดอร์ / Orders** in the bar at the bottom of the chat (the Rich menu below), or type `ออเดอร์` / `orders`. You get one list of every active order, soonest pickup first, with one button per order for its next step. The list refreshes after every tap. Tap the left side of a row to open the full card. Done and cancelled orders drop off. It shows 10 rows, then "N more".

Each tap also shows a short message like `✓ รับ #3` in the chat straight away, so the tap feels instant while the script answers. The script ignores those messages.

## Rich menu: the permanent bar at the bottom of the owner's chat
Two big buttons, **ออเดอร์ / Orders** and **สรุปวันนี้ / Today's summary**. It never covers a message. It is shown to owners only, so customers chatting with the shop never see it. It takes about 130px of the screen, and the owner can fold it away with the **เมนู / Menu** tab.

1. Make sure `richmenu.png` is online (it is in this repo, so GitHub Pages serves it a minute after a push).
2. In Apps Script pick `setupRichMenu` and press **Run** once. It uploads the menu and gives it to every registered owner. You don't need to redeploy for this.
3. New owners who register later get the bar automatically.
4. To take it away: run `removeRichMenu`. Running `setupRichMenu` again replaces the menu, it doesn't pile up copies.
5. To change colours or words: edit `richmenu-source.html`, screenshot it at exactly 2500 x 843, replace `richmenu.png`, push, run `setupRichMenu`.

If Run shows "Could not download the menu image", GitHub Pages isn't updated yet: wait a minute and run again. The shop's own menus made in LINE OA Manager are never touched.

## Typed commands (owner only, Thai or English, same result as the buttons)
- `รับ 12` / `accept 12`: accept order 12
- `เสร็จ 12` / `ready 12`: drink ready
- `รับแล้ว 12` / `picked 12`: customer picked up and paid
- `ยกเลิก 12` / `cancel 12`: cancel
- `ออเดอร์` / `orders`: the order board
- `สรุป` / `summary`: today's sales and orders still pending
- `ลงทะเบียน <code>` / `register <code>`: become an owner (once)

## Customize for each shop
Everything a shop might want to change is at the top of `Code.gs` (section 1) and the top of the script in `index.html`. Change the same numbers in both files.

| What | Where | Setting |
|---|---|---|
| Menu and prices | both files | `MENU` |
| Shop name | `Code.gs` | `SHOP_NAME` |
| Opening hours, last pickup | both | `OPEN_HOUR` / `CLOSE_HOUR` (page: `OPEN` / `CLOSE`) |
| Prep time for ASAP | both | `PREP_MIN` (page: `PREP`) |
| Days ahead, slot size | both | `DAYS_AHEAD`, `SLOT_MIN` (page: `SLOT`) |
| Daily summary time | `Code.gs` | `SUMMARY_HOUR`, then run `setupDailySummary` again |
| Card and button colour | `Code.gs` | `BRAND_COLOR` |
| Page colour | `index.html` | `--brand` in the CSS |
| Skip the "Accepted" step (New → Ready → Picked up) | `Code.gs` | `USE_ACCEPT_STEP = false` |
| Instant tap message `✓ รับ #3` | `Code.gs` | `TAP_ECHO` |
| Bottom bar (📋 Orders, 📊 Summary) | `Code.gs` | run `setupRichMenu` (on) or `removeRichMenu` (off) |
| Chips under every message (off by default, they float over the last message) | `Code.gs` | `QUICK_REPLIES` |
| Rows on the board | `Code.gs` | `BOARD_MAX` |

After changing `Code.gs`, redeploy (see the limits below). After changing `index.html`, push and regenerate `live.html`.

## Owner security
- The REGISTER_CODE works **once**. After someone registers, the script deletes it.
- To add staff: set a new `REGISTER_CODE` in Script properties, they register, it's deleted again. Existing owners get a ⚠️ alert.
- 5 wrong codes from one LINE user = ignored for an hour.
- To remove everyone: delete `ADMIN_IDS` in Script properties, then register again with a new code.

## Limits to tell clients
- Each new order sends 1 LINE message per registered owner. LINE's free plan has a monthly limit (check the number in LINE OA Manager → plan). Replies to the owner's commands and button taps are free.
- Changed `Code.gs`? **Deploy → Manage deployments → Edit → New version**, or the old code keeps running.
- Keep `LINE_TOKEN` private. Never put it in the web page.
