/* Opening hours, shared by every style.
   Edit once here. 0 = Sunday. null = closed.
   Fills the element with id="hours" and marks today (Bangkok time). */
const HOURS = [null, [7, 16], [7, 16], [7, 16], [7, 16], [7, 16], [8, 14]];
const DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Bangkok", weekday: "short" }).format(new Date());
const today = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);

document.getElementById("hours").innerHTML = HOURS.map((h, i) => `
  <div class="hours-row ${i === today ? "today" : ""}">
    <span>${DAYS[i]}${i === today ? " (วันนี้)" : ""}</span>
    <span>${h ? `${h[0]}:00–${h[1]}:00` : "ปิด"}</span>
  </div>`).join("");
