/**
 * intelligence-server.js — Real backend for the Government Intelligence Search.
 *
 * Replaces mock-server.js with live DB queries + Claude LLM calls.
 * Serves search.html statically; exposes two endpoints:
 *   POST /api/ai-search          — NL query → SQL → DB → narrative synthesis
 *   POST /api/entity/:bn/web-intel — Claude web_search tool for external intel
 *
 * Usage: npm start  (or: node visualizations/intelligence-server.js)
 */

const path = require('path');
const fs   = require('fs');

// Load env from general/.env.public then general/.env (same pattern as lib/db.js)
const envPublic = path.join(__dirname, '..', '.env.public');
const envLocal  = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPublic)) require('dotenv').config({ path: envPublic });
if (fs.existsSync(envLocal))  require('dotenv').config({ path: envLocal, override: true });

const express    = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { Pool }   = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── DB pool (inline to control SSL for Azure) ─────────────────────────────────

const connString = process.env.DB_CONNECTION_STRING || '';
if (!connString) {
  console.error('ERROR: DB_CONNECTION_STRING is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: connString,
  max: parseInt(process.env.DB_POOL_MAX || '5', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ssl: { rejectUnauthorized: false }, // works for Render, Azure Postgres, and others
  options: '-c search_path=general,public',
});

pool.on('error', err => console.error('DB pool error:', err.message));

// ── Anthropic client ──────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// ── Verified schema context (Step 0 confirmed) ────────────────────────────────

const SCHEMA_CONTEXT = `
PERFORMANCE RULE #1: ALWAYS use vw_entity_funding as the primary financial source.
It is pre-computed and indexed. NEVER join cra.overhead_by_charity or cra.govt_funding_by_charity
directly - those tables require slow full-table-scans with function-based sorts that exceed the 30s timeout.

PRIMARY TABLES:

general.entity_golden_records  (851K rows, alias as e)
  id (integer PK), canonical_name (text), bn_root (varchar 9-digit), dataset_sources (text[]),
  entity_type (text), cra_profile (jsonb), fed_profile (jsonb), ab_profile (jsonb)

general.vw_entity_funding  (pre-computed rollup, alias as vf - JOIN on vf.entity_id = e.id)
  entity_id, bn_root, dataset_sources,
  cra_total_revenue, cra_total_expenditures, cra_program_spending, cra_gifts_to_donees,
  cra_filing_count, cra_earliest_year, cra_latest_year,
  fed_total_grants, fed_grant_count, fed_earliest_grant, fed_latest_grant,
  ab_total_grants, ab_grant_payment_count,
  ab_total_contracts, ab_contract_count,
  ab_total_sole_source, ab_sole_source_count,
  total_all_funding

OVERHEAD SIGNALS - compute from vw_entity_funding only (never from cra.overhead_by_charity):
  overhead_ratio = (vf.cra_total_expenditures - vf.cra_program_spending) / NULLIF(vf.cra_total_revenue, 0)
  program_ratio  = vf.cra_program_spending / NULLIF(vf.cra_total_expenditures, 0)

LOOP SIGNALS - cra.loop_participants has 30K rows, BNs in full 15-char format.
Always use a pre-aggregated CTE:
  WITH loop_bns AS (
    SELECT LEFT(bn, 9) AS bn_root, COUNT(DISTINCT loop_id) AS loop_count
    FROM cra.loop_participants GROUP BY LEFT(bn, 9)
  )
  -- INNER JOIN loop_bns lb ON lb.bn_root = e.bn_root  means entity must be in loops
  -- LEFT JOIN loop_bns lb ON lb.bn_root = e.bn_root   then lb.loop_count IS NOT NULL means in loops

GOOD ACTOR signals (sort efficiency DESC):
  program_ratio > 0.80   (vf.cra_program_spending / NULLIF(vf.cra_total_expenditures,0) > 0.80)
  overhead_ratio < 0.20
  lb.loop_count IS NULL  (not in any circular gifting loop)
  array_length(e.dataset_sources, 1) >= 2   (multi-dataset verification)

BAD ACTOR signals (sort risk DESC):
  overhead_ratio > 0.55
  lb.loop_count >= 1  (in circular gifting loops)
  vf.fed_total_grants / NULLIF(vf.cra_total_revenue,0) > 0.85  (govt-dependent)

CROSS-DATASET signals:
  vf.ab_sole_source_count > 0 AND vf.fed_total_grants > 0   (dual public funding)
  vf.total_all_funding

CANONICAL FAST QUERY PATTERN - always follow this structure:
  WITH loop_bns AS (
    SELECT LEFT(bn, 9) AS bn_root, COUNT(DISTINCT loop_id) AS loop_count
    FROM cra.loop_participants GROUP BY LEFT(bn, 9)
  )
  SELECT
    e.id, e.canonical_name, e.bn_root, e.dataset_sources,
    ROUND((vf.cra_total_expenditures - vf.cra_program_spending) / NULLIF(vf.cra_total_revenue,0), 4) AS overhead_ratio,
    ROUND(vf.cra_program_spending / NULLIF(vf.cra_total_expenditures,0), 4) AS program_ratio,
    lb.loop_count,
    vf.cra_total_revenue, vf.cra_total_expenditures, vf.cra_program_spending,
    vf.fed_total_grants, vf.ab_total_grants, vf.total_all_funding, vf.cra_filing_count,
    array_length(e.dataset_sources, 1) AS source_count
  FROM general.entity_golden_records e
  JOIN general.vw_entity_funding vf ON vf.entity_id = e.id
  JOIN loop_bns lb ON lb.bn_root = e.bn_root
  WHERE vf.cra_total_revenue > 0
    AND (vf.cra_total_expenditures - vf.cra_program_spending) / NULLIF(vf.cra_total_revenue,0) > 0.55
  ORDER BY overhead_ratio DESC, lb.loop_count DESC
  LIMIT 15

MANDATORY RULES:
  1. Return ONLY valid SQL starting with SELECT or WITH - no markdown, no explanation
  2. Always include: e.id, e.canonical_name, e.bn_root, e.dataset_sources
  3. Always end with LIMIT 15
  4. NEVER join cra.overhead_by_charity or cra.govt_funding_by_charity - use vw_entity_funding instead
  5. For loop detection: always use the loop_bns CTE pattern above
  6. Cast jsonb text to numeric with ::numeric when comparing
`.trim();

const POLICY_CONTEXT = `
Canada Federal Budget 2025-26 priority shifts (use for policy_pulse scoring):
HIGH PRIORITY (budget increased): Housing (+$25B), Defence (+$30B), Infrastructure (+$115B),
  Productivity/competitiveness (+$110B), Indigenous reconciliation, Trade diversification
REDUCED PRIORITY: Some climate programs, Immigration-adjacent services, Civil service (−40K positions)
RISK SIGNAL: Organization >85% govt revenue dependency in a reduced-priority sector
  faces funding cliff risk within 12-24 months.
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

function validateSQL(sql) {
  const s = (sql || '').trim().toUpperCase();
  if (!s.startsWith('SELECT') && !s.startsWith('WITH')) {
    throw new Error('Generated SQL must start with SELECT or WITH');
  }
  for (const kw of ['INSERT','UPDATE','DELETE','DROP','TRUNCATE','CREATE','ALTER','GRANT','EXECUTE']) {
    if (new RegExp(`\\b${kw}\\b`).test(s)) throw new Error(`Forbidden keyword in generated SQL: ${kw}`);
  }
  if (!s.includes('LIMIT')) throw new Error('Generated SQL must include LIMIT');
  return sql.trim();
}

function extractJSON(text) {
  // Strip markdown fences if present
  let clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  // If Claude added a prose preamble, find the first { or [ and parse from there
  const firstBrace = clean.search(/[{\[]/);
  if (firstBrace > 0) clean = clean.slice(firstBrace);
  return JSON.parse(clean);
}

// ── POST /api/ai-search ───────────────────────────────────────────────────────

app.post('/api/ai-search', async (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) return res.status(400).json({ error: 'Query is required' });

  let generatedSQL = '';

  try {
    // ── Step 1a: NL → SQL ────────────────────────────────────────────────────
    console.log(`\n[ai-search] Query: "${query.trim()}"`);
    console.log('[ai-search] Step 1a: Calling Claude for SQL generation...');

    const sqlResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `${SCHEMA_CONTEXT}\n\nGenerate a PostgreSQL SELECT query for: "${query.trim()}"`
      }]
    });

    generatedSQL = sqlResponse.content[0].text.trim();

    // Strip markdown fences if Claude wrapped it
    generatedSQL = generatedSQL.replace(/^```sql\n?/i, '').replace(/\n?```$/i, '').trim();

    console.log('[ai-search] Step 1a: SQL generated:\n', generatedSQL);

    // ── Step 1b: Safety validation ───────────────────────────────────────────
    console.log('[ai-search] Step 1b: Validating SQL...');
    validateSQL(generatedSQL);
    console.log('[ai-search] Step 1b: SQL passed validation.');

    // ── Step 1c: Execute against DB ──────────────────────────────────────────
    console.log('[ai-search] Step 1c: Executing query against DB...');
    const client = await pool.connect();
    let dbRows = [];
    try {
      await client.query("SET statement_timeout = '600000'"); // 2 min max
      const result = await client.query(generatedSQL);
      dbRows = result.rows;
    } finally {
      client.release();
    }

    console.log(`[ai-search] Step 1c: DB returned ${dbRows.length} rows.`);
    if (dbRows.length > 0) console.log('[ai-search] Step 1c: First row sample:', JSON.stringify(dbRows[0], null, 2));

    if (dbRows.length === 0) {
      console.log('[ai-search] No results — returning empty response.');
      return res.json({
        query: query.trim(),
        mode: 'mixed',
        total_found: 0,
        sql_generated: generatedSQL,
        results: []
      });
    }

    // ── Step 1d: Narrative + Policy Pulse synthesis ──────────────────────────
    console.log('[ai-search] Step 1d: Calling Claude for narrative synthesis...');
    const narrativeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `You synthesize Canadian government accountability intelligence.

User query: "${query.trim()}"

Database results (${dbRows.length} rows):
${JSON.stringify(dbRows, null, 2)}

Policy context:
${POLICY_CONTEXT}

For each result row, produce a JSON object. Return a JSON object with this exact shape:
{
  "mode": "bad_actor" | "good_actor" | "mixed",
  "results": [
    {
      "id": <integer id from row>,
      "canonical_name": "<from row>",
      "bn_root": "<from row>",
      "dataset_sources": <array from row>,
      "score": <integer 0-35 for bad actors, 0-100 for good actors>,
      "score_max": <35 for bad actors, 100 for good actors>,
      "score_label": "High Risk" | "Elevated Risk" | "Moderate Risk" | "Exemplary" | "High Performing",
      "narrative": "<2-3 sentences citing specific dollar amounts and percentages from the data>",
      "flags": ["<specific data point with numbers>", ...],
      "policy_pulse": {
        "alignment": "aligned" | "misaligned" | "neutral",
        "priority_area": "<Housing|Defence|Indigenous Reconciliation|Infrastructure|Climate|etc>",
        "risk_level": "low" | "medium" | "high",
        "policy_note": "<one sentence citing specific 2025-26 budget figure>"
      }
    }
  ]
}

Rules:
- Cite real numbers from the data rows (dollar amounts, percentages, counts)
- For bad actor queries: score is risk level (higher = worse), use score_max 35
- For good actor queries: score is efficiency (higher = better), use score_max 100
- flags array: 3-6 items, each a specific data point ("$4.2M federal grants", "88% overhead")
- Return ONLY valid JSON — no markdown, no explanation`
      }]
    });

    console.log('[ai-search] Step 1d: Raw narrative response:', narrativeResponse.content[0].text.slice(0, 500));

    let synthesis;
    try {
      synthesis = extractJSON(narrativeResponse.content[0].text);
      console.log(`[ai-search] Step 1d: Parsed ${synthesis.results?.length} synthesized results, mode=${synthesis.mode}`);
    } catch (parseErr) {
      console.error('[ai-search] Step 1d: Narrative JSON parse failed:', parseErr.message);
      // Narrative parse failed — return raw DB rows with empty narratives
      synthesis = {
        mode: 'mixed',
        results: dbRows.map(row => ({
          id: row.id,
          canonical_name: row.canonical_name,
          bn_root: row.bn_root,
          dataset_sources: row.dataset_sources || [],
          score: 0, score_max: 35, score_label: 'Unknown',
          narrative: 'Narrative synthesis unavailable.',
          flags: [],
          policy_pulse: { alignment: 'neutral', priority_area: 'Unknown', risk_level: 'low', policy_note: '' }
        }))
      };
    }

    res.json({
      query: query.trim(),
      mode: synthesis.mode,
      total_found: dbRows.length,
      sql_generated: generatedSQL,
      results: synthesis.results
    });

  } catch (err) {
    console.error('[ai-search] ERROR:', err.message);
    console.error('[ai-search] Stack:', err.stack);

    // User-friendly error messages
    let message = 'Search failed. Please try rephrasing your query.';
    if (err.message.includes('statement_timeout') || err.message.includes('timeout')) {
      message = 'Query timed out — try a more specific query (e.g. add a sector or province).';
    } else if (err.message.includes('Forbidden keyword')) {
      message = 'Could not generate a safe query for that input. Please try rephrasing.';
    } else if (err.message.includes('must start with SELECT')) {
      message = 'AI generated an invalid query. Please try rephrasing.';
    }

    res.status(500).json({
      error: message,
      sql_generated: generatedSQL || null
    });
  }
});

// ── POST /api/entity/:bn/web-intel ───────────────────────────────────────────

const webIntelCache = new Map(); // session-level cache, resets on server restart

app.post('/api/entity/:bn/web-intel', async (req, res) => {
  const { bn } = req.params;

  if (webIntelCache.has(bn)) return res.json(webIntelCache.get(bn));

  const { canonical_name = '', sector = '' } = req.body;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{
        role: 'user',
        content: `Search the web for recent public information about this Canadian organization.

Name: ${canonical_name}
Business Number (BN): ${bn}
Sector: ${sector}

Search for: news coverage, CRA audits or sanctions, Charity Intelligence Canada ratings,
corporate registry status, director controversies, program outcome reports, government audit findings.

After searching, return ONLY a JSON object (no markdown fences):
{
  "news_mentions": [
    {"headline": "...", "source": "CBC News|Globe and Mail|etc", "date": "YYYY-MM-DD", "sentiment": "positive|negative|neutral"}
  ],
  "registry_status": "Active — last return filed YYYY | Revoked | Dissolved | Unknown",
  "red_flags_found": ["specific finding with date if available", ...],
  "positive_signals": ["specific finding", ...],
  "web_summary": "2-3 sentence synthesis of what public web sources reveal about this organization."
}`
      }]
    });

    // Extract final text block (after any tool-use turns)
    const textBlock = response.content.filter(b => b.type === 'text').at(-1);
    console.log(`[web-intel] stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);
    console.log('[web-intel] Raw text block:', textBlock?.text?.slice(0, 800));
    let data;
    try {
      data = extractJSON(textBlock?.text || '{}');
    } catch (parseErr) {
      console.error('[web-intel] JSON parse failed:', parseErr.message);
      console.error('[web-intel] Full text block:', textBlock?.text);
      data = {
        news_mentions: [],
        registry_status: 'Could not parse web search results',
        red_flags_found: [],
        positive_signals: [],
        web_summary: 'Web intelligence lookup completed but response could not be parsed.'
      };
    }

    webIntelCache.set(bn, data);
    res.json(data);

  } catch (err) {
    console.error('web-intel error:', err.message);

    // Graceful fallback if web_search tool unavailable or times out
    const fallback = {
      news_mentions: [],
      registry_status: 'Web search unavailable',
      red_flags_found: [],
      positive_signals: [],
      web_summary: `Web intelligence lookup failed: ${err.message}. Check ANTHROPIC_API_KEY and ensure the web_search tool is enabled for your plan.`
    };
    res.json(fallback);
  }
});

