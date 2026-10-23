const pg = require("pg");
require("dotenv").config({ path: ".env" });
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await c.connect();
  await c.query(
    `update event_config set
       state='ACTIVE_MARKET', paused=false, leaderboard_frozen=false,
       scheduled_end_at = now() + interval '365 days',
       api_freeze_at    = now() + interval '365 days',
       leaderboard_freeze_at = now() + interval '365 days'
     where id=true`,
  );
  const r = await c.query(
    "select state,paused,scheduled_end_at,api_freeze_at,leaderboard_freeze_at from event_config where id=true",
  );
  console.log(JSON.stringify(r.rows[0]));
  await c.end();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
