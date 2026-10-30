// AWS Lambda Web Functions reference architecture: Amazon CloudFront and private VPC access.
// The private resource in this example is Amazon Aurora PostgreSQL.
//
// Request path: viewer -> Amazon CloudFront (Origin Access Control signs the origin
// request) -> this Web Function (IamAuth endpoint) -> Lambda network connector ENIs ->
// Amazon Aurora PostgreSQL in private subnets.
//
// The app holds no database password. It connects as the least-privilege app_user with
// IAM database authentication: each new connection uses a 15-minute token signed locally
// with the execution role's credentials. Connections are TLS-encrypted and the server
// certificate is verified against the bundled Amazon RDS CA bundle.
//
// Each request records a visit and renders a page that confirms both hops: that it was
// served through CloudFront, and that it reached the private database.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

// Lambda provides the host:port to bind to. Bind both, or requests fail with a 502.
const [HOST, PORT] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:8080').split(':');
const APP_NAME = process.env.APP_NAME || 'sample-lambda-web-functions-cloudfront-private-vpc';
const { DB_HOST, DB_PORT = '5432', DB_NAME, DB_USER, DB_REGION } = process.env;

// https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
const RDS_CA = readFileSync(new URL('./global-bundle.pem', import.meta.url), 'utf8');

const signer = new Signer({
  hostname: DB_HOST,
  port: Number(DB_PORT),
  username: DB_USER,
  region: DB_REGION || process.env.AWS_REGION,
});

// One execution environment serves many concurrent requests, so share one small pool.
// The password is a function, so every new connection gets a fresh token; tokens only
// matter at connect time, so long-lived pooled connections keep working.
// Fleet-wide connections ~= pool max x endpoint MaxEnvironments (5 x 10 = 50).
const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  user: DB_USER,
  password: () => signer.getAuthToken(),
  ssl: { ca: RDS_CA, rejectUnauthorized: true },
  max: 5,
  idleTimeoutMillis: 30000,
  // The first connection from a new execution environment can take several seconds
  // while the network connector path warms up, so allow 10 seconds.
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => console.error('idle client error:', err.message));

// Map a database error to a short category for the page. The full message (which
// can include hostnames and authentication details) goes only to CloudWatch Logs,
// so anonymous viewers never see it.
function errorCategory(err) {
  const msg = `${err.code || ''} ${err.message || ''}`.toLowerCase();
  if (/pam|password|authentication|28p01|28000/.test(msg)) return 'Authentication failed';
  if (/certificate|self.signed|unable to verify|ssl|tls/.test(msg)) return 'TLS certificate error';
  if (/timeout|timed out|etimedout|econnrefused|enotfound|ehostunreach/.test(msg)) return 'Connection timeout';
  if (/permission denied|42501/.test(msg)) return 'Permission denied';
  return 'Other error (see CloudWatch Logs)';
}

const isTimeout = (err) => /timeout|timed out|etimedout/i.test(`${err.code || ''} ${err.message || ''}`);

// Retry once on a connection timeout before reporting an error to the visitor.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTimeout(err)) throw err;
    console.warn('database connection timed out, retrying once:', err.message);
    return fn();
  }
}

// CloudFront adds these headers to the origin request because the origin request
// policy lists them. City is URL-encoded (for example "S%C3%A3o%20Paulo").
function viewerLocation(headers) {
  const country = headers['cloudfront-viewer-country'];
  let city = headers['cloudfront-viewer-city'];
  try { if (city) city = decodeURIComponent(city); } catch {}
  return [city, country].filter(Boolean).join(', ') || null;
}