// ── Heatmap (seed) ────────────────────────────────────────────────────────────
// Static seed for the realtime heatmap demo. The page generates ticks
// client-side; this endpoint just sets the starting amounts so the page
// opens with a coherent snapshot. Vertical names + quarter count must match
// VERTICALS / QUARTERS in heatmap.html.

// Real-data seed precomputed by visualizations/precompute-heatmap.js. Falls
// back to the inline seed if the file is missing.

const HEATMAP_FALLBACK_SEED = {
  generated_at: null,
  quarters: ['Q2-24','Q3-24','Q4-24','Q1-25','Q2-25','Q3-25','Q4-25','Q1-26'],
  rows: [
    { vertical: 'Health & Mental Health', amounts: [180, 195, 210, 220, 245, 260, 275, 290] },
    { vertical: 'Indigenous Programs',     amounts: [85, 92, 110, 130, 158, 184, 210, 240] },
    { vertical: 'Housing & Shelter',       amounts: [120, 132, 145, 160, 175, 168, 180, 198] },
    { vertical: 'Education & Research',    amounts: [140, 148, 152, 162, 170, 175, 182, 188] },
    { vertical: 'Environment & Climate',   amounts: [62, 70, 78, 84, 76, 82, 90, 96] },
    { vertical: 'Defense & Security',      amounts: [210, 220, 230, 245, 260, 282, 295, 320] },
    { vertical: 'Infrastructure',          amounts: [165, 170, 178, 184, 190, 198, 205, 215] },
    { vertical: 'Arts & Culture',          amounts: [42, 44, 46, 48, 50, 52, 54, 56] },
    { vertical: 'Economic Development',    amounts: [98, 104, 112, 118, 122, 130, 138, 145] },
    { vertical: 'Justice & Legal Aid',     amounts: [38, 40, 42, 44, 46, 48, 50, 52] },
    { vertical: 'Agriculture & Food',      amounts: [56, 62, 65, 70, 72, 74, 78, 82] },
    { vertical: 'International Aid',       amounts: [48, 50, 52, 54, 50, 48, 46, 44] }
  ],
  data_source: 'inline-seed (precompute file missing)'
};

