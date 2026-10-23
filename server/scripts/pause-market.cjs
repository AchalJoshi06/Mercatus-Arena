const pg = require("pg");
require("dotenv").config({ path: ".env" });
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await c.connect();
  await c.query(`update event_config set paused = true where id = true`);
  const r = await c.query(`select state, paused from event_config where id=true`);
  console.log("event_config:", JSON.stringify(r.rows[0]));
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
