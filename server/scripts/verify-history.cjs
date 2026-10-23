const http = require("http");
function get(p) {
  return new Promise((r) => {
    http.get("http://localhost:4040" + p, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => { try { r(JSON.parse(b)); } catch { r({ raw: b }); } });
    }).on("error", (e) => r({ err: e.message }));
  });
}
(async () => {
  const status = await get("/api/market/status");
  console.log("state:", status.state, "lastT:", status.lastT, "startT:", status.datasetStartAt, "endT:", status.datasetEndAt);
  const now = Date.now();
  for (const res of ["1m", "5m", "15m", "1h"]) {
    const h = await get("/api/market/history?symbol=A&resolution=" + res);
    const bars = h.bars || [];
    const last = bars[bars.length - 1];
    const first = bars[0];
    const lastWall = last ? new Date(last.t).toISOString() : "n/a";
    const firstWall = first ? new Date(first.t).toISOString() : "n/a";
    const ageMin = last ? ((now - last.t) / 60000).toFixed(1) : "n/a";
    console.log(`[${res}] bars=${bars.length} lastWall=${lastWall} ageMin=${ageMin} firstWall=${firstWall}`);
  }
  const s1 = await get("/api/market/snapshot");
  await new Promise((r) => setTimeout(r, 500));
  const s2 = await get("/api/market/snapshot");
  const a1 = s1.prices && s1.prices.A, a2 = s2.prices && s2.prices.A;
  console.log("price A t0:", a1, "t+500ms:", a2, "changed?", a1 !== a2);
})();