function loadHeatmapSeed() {
  const file = path.join(__dirname, 'heatmap-data.json');
  if (!fs.existsSync(file)) return HEATMAP_FALLBACK_SEED;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      generated_at: j.generated_at,
      quarters: j.quarters,
      rows: j.rows.map(r => ({ vertical: r.vertical, amounts: r.amounts, breakdown: r.breakdown })),
      data_source: 'real (fed.grants_contributions + ab.ab_grants + ab.ab_sole_source)'
    };
  } catch (e) {
    console.error(`[heatmap] failed to load heatmap-data.json: ${e.message} — using fallback seed`);
    return HEATMAP_FALLBACK_SEED;
  }
}

const HEATMAP_SEED = loadHeatmapSeed();
console.log(`[heatmap] data source: ${HEATMAP_SEED.data_source}${HEATMAP_SEED.generated_at ? ` · generated ${HEATMAP_SEED.generated_at}` : ''}`);

app.get('/api/funding-heatmap', (req, res) => {
  const jitter = HEATMAP_SEED.rows.map(r => ({
    vertical: r.vertical,
    amounts: r.amounts.map(a => Math.max(1, Math.round(a + (Math.random() - 0.5) * a * 0.05))),
    breakdown: r.breakdown
  }));
  res.json({
    quarters: HEATMAP_SEED.quarters,
    rows: jitter,
    data_source: HEATMAP_SEED.data_source,
    seed_generated_at: HEATMAP_SEED.generated_at,
    generated_at: new Date().toISOString()
  });
});

