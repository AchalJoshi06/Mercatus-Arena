const http = require("http");
function get(p) {
  return new Promise((r) => {
    http.get("http://localhost:4040" + p, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => { try { r(JSON.parse(b)); } catch { r({}); } });
    }).on("error", () => r({}));
  });
}
(async () => {
  // 1) market frozen?
  let prev = null, moves = 0;
  for (let i = 0; i < 4; i++) {
    const s = await get("/api/market/snapshot");
    const a = s.prices && s.prices.A;
    if (prev !== null && a !== prev) moves++;
    prev = a;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("market frozen check — price moves in ~2s:", moves, moves === 0 ? "(FROZEN ✓)" : "(STILL MOVING!)");
  // 2) history per resolution
  for (const res of ["1s", "5s", "30s", "1m", "5m", "15m", "1h"]) {
    const j = await get("/api/market/history?symbol=A&resolution=" + res + "&limit=20000");
    const b = j.bars || [];
    if (!b.length) { console.log(res.padStart(3), "EMPTY"); continue; }
    let holes = 0;
    const step = b[1].t - b[0].t;
    for (let i = 1; i < b.length; i++) if (b[i].t - b[i - 1].t > step * 3) holes++;
    const days = ((b[b.length - 1].t - b[0].t) / 86400000).toFixed(1);
    const ageSec = Math.round((Date.now() - b[b.length - 1].t) / 1000);
    console.log(
      res.padStart(3), "bars:", String(b.length).padStart(6),
      "| span:", (days + "d").padStart(6),
      "| big-holes:", holes,
      "| ends", ageSec + "s ago",
    );
  }
})();
