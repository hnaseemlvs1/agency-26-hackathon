// precompute-heatmap.js — produce heatmap-data.json from real data.
//
// Aggregates fed.grants_contributions + ab.ab_grants + ab.ab_sole_source by
// 12 verticals x 8 quarters (calendar quarters, Apr-2024 → Mar-2026).
//
// Each vertical runs as a separate query so a single timeout doesn't take out
// the whole pre-compute. Output is saved to heatmap-data.json next to this
// file; mock-server.js + intelligence-server.js read it at boot and fall back
// to an inline seed if it's missing.
//
// Run from general/: node visualizations/precompute-heatmap.js

const path = require('path');
const fs   = require('fs');

const envPublic = path.join(__dirname, '..', '.env.public');
const envLocal  = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPublic)) require('dotenv').config({ path: envPublic });
if (fs.existsSync(envLocal))  require('dotenv').config({ path: envLocal, override: true });

const { Pool } = require('pg');

const QUARTERS = ['Q2-24','Q3-24','Q4-24','Q1-25','Q2-25','Q3-25','Q4-25','Q1-26'];
const QTR_MAP = { 'Q2-24':[2024,2], 'Q3-24':[2024,3], 'Q4-24':[2024,4], 'Q1-25':[2025,1], 'Q2-25':[2025,2], 'Q3-25':[2025,3], 'Q4-25':[2025,4], 'Q1-26':[2026,1] };

// Vertical → tsquery (used against the GIN tsvector index on fed.prog_name_en),
// plus an ILIKE list (used against ab program/ministry text without indexes).
const VERTICALS = [
  { name: 'Health & Mental Health',
    tsq: 'health | mental | hospital | clinic | medical | nursing | wellness | psychiatry | psychology | addiction | suicide',
    ilikes: ['%health%','%mental%','%hospital%','%clinic%','%medical%','%nursing%','%wellness%','%psychiatr%','%psycholog%','%addiction%'] },
  { name: 'Indigenous Programs',
    tsq: 'indigenous | aboriginal | inuit | metis | reconciliation | treaty | first',
    ilikes: ['%indigenous%','%aboriginal%','%inuit%','%metis%','%reconciliation%','%treaty%','%first nation%'] },
  { name: 'Housing & Shelter',
    tsq: 'housing | shelter | homeless | rental | affordable',
    ilikes: ['%housing%','%shelter%','%homeless%','%rental%','%affordable home%'] },
  { name: 'Education & Research',
    tsq: 'education | school | university | college | scholarship | research | learning | literacy',
    ilikes: ['%education%','%school%','%university%','%college%','%scholarship%','%research%','%learning%','%literacy%'] },
  { name: 'Environment & Climate',
    tsq: 'environment | climate | conservation | biodiversity | wildlife | ecosystem | carbon | renewable | emissions',
    ilikes: ['%environment%','%climate%','%conservation%','%biodivers%','%wildlife%','%ecosystem%','%carbon%','%renewable%','%emissions%'] },
  { name: 'Defense & Security',
    tsq: 'defence | defense | security | cyber | military | nato | intelligence | police',
    ilikes: ['%defence%','%defense%','%security%','%cyber%','%military%','%intelligence%','%police%'] },
  { name: 'Infrastructure',
    tsq: 'infrastructure | transit | water | broadband | road | bridge | transport | sewer | highway',
    ilikes: ['%infrastructure%','%transit%','%water%','%broadband%','%road%','%bridge%','%transport%','%sewer%','%highway%'] },
  { name: 'Arts & Culture',
    tsq: 'arts | culture | museum | festival | heritage | music | film | gallery | theatre',
    ilikes: ['%arts%','%culture%','%museum%','%festival%','%heritage%','%music%','%film%','%gallery%','%theatre%'] },
  { name: 'Economic Development',
    tsq: 'innovation | entrepreneur | economic | startup | enterprise | productivity | trade | business',
    ilikes: ['%innovation%','%entrepreneur%','%economic%','%startup%','%enterprise%','%productivity%','%trade%','%small business%'] },
  { name: 'Justice & Legal Aid',
    tsq: 'justice | legal | court | victim | prosecution | parole | criminal',
    ilikes: ['%justice%','%legal aid%','%court%','%victim%','%prosecut%','%parole%','%criminal%'] },
  { name: 'Agriculture & Food',
    tsq: 'agriculture | farm | food | livestock | crop | fisheries | dairy | grain',
    ilikes: ['%agricultur%','%farm%','%food security%','%livestock%','%crop%','%fisher%','%dairy%','%grain%'] },
  { name: 'International Aid',
    tsq: 'international | foreign | development | humanitarian | refugee | peacekeeping',
    ilikes: ['%international%','%foreign aid%','%humanitarian%','%peacekeep%'] }
];