// ── Action Plan ───────────────────────────────────────────────────────────────
// POST /api/action-plan
// Body: { vertical, quarters, amounts, source_filter, recent_signals }
// Calls Claude Opus 4.7 with adaptive thinking + structured JSON output and
// prompt caching on the system prompt. Falls back to a deterministic templated
// plan when ANTHROPIC_API_KEY is missing or the call fails.

const ACTION_PLAN_SYSTEM = `You are the Funding Reviewer agent for Long View Systems' Public Funding Intelligence platform.

Your role is to analyse where public dollars (CRA charity filings, federal grants & contributions, and Alberta open data) are flowing into a single spending vertical, and produce a concrete, actionable plan a senior public-sector accountability analyst can act on this week.

For every request you receive:
- A vertical name (e.g. "Defense & Security", "Indigenous Programs")
- The vertical's last 8 quarterly totals in millions of CAD
- The current source filter (all sources / CRA / FED / Alberta) — this affects which accountability levers apply
- A short list of recent agent observations / alerts from the live heatmap

Reasoning rules:
- Reason from the actual quarterly numbers — call out specific deltas, peaks, troughs.
- If the source filter is not "all", scope the plan to that source's accountability levers:
    CRA = T3010 overhead and circular gifting, FED = federal grant amendments and concentration, AB = Alberta sole-source and Blue Book contracts.
- Be direct. No hedging. No "consider potentially exploring".
- All currency is CAD millions unless otherwise stated.
- Forecast band must be within ~30% of the latest quarter; the trajectory must justify the mid value.

Output rules:
- summary: one or two sentences naming the most important finding given the trajectory and recent signals.
- top_actions: 3-5 concrete next-step actions, ranked by leverage. Each: imperative title, one-sentence "why" citing specific numbers, and a realistic owner role.
- investigate_next: 2-3 follow-up questions an analyst should run through the search/dossier explorer.
- dossier_candidates: 0-3 illustrative entities with plausible names + 9-digit fake BNs. Mark these as illustrative.
- forecast_band: low / mid / high projection for the next quarter, in millions.

Return JSON only. No preamble, no markdown.`;