async function queryDatabase(location) {
  const started = Date.now();
  try {
    await withRetry(() => pool.query('INSERT INTO visits (viewer_location) VALUES ($1)', [location]));
    // Show only counts per location, never individual visits, so one visitor can't
    // see when or from where other people visited.
    const byLocation = await pool.query(
      `SELECT coalesce(viewer_location, 'Unknown') AS location, count(*) AS visits
         FROM visits GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`);
    const { rows } = await pool.query(
      `SELECT split_part(version(), ' ', 2) AS pg_version,
              (SELECT count(*) FROM visits) AS total_visits,
              current_user AS db_user,
              now() AS db_time`);
    return { ok: true, ms: Date.now() - started, byLocation: byLocation.rows, ...rows[0] };
  } catch (err) {
    console.error('database error:', err.code, err.message);
    return { ok: false, ms: Date.now() - started, error: errorCategory(err) };
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderPage({ viaCloudFront, cfId, location, db }) {
  const row = (k, v) => `<dt>${k}</dt><dd>${esc(v)}</dd>`;
  const edgeBlock = viaCloudFront
    ? `<span class="ok">Served through CloudFront</span>
       <dl>${row('Viewer location', location || 'not provided')}${row('CloudFront request ID', cfId)}</dl>`
    : `<span class="bad">Not served through CloudFront</span>
       <dl>${row('Note', 'No CloudFront request headers were found on this request')}</dl>`;
  const dbBlock = db.ok
    ? `<span class="ok">Connected to Aurora</span>
       <dl>${row('Engine', `PostgreSQL ${db.pg_version}`)}${row('Connected as', `${db.db_user} (IAM auth, TLS verified)`)}
           ${row('Total visits', db.total_visits)}${row('Database time', new Date(db.db_time).toISOString())}
           ${row('Round trip', `${db.ms} ms`)}</dl>
       <h3>Visits by location (top 5)</h3>
       <table><tr><th>Viewer location</th><th>Visits</th></tr>
       ${db.byLocation.map((r) => `<tr><td>${esc(r.location)}</td><td>${esc(r.visits)}</td></tr>`).join('')}
       </table>`
    : `<span class="bad">Database unreachable</span>
       <dl>${row('Reason', db.error)}${row('After', `${db.ms} ms`)}
           ${row('Details', 'Full error in the Web Function CloudWatch Logs')}</dl>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(APP_NAME)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:linear-gradient(135deg,#232f3e,#0f1b2d); padding:32px; }
  .card { width:100%; max-width:900px; background:#fff; border-radius:18px; overflow:hidden;
    box-shadow:0 24px 72px rgba(0,0,0,.35); }
  header { padding:40px 48px; background:linear-gradient(135deg,#ff9900,#ec7211); color:#1a1109; }
  header h1 { margin:0; font-size:36px; } header p { margin:10px 0 0; font-size:18px; }
  section { padding:28px 48px; border-top:1px solid #e3edf6; }
  h2 { margin:0 0 12px; font-size:15px; text-transform:uppercase; letter-spacing:.06em; color:#44515e; }
  .ok, .bad { font-size:26px; font-weight:700; }
  .ok { color:#1b7e3f; } .bad { color:#d13212; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:8px 24px; margin:14px 0 0; font-size:16px; }
  dt { font-weight:600; color:#232f3e; } dd { margin:0; font-family:ui-monospace,Menlo,monospace; color:#44515e; }
  h3 { margin:22px 0 8px; font-size:14px; color:#44515e; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid #e3edf6; }
  th { color:#232f3e; } td { font-family:ui-monospace,Menlo,monospace; color:#44515e; }
</style></head>
<body><div class="card">
  <header><h1>Hello from AWS!</h1>
    <p>Lambda Web Function behind CloudFront, reaching a private resource in your VPC (Aurora shown)</p></header>
  <section><h2>1. Edge</h2>${edgeBlock}</section>
  <section><h2>2. Private data</h2>${dbBlock}</section>
  <section><h2>Runtime</h2><dl>${row('App', APP_NAME)}${row('Listening on', `${HOST}:${PORT}`)}</dl></section>
</div></body></html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const cfId = req.headers['x-amz-cf-id'];
  const location = viewerLocation(req.headers);
  const db = await queryDatabase(location);
  res.writeHead(db.ok ? 200 : 503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(renderPage({ viaCloudFront: Boolean(cfId), cfId, location, db }));
});

server.listen(Number(PORT), HOST, () => {
  console.log(`[${APP_NAME}] listening on ${HOST}:${PORT}`);
  // Open one database connection as soon as the environment starts, so the first
  // visitor doesn't wait for the connector path to warm up. Failures are only logged;
  // requests still retry on their own.
  withRetry(() => pool.query('SELECT 1'))
    .then(() => console.log('database connection warmed'))
    .catch((err) => console.warn('database warm-up failed:', err.message));
});

// Close database connections cleanly when Lambda retires the environment.
process.on('SIGTERM', async () => {
  try { await pool.end(); } catch {}
  process.exit(0);
});