const PER_VERTICAL_TIMEOUT_MS = 90000; // 90s per vertical

function emptyAmounts() { return QUARTERS.map(() => 0); }
function quarterIdx(yr, qtr) {
  const label = `Q${qtr}-${String(yr).slice(2)}`;
  return QUARTERS.indexOf(label);
}

async function aggregateFed(client, vertical) {
  const sql = `
    SELECT
      EXTRACT(YEAR FROM agreement_start_date)::int AS yr,
      EXTRACT(QUARTER FROM agreement_start_date)::int AS qtr,
      SUM(agreement_value)::numeric AS amt
    FROM fed.grants_contributions
    WHERE agreement_start_date >= '2024-04-01'
      AND agreement_start_date < '2026-04-01'
      AND coalesce(agreement_value, 0) > 0
      AND coalesce(is_amendment, false) = false
      AND to_tsvector('english', coalesce(prog_name_en, '')) @@ to_tsquery('english', $1)
    GROUP BY yr, qtr;
  `;
  const r = await client.query(sql, [vertical.tsq]);
  const amounts = emptyAmounts();
  for (const row of r.rows) {
    const idx = quarterIdx(row.yr, row.qtr);
    if (idx >= 0) amounts[idx] += Number(row.amt);
  }
  return amounts;
}

async function aggregateAbGrants(client, vertical) {
  // ILIKE ANY (array of patterns) on (program || ministry)
  const sql = `
    SELECT
      EXTRACT(YEAR FROM payment_date)::int AS yr,
      EXTRACT(QUARTER FROM payment_date)::int AS qtr,
      SUM(amount)::numeric AS amt
    FROM ab.ab_grants
    WHERE payment_date >= '2024-04-01'
      AND payment_date < '2026-04-01'
      AND coalesce(amount, 0) > 0
      AND lower(coalesce(program, '') || ' ' || coalesce(ministry, '')) ILIKE ANY ($1::text[])
    GROUP BY yr, qtr;
  `;
  const r = await client.query(sql, [vertical.ilikes]);
  const amounts = emptyAmounts();
  for (const row of r.rows) {
    const idx = quarterIdx(row.yr, row.qtr);
    if (idx >= 0) amounts[idx] += Number(row.amt);
  }
  return amounts;
}

async function aggregateAbSoleSource(client, vertical) {
  const sql = `
    SELECT
      EXTRACT(YEAR FROM start_date)::int AS yr,
      EXTRACT(QUARTER FROM start_date)::int AS qtr,
      SUM(amount)::numeric AS amt
    FROM ab.ab_sole_source
    WHERE start_date >= '2024-04-01'
      AND start_date < '2026-04-01'
      AND coalesce(amount, 0) > 0
      AND lower(coalesce(contract_services, '') || ' ' || coalesce(ministry, '')) ILIKE ANY ($1::text[])
    GROUP BY yr, qtr;
  `;
  const r = await client.query(sql, [vertical.ilikes]);
  const amounts = emptyAmounts();
  for (const row of r.rows) {
    const idx = quarterIdx(row.yr, row.qtr);
    if (idx >= 0) amounts[idx] += Number(row.amt);
  }
  return amounts;
}