const ACTION_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    top_actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          owner: { type: 'string' }
        },
        required: ['title', 'why', 'owner'],
        additionalProperties: false
      }
    },
    investigate_next: { type: 'array', items: { type: 'string' } },
    dossier_candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bn: { type: 'string' },
          why: { type: 'string' }
        },
        required: ['name', 'bn', 'why'],
        additionalProperties: false
      }
    },
    forecast_band: {
      type: 'object',
      properties: {
        low: { type: 'number' },
        mid: { type: 'number' },
        high: { type: 'number' }
      },
      required: ['low', 'mid', 'high'],
      additionalProperties: false
    }
  },
  required: ['summary', 'top_actions', 'investigate_next', 'dossier_candidates', 'forecast_band'],
  additionalProperties: false
};

function templateActionPlan({ vertical, amounts, source_filter }) {
  const last = amounts[amounts.length - 1];
  const prev = amounts[amounts.length - 2] || last;
  const pct = ((last - prev) / Math.max(1, prev)) * 100;
  const trend = pct > 5 ? 'sharp upward' : pct < -5 ? 'declining' : 'stable';
  const pred = Math.round(last * (1 + (pct / 100) * 0.6));
  const sourceLabel = source_filter === 'all' ? 'all sources' : (source_filter || 'all').toUpperCase();
  return {
    vertical,
    summary: `${vertical} closed the most recent quarter at $${last}M (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% QoQ). The ${sourceLabel} view shows a ${trend} trajectory across the last 8 quarters.`,
    top_actions: [
      { title: `Audit top-10 recipients in ${vertical}`, why: `${last}M deployed last quarter — pull the top recipients via the Dossier Explorer and check overhead ratios above 0.55.`, owner: 'Program Evaluator' },
      { title: 'Cross-reference the last 3 agent alerts in this vertical', why: 'Multiple flags warrant a focused review before Q2-26 close.', owner: 'Risk Analyst' },
      { title: 'Compare concentration to prior 4-quarter baseline', why: `Trajectory at ${pct.toFixed(1)}% QoQ — confirm whether the shift is driven by 1-2 recipients or broad-based.`, owner: 'Procurement Audit Lead' }
    ],
    investigate_next: [
      `Top 10 ${vertical} recipients ranked by overhead ratio`,
      'Dual-funded entities (CRA + AB sole-source) within this vertical',
      'YoY amendment creep on federal grants in this vertical'
    ],
    dossier_candidates: [],
    forecast_band: { low: Math.max(8, Math.round(pred * 0.9)), mid: pred, high: Math.round(pred * 1.1) },
    fallback: true,
    model_label: 'fallback (template)',
    cache_hits: '—'
  };
}

function extractActionPlanJSON(content) {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      let s = block.text.trim();
      s = s.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      const firstBrace = s.search(/[{\[]/);
      if (firstBrace > 0) s = s.slice(firstBrace);
      try { return JSON.parse(s); } catch (_) { /* try next block */ }
    }
  }
  return null;
}

app.post('/api/action-plan', async (req, res) => {
  const body = req.body || {};
  const { vertical, quarters, amounts, source_filter, recent_signals } = body;
  if (!vertical || !Array.isArray(amounts) || amounts.length === 0) {
    return res.status(400).json({ error: 'vertical and amounts[] required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`[action-plan] No ANTHROPIC_API_KEY — returning fallback for "${vertical}"`);
    return res.json(templateActionPlan(body));
  }

  const userMessage = [
    `Vertical: ${vertical}`,
    `Quarters: ${(quarters || []).join(', ')}`,
    `Amounts (M CAD, oldest → newest): ${amounts.join(', ')}`,
    `Source filter: ${source_filter || 'all'}`,
    `Recent agent signals:`,
    ...(Array.isArray(recent_signals) && recent_signals.length
      ? recent_signals.map(s => `  - [${(s.kind || '').toUpperCase()}] ${s.body || ''}`)
      : ['  (none yet)'])
  ].join('\n');

  try {
    console.log(`[action-plan] Opus 4.7 call for "${vertical}" (source=${source_filter || 'all'})`);
    const startedAt = Date.now();

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: ACTION_PLAN_SCHEMA }
      },
      system: [
        { type: 'text', text: ACTION_PLAN_SYSTEM, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: userMessage }]
    });

    const elapsed = Date.now() - startedAt;
    const usage = response.usage || {};
    const cacheHits = `cache_read=${usage.cache_read_input_tokens || 0}, cache_create=${usage.cache_creation_input_tokens || 0}, in=${usage.input_tokens || 0}, out=${usage.output_tokens || 0}`;
    console.log(`[action-plan] Opus 4.7 done in ${elapsed}ms · ${cacheHits}`);

    const plan = extractActionPlanJSON(response.content);
    if (!plan) throw new Error('Could not parse action plan JSON from response');

    plan.vertical = plan.vertical || vertical;
    plan.fallback = false;
    plan.model_label = 'model';
    plan.cache_hits = cacheHits;
    res.json(plan);
  } catch (err) {
    console.error('[action-plan] Opus 4.7 error:', err.message);
    const fallback = templateActionPlan(body);
    fallback.error = err.message;
    res.json(fallback);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || process.env.INTELLIGENCE_PORT || 3803;
app.listen(PORT, () => {
  console.log(`\n🔍  Intelligence server running`);
  console.log(`    → http://localhost:${PORT}/search.html`);
  console.log(`    → http://localhost:${PORT}/heatmap.html`);
  console.log(`    DB: ${connString.replace(/:\/\/.*@/, '://<credentials>@')}\n`);
});