async function processVertical(pool, vertical) {
  const t0 = Date.now();
  const c = await pool.connect();
  let fedAmounts = emptyAmounts();
  let abGrantsAmounts = emptyAmounts();
  let abSoleAmounts = emptyAmounts();
  const sources = [];

  try {
    await c.query(`SET statement_timeout = '${PER_VERTICAL_TIMEOUT_MS}'`);

    try {
      fedAmounts = await aggregateFed(c, vertical);
      sources.push('fed');
    } catch (e) {
      console.error(`  [fed] ${vertical.name} failed: ${e.message}`);
    }

    try {
      abGrantsAmounts = await aggregateAbGrants(c, vertical);
      sources.push('ab_grants');
    } catch (e) {
      console.error(`  [ab_grants] ${vertical.name} failed: ${e.message}`);
    }

    try {
      abSoleAmounts = await aggregateAbSoleSource(c, vertical);
      sources.push('ab_sole_source');
    } catch (e) {
      console.error(`  [ab_sole] ${vertical.name} failed: ${e.message}`);
    }
  } finally {
    c.release();
  }

  // Combined amounts (in dollars). Convert to $M with 1 decimal precision via /1e6.
  const combinedM = QUARTERS.map((_, i) => {
    const total = fedAmounts[i] + abGrantsAmounts[i] + abSoleAmounts[i];
    return Math.round(total / 1e6); // millions, integer rounded
  });

  console.log(
    `${vertical.name.padEnd(28)} ` +
    `${combinedM.map(v => String(v).padStart(5)).join(' ')}  ` +
    `(${Date.now() - t0}ms, sources=${sources.join(',')})`
  );

  return {
    vertical: vertical.name,
    amounts: combinedM,
    breakdown: {
      fed:            fedAmounts.map(v => Math.round(v / 1e6)),
      ab_grants:      abGrantsAmounts.map(v => Math.round(v / 1e6)),
      ab_sole_source: abSoleAmounts.map(v => Math.round(v / 1e6))
    },
    sources_used: sources
  };
}

(async () => {
  const connString = process.env.DB_CONNECTION_STRING;
  if (!connString) {
    console.error('ERROR: DB_CONNECTION_STRING not set');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: connString,
    max: 4,
    ssl: { rejectUnauthorized: false }
  });

  console.log(`\nPrecomputing heatmap data — ${VERTICALS.length} verticals × ${QUARTERS.length} quarters\n`);
  console.log('Vertical                     ' + QUARTERS.map(q => q.padStart(5)).join(' '));
  console.log('—'.repeat(28 + QUARTERS.length * 6));

  const rows = [];
  const errors = [];
  for (const v of VERTICALS) {
    try {
      rows.push(await processVertical(pool, v));
    } catch (e) {
      console.error(`${v.name} — fatal: ${e.message}`);
      errors.push({ vertical: v.name, error: e.message });
      rows.push({ vertical: v.name, amounts: emptyAmounts(), breakdown: {}, sources_used: [] });
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    quarters: QUARTERS,
    rows,
    sources_summary: {
      fed: 'fed.grants_contributions, agreement_start_date 2024-04-01 → 2026-04-01, excludes amendments',
      ab_grants: 'ab.ab_grants, payment_date in same range',
      ab_sole_source: 'ab.ab_sole_source, start_date in same range'
    },
    classification_method: 'tsquery on fed.prog_name_en (GIN index); ILIKE ANY on ab program||ministry',
    errors
  };

  const outPath = path.join(__dirname, 'heatmap-data.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ Saved ${rows.length} verticals to ${outPath}`);
  if (errors.length) console.log(`  with ${errors.length} errors:`, errors);

  await pool.end();
})();
