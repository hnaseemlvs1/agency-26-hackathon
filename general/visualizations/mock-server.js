// Run from: cd general && node visualizations/mock-server.js
require('dotenv').config({ path: `${__dirname}/../.env.public` });
require('dotenv').config({ path: `${__dirname}/../.env` });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const mockDelay = () => new Promise(r => setTimeout(r, 1600 + Math.random() * 1800));
const shortDelay = () => new Promise(r => setTimeout(r, 2000 + Math.random() * 2500));

// ─── Mock Result Datasets ────────────────────────────────────────────────────

const MOCK_RESULTS = {

  env_bad: {
    mode: 'bad_actor',
    total_found: 12,
    sql_generated: `SELECT e.id, e.canonical_name, e.bn_root, e.dataset_sources,
       o.overhead_ratio, o.govt_funding_pct, lp.loop_count,
       (o.overhead_ratio * 20 + COALESCE(lp.loop_count,0) * 5 + o.govt_funding_pct * 10) AS risk_score
FROM general.entity_golden_records e
JOIN cra.overhead_by_charity o ON o.bn = e.bn_root
LEFT JOIN cra.loop_participants lp ON lp.bn = e.bn_root
WHERE (e.cra_profile->>'program_areas' ILIKE '%environment%'
   OR e.fed_profile->>'program' ILIKE '%climate%'
   OR e.fed_profile->>'program' ILIKE '%environment%')
  AND (lp.loop_count > 0 OR o.overhead_ratio > 0.6)
ORDER BY risk_score DESC
LIMIT 15`,
    results: [
      {
        id: 'ent_001', canonical_name: 'Green Future Foundation', bn_root: '847291630',
        dataset_sources: ['cra', 'fed'], score: 32, score_max: 35, score_label: 'High Risk',
        narrative: 'Received $4.2M in federal climate grants while participating in a 3-entity circular funding loop. The foundation declared zero program staff in its most recent T3010 filing — all funds were redistributed as gifts to two related organizations, one of which shares a director.',
        flags: ['Part of 3-entity funding loop', '$4.2M federal grants received', '0 employees listed (T3010)', '88% overhead ratio', 'Director overlap with EcoPath Canada Inc.'],
        policy_pulse: { alignment: 'misaligned', priority_area: 'Climate', risk_level: 'high', policy_note: 'Climate programs face budget headwinds in 2025-26 — organizations already flagged for misuse are unlikely to see renewal.' }
      },
      {
        id: 'ent_002', canonical_name: 'EcoPath Canada Inc.', bn_root: '392847165',
        dataset_sources: ['cra', 'fed', 'ab'], score: 29, score_max: 35, score_label: 'High Risk',
        narrative: 'Received $1.1M via sole-source Alberta contract while simultaneously holding $2.8M in federal environmental grants. Operates with 94% government revenue dependency and has never filed a public program outcomes report.',
        flags: ['$1.1M AB sole-source contract', '94% government revenue dependency', 'No program outcome reports filed', 'Loop participant (Tier 2)', '$2.8M fed environmental grants'],
        policy_pulse: { alignment: 'misaligned', priority_area: 'Climate', risk_level: 'high', policy_note: 'Cross-dataset dual-funding pattern with no verified outcomes raises serious accountability concerns.' }
      },
      {
        id: 'ent_003', canonical_name: 'Clean Planet Alliance', bn_root: '561203847',
        dataset_sources: ['cra', 'fed'], score: 27, score_max: 35, score_label: 'High Risk',
        narrative: 'Core participant in a 3-entity gifting loop that has circulated an estimated $6.7M over 4 fiscal years. T3010 filings show consistent 79% overhead with negligible charitable program expenditure.',
        flags: ['$6.7M circular loop (4-year total)', '79% overhead ratio', 'Registered charity with no charitable activities listed', 'T3010 inconsistencies flagged 2022-2023'],
        policy_pulse: { alignment: 'neutral', priority_area: 'Climate', risk_level: 'medium', policy_note: 'Sector is deprioritized; no evidence of legitimate program delivery to offset reputational risk.' }
      },
      {
        id: 'ent_004', canonical_name: 'Nature Conservation Trust of Alberta', bn_root: '748302916',
        dataset_sources: ['cra', 'ab'], score: 24, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Ghost capacity entity: registered with 14 directors but zero employees. Received $3.4M in Alberta environmental grants over 3 years while operating from a residential address shared with two other registered charities.',
        flags: ['0 employees, 14 directors', 'Residential address shared with 2 other charities', '$3.4M AB environmental grants', 'Ghost capacity indicator', 'No public-facing programs found'],
        policy_pulse: { alignment: 'neutral', priority_area: 'Environment', risk_level: 'medium', policy_note: 'AB budget has not significantly increased environmental grant envelope — renewal risk is moderate.' }
      },
      {
        id: 'ent_005', canonical_name: 'Sustainable Earth Network', bn_root: '193847562',
        dataset_sources: ['cra', 'fed'], score: 21, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Director of Sustainable Earth Network is listed as an officer of a private company that received $840K in sole-source contracts from the same federal department that funds the charity. Pattern suggests conflict of interest not disclosed in T3010 filings.',
        flags: ['Director conflict of interest: private company beneficiary', '$840K sole-source contract to director-linked company', 'Conflict not disclosed in T3010', '$1.9M federal environmental grants'],
        policy_pulse: { alignment: 'neutral', priority_area: 'Environment', risk_level: 'medium', policy_note: 'Undisclosed conflicts of interest are a regulatory red flag regardless of sector priority shifts.' }
      }
    ]
  },

  housing_bad: {
    mode: 'bad_actor',
    total_found: 9,
    sql_generated: `SELECT e.id, e.canonical_name, e.bn_root, e.dataset_sources,
       o.overhead_ratio, o.govt_funding_pct, o.total_revenue,
       f.total_funding AS fed_funding,
       (o.overhead_ratio * 18 + o.govt_funding_pct * 12 + (f.amendment_count * 0.5)) AS risk_score
FROM general.entity_golden_records e
JOIN cra.overhead_by_charity o ON o.bn = e.bn_root
LEFT JOIN fed.recipient_risk_profile f ON f.bn = e.bn_root
WHERE (e.cra_profile->>'program_areas' ILIKE '%housing%'
   OR e.fed_profile->>'program' ILIKE '%housing%'
   OR e.fed_profile->>'program' ILIKE '%shelter%')
  AND o.overhead_ratio > 0.55
  AND o.govt_funding_pct > 0.70
ORDER BY risk_score DESC
LIMIT 15`,
    results: [
      {
        id: 'ent_011', canonical_name: 'Affordable Housing Solutions Inc.', bn_root: '203948571',
        dataset_sources: ['cra', 'fed', 'ab'], score: 28, score_max: 35, score_label: 'High Risk',
        narrative: 'Received $8.4M in federal affordable housing grants across 3 programs, yet internal T3010 data shows 78% overhead and zero new housing units attributable to the organization. A director holds an ownership stake in a property management firm with $2.1M in related Alberta contracts.',
        flags: ['78% overhead ratio', '$8.4M federal housing grants', '0 housing units built (program descriptions)', 'Director-owned company: $2.1M AB contract', '83% government revenue dependency'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Housing', risk_level: 'high', policy_note: 'Housing is a $25B federal priority — misuse of housing grants will face heightened scrutiny, not less.' }
      },
      {
        id: 'ent_012', canonical_name: 'Metro Housing Initiatives', bn_root: '475829301',
        dataset_sources: ['cra', 'fed'], score: 25, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Consistently receives the maximum eligible federal housing grant each year while reporting a 72% overhead ratio. The organization has 14 government-grant amendment events over 5 years — a pattern associated with scope-creep and budget inflation.',
        flags: ['72% overhead ratio', '14 grant amendment events (5 years)', 'Amendment creep score: 8.4/10', '$5.1M total federal housing funding', '90% government revenue dependency'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Housing', risk_level: 'high', policy_note: 'High amendment volume in a prioritized sector is a red flag for inflated scoping rather than genuine program expansion.' }
      },
      {
        id: 'ent_013', canonical_name: 'Community Shelter Network', bn_root: '631047829',
        dataset_sources: ['cra', 'fed'], score: 22, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Program spending ratio has declined from 61% to 34% over 5 years while federal funding increased. The organization stopped filing T3010 forms for fiscal year 2023 — a regulatory non-compliance flag.',
        flags: ['Program spending ratio declined: 61%→34%', 'T3010 not filed FY2023', 'Federal funding increased while outcomes declined', '$3.8M total fed funding (5 years)'],
        policy_pulse: { alignment: 'neutral', priority_area: 'Housing', risk_level: 'medium', policy_note: 'Non-filing combined with declining delivery metrics puts renewal at risk despite housing sector priority.' }
      },
      {
        id: 'ent_014', canonical_name: 'Urban Housing Cooperative', bn_root: '847103926',
        dataset_sources: ['cra'], score: 19, score_max: 35, score_label: 'Moderate Risk',
        narrative: 'Receives 91% of its revenue from government sources with no diversified funding base. Operating exclusively in a single municipality, it has not expanded program reach in 6 years despite significant annual grant renewals.',
        flags: ['91% government revenue', 'No funding diversification (6 years)', 'Geographic concentration: single municipality', '$1.7M annual CRA-tracked funding'],
        policy_pulse: { alignment: 'neutral', priority_area: 'Housing', risk_level: 'low', policy_note: 'Single-purpose concentration without growth is low fraud risk but poor value for $25B priority spend.' }
      },
      {
        id: 'ent_015', canonical_name: 'New Horizons Property Trust', bn_root: '920381746',
        dataset_sources: ['cra', 'fed', 'ab'], score: 26, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Cross-dataset analysis reveals the trust received $4.6M from federal housing programs while simultaneously billing $1.3M in property management fees to the City of Edmonton — fees paid to a company with an identical registered address.',
        flags: ['$4.6M federal housing grants', '$1.3M property fees: identical address company', 'Cross-dataset address match flagged', '76% overhead ratio', 'Potential self-dealing not disclosed'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Housing', risk_level: 'high', policy_note: 'Self-dealing in the housing sector under the new $25B envelope will be a top audit priority for the Auditor General.' }
      }
    ]
  },

  indigenous_good: {
    mode: 'good_actor',
    total_found: 23,
    sql_generated: `SELECT e.id, e.canonical_name, e.bn_root, e.dataset_sources,
       o.program_spending_ratio, o.total_revenue, o.govt_funding_pct,
       f.total_funding AS fed_funding, f.amendment_count,
       ROUND((o.program_spending_ratio * 60 + (1 - o.overhead_ratio) * 25
              + LEAST(array_length(e.dataset_sources,1),3) * 5) :: numeric, 1) AS efficiency_score
FROM general.entity_golden_records e
JOIN cra.overhead_by_charity o ON o.bn = e.bn_root
LEFT JOIN fed.recipient_risk_profile f ON f.bn = e.bn_root
WHERE (e.cra_profile->>'program_areas' ILIKE '%indigenous%'
   OR e.cra_profile->>'program_areas' ILIKE '%first nation%'
   OR e.fed_profile->>'program' ILIKE '%reconciliation%'
   OR e.fed_profile->>'program' ILIKE '%indigenous%')
  AND o.program_spending_ratio > 0.80
  AND o.overhead_ratio < 0.20
ORDER BY efficiency_score DESC
LIMIT 15`,
    results: [
      {
        id: 'ent_021', canonical_name: 'First Nations Education Council', bn_root: '394827165',
        dataset_sources: ['cra', 'fed', 'ab'], score: 94, score_max: 100, score_label: 'Exemplary',
        narrative: 'Received $12.3M in federal education funding across 4 programs with a 92% program spending ratio — one of the highest in the sector. Consistent T3010 filings from 2019-2024, zero governance red flags, and verifiable outcomes including 8,400 students served in the most recent program year.',
        flags: ['92% program spending ratio', '$12.3M federal funding (4 programs)', '8,400 students served (verified)', 'Zero governance flags', '5-year consistent filing record', 'Multi-dataset verification: CRA + FED + AB'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Indigenous Reconciliation', risk_level: 'low', policy_note: 'Indigenous reconciliation is a top federal priority — this organization is a model candidate for renewed and expanded funding.' }
      },
      {
        id: 'ent_022', canonical_name: 'Métis Nation Learning Society', bn_root: '583920471',
        dataset_sources: ['cra', 'fed'], score: 92, score_max: 100, score_label: 'Exemplary',
        narrative: 'Operates a network of 12 learning centres across 3 provinces, achieving a 89% program spending ratio on $7.8M in total annual funding. The organization\'s transparency record is exceptional — it publishes annual impact reports and maintains an active governance board of 11 elected community members.',
        flags: ['89% program spending ratio', '$7.8M annual funding', '12 learning centres (3 provinces)', 'Elected community governance board', 'Annual public impact reports', 'Zero CRA or FED risk flags'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Indigenous Reconciliation', risk_level: 'low', policy_note: 'Multi-provincial reach with community governance aligns perfectly with the reconciliation mandate in Budget 2025-26.' }
      },
      {
        id: 'ent_023', canonical_name: 'Indigenous Youth Leadership Alliance', bn_root: '710284936',
        dataset_sources: ['cra', 'fed'], score: 89, score_max: 100, score_label: 'High Performing',
        narrative: 'Focuses exclusively on mentorship and skills training for Indigenous youth aged 15-29. Operates efficiently at 85% program spending with $4.1M in federal funding, and has grown program reach by 34% year-over-year while keeping overhead flat.',
        flags: ['85% program spending ratio', '34% annual reach growth', '$4.1M federal funding', 'Overhead held flat over 3 years', 'Youth focus: ages 15-29', 'CRA risk score: 4/30 (very low)'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Indigenous Reconciliation', risk_level: 'low', policy_note: 'Youth-focused reconciliation programs are specifically called out in the 2025-26 departmental plans as a priority investment area.' }
      },
      {
        id: 'ent_024', canonical_name: 'Northern Communities School Trust', bn_root: '826473019',
        dataset_sources: ['cra', 'fed', 'ab'], score: 87, score_max: 100, score_label: 'High Performing',
        narrative: 'Serves 14 remote northern communities with education and literacy programming. Achieves a 83% program delivery rate on $5.6M combined CRA/FED/AB funding — remarkable for a remote-delivery organization — and has maintained this efficiency for 7 consecutive years.',
        flags: ['83% program delivery rate', '14 remote communities served', '$5.6M cross-dataset funding', '7-year consistent efficiency record', 'Remote delivery overhead premium justified'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Indigenous Reconciliation', risk_level: 'low', policy_note: 'Remote community delivery with verified 7-year track record is a gold standard for reconciliation-aligned infrastructure spend.' }
      },
      {
        id: 'ent_025', canonical_name: 'Treaty Education Foundation', bn_root: '937182645',
        dataset_sources: ['cra', 'fed'], score: 85, score_max: 100, score_label: 'High Performing',
        narrative: 'Specializes in treaty rights education and reconciliation curriculum development for K-12 schools. With $3.2M in federal funding and an 86% program spending ratio, it has partnered with 47 school boards and reached over 120,000 students since 2020.',
        flags: ['86% program spending ratio', '47 school board partnerships', '120,000+ students reached (since 2020)', '$3.2M federal funding', 'Zero amendment events', 'CRA risk score: 2/30 (exemplary)'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Indigenous Reconciliation', risk_level: 'low', policy_note: 'K-12 curriculum reach at scale is a force-multiplier for reconciliation goals — strong candidate for multi-year funding commitment.' }
      }
    ]
  },

  health_good: {
    mode: 'good_actor',
    total_found: 31,
    sql_generated: `SELECT e.id, e.canonical_name, e.bn_root, e.dataset_sources,
       o.program_spending_ratio, o.total_revenue,
       f.total_funding AS fed_funding, f.amendment_count,
       ROUND((o.program_spending_ratio * 55 + (1 - o.overhead_ratio) * 30
              + CASE WHEN f.amendment_count = 0 THEN 10 ELSE 0 END) :: numeric, 1) AS efficiency_score
FROM general.entity_golden_records e
JOIN cra.overhead_by_charity o ON o.bn = e.bn_root
LEFT JOIN fed.recipient_risk_profile f ON f.bn = e.bn_root
WHERE (e.cra_profile->>'program_areas' ILIKE '%mental health%'
   OR e.fed_profile->>'program' ILIKE '%mental health%'
   OR e.cra_profile->>'program_areas' ILIKE '%counselling%')
  AND o.program_spending_ratio > 0.82
  AND o.overhead_ratio < 0.18
  AND f.amendment_count < 3
ORDER BY efficiency_score DESC
LIMIT 15`,
    results: [
      {
        id: 'ent_031', canonical_name: 'Youth Mental Health Network', bn_root: '284716539',
        dataset_sources: ['cra', 'fed'], score: 96, score_max: 100, score_label: 'Exemplary',
        narrative: 'Received $3.2M in federal mental health funding with a 94% program spending ratio and zero governance red flags. Verified outcomes from program descriptions include 12,400 youth served with crisis counselling and peer support — a cost-per-client of approximately $258, well below sector benchmarks.',
        flags: ['94% program spending ratio', '$3.2M federal funding', '12,400 youth served (verified)', 'Cost per client: ~$258 (below sector avg)', 'Zero governance flags', '5-year consistent T3010 record'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Health Infrastructure', risk_level: 'low', policy_note: 'Mental health funding is growing under the $5B Health Infrastructure Fund — this organization\'s verified outcomes make it a priority renewal candidate.' }
      },
      {
        id: 'ent_032', canonical_name: 'Community Wellness Foundation', bn_root: '471836205',
        dataset_sources: ['cra', 'fed', 'ab'], score: 91, score_max: 100, score_label: 'Exemplary',
        narrative: 'Tri-dataset verified organization operating 8 community wellness clinics across urban and rural Alberta. Achieves 91% program spending on $6.1M in combined funding, with a volunteer workforce that extends program reach by an estimated 40% beyond paid staff capacity.',
        flags: ['91% program spending ratio', '8 clinics (urban + rural)', '$6.1M combined funding', 'Volunteer workforce multiplier: ~40%', 'Charity Intelligence Canada: A rating', 'Zero CRA/FED risk flags'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Health Infrastructure', risk_level: 'low', policy_note: 'Rural health delivery with high volunteer leverage is explicitly called out in Health Canada\'s 2025-26 departmental plan as a model to scale.' }
      },
      {
        id: 'ent_033', canonical_name: 'Mind Matters Canada', bn_root: '593047182',
        dataset_sources: ['cra', 'fed'], score: 88, score_max: 100, score_label: 'High Performing',
        narrative: 'National mental health literacy organization with 6-year funding track record. Produces open-access curriculum used by 230 schools and maintains an 88% program spending ratio on $2.8M annual federal funding. Single amendment event in 6 years — a model of grant stability.',
        flags: ['88% program spending ratio', '230 schools using curriculum', '$2.8M federal funding (annual)', '1 amendment in 6 years', 'Open-access program materials', 'National multi-province reach'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Health Infrastructure', risk_level: 'low', policy_note: 'National reach with open-access deliverables creates lasting public value — strong case for multi-year grant commitment.' }
      },
      {
        id: 'ent_034', canonical_name: 'Mental Health Support Collective', bn_root: '628394017',
        dataset_sources: ['cra', 'fed'], score: 86, score_max: 100, score_label: 'High Performing',
        narrative: 'Peer-led mental health organization with a unique model: 78% of program staff have lived experience of mental illness. Consistently achieves 85% program spending on $1.9M in funding and has expanded to 3 new cities without requesting additional overhead.',
        flags: ['85% program spending ratio', '78% peer-staff model (lived experience)', 'Expansion to 3 cities, zero overhead request', '$1.9M federal funding', 'Innovative delivery model', 'CRA risk score: 3/30 (excellent)'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Health Infrastructure', risk_level: 'low', policy_note: 'Peer-led models are specifically highlighted in the 2025 Mental Health Strategy as a priority funding approach.' }
      },
      {
        id: 'ent_035', canonical_name: 'Resilience Care Society', bn_root: '739481026',
        dataset_sources: ['cra', 'fed', 'ab'], score: 84, score_max: 100, score_label: 'High Performing',
        narrative: 'Serves primarily rural and remote communities in Alberta, filling a gap that provincial health services do not cover. Achieves 84% program spending despite the higher unit costs of remote service delivery, verified across CRA T3010, federal grants, and Alberta health ministry records.',
        flags: ['84% program spending ratio (remote-adjusted)', 'Rural gap-filler: no provincial alternative', 'Tri-dataset verified', '$4.4M combined funding', 'Zero governance concerns', 'AB Health Ministry commendation 2023'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Health Infrastructure', risk_level: 'low', policy_note: 'Rural health delivery with government commendation is an ideal candidate for the $5B Health Infrastructure Fund announced in Budget 2025.' }
      }
    ]
  },

  crossdata: {
    mode: 'mixed',
    total_found: 47,
    sql_generated: `SELECT e.id, e.canonical_name, e.bn_root, e.dataset_sources,
       f.total_funding AS fed_grants, f.department,
       ab.sole_source_count, ab.sole_source_total,
       f.amendment_count,
       CASE WHEN ab.sole_source_count > 3 THEN 'elevated' ELSE 'moderate' END AS risk_tier
FROM general.entity_golden_records e
JOIN fed.recipient_risk_profile f ON f.bn = e.bn_root
JOIN (
  SELECT vendor_bn, COUNT(*) AS sole_source_count, SUM(contract_value) AS sole_source_total
  FROM ab.ab_sole_source
  WHERE vendor_bn IS NOT NULL
  GROUP BY vendor_bn
) ab ON ab.vendor_bn = e.bn_root
WHERE f.total_funding > 500000
  AND ab.sole_source_count >= 1
ORDER BY (f.total_funding + ab.sole_source_total) DESC
LIMIT 15`,
    results: [
      {
        id: 'ent_041', canonical_name: 'Infrastructure Partners Ltd.', bn_root: '481729360',
        dataset_sources: ['fed', 'ab'], score: 24, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Cross-dataset analysis reveals this for-profit entity received $3.8M in federal infrastructure grants while simultaneously holding 7 sole-source Alberta contracts totalling $2.1M — all awarded by the same provincial ministry. This dual public-funding relationship is only visible when federal and provincial datasets are joined.',
        flags: ['$3.8M federal grants (infrastructure)', '7 AB sole-source contracts: $2.1M', 'Same provincial ministry: dual relationship', 'No competitive tender for AB contracts', 'Cross-dataset match: only visible via entity resolution'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Infrastructure', risk_level: 'medium', policy_note: 'Infrastructure is a $115B federal priority — dual public-funding without competitive procurement warrants scrutiny at scale.' }
      },
      {
        id: 'ent_042', canonical_name: 'Northern Services Group', bn_root: '362847091',
        dataset_sources: ['fed', 'ab'], score: 21, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Operates as a consulting firm with federal grant eligibility as a "nonprofit advisory organization." CRA records show it has 2 employees; federal grants total $1.4M. Meanwhile, Alberta government data shows 5 sole-source service contracts worth $890K — bringing its total public-sector revenue to $2.3M with no competitive procurement.',
        flags: ['2 employees vs $2.3M total public revenue', '$1.4M federal grants', '5 AB sole-source contracts: $890K', 'Sole-source justification: "urgency" (all 5)', 'Nonprofit classification with for-profit behaviour'],
        policy_pulse: { alignment: 'neutral', priority_area: 'Productivity', risk_level: 'medium', policy_note: 'Consulting firms using nonprofit status to access grant streams is a known accountability gap this system can uniquely detect.' }
      },
      {
        id: 'ent_043', canonical_name: 'Capital Region Consulting Inc.', bn_root: '519374028',
        dataset_sources: ['fed', 'ab'], score: 18, score_max: 35, score_label: 'Moderate Risk',
        narrative: 'Received $760K from the federal Economic Development Agency while holding 3 Alberta sole-source contracts in the same fiscal year. Though individually below typical audit thresholds, the combined public revenue of $1.3M and lack of competitive processes represents a concentration worth monitoring.',
        flags: ['$760K federal economic development grant', '3 AB sole-source contracts: $540K', 'Combined public revenue $1.3M', 'Below individual audit thresholds — only visible cross-dataset', 'Single fiscal year concentration'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Productivity', risk_level: 'low', policy_note: 'Below individual program thresholds but cross-dataset pattern is worth flagging; sector aligns with $110B productivity priority.' }
      },
      {
        id: 'ent_044', canonical_name: 'Provincial Infrastructure Corp.', bn_root: '647038291',
        dataset_sources: ['fed', 'ab'], score: 26, score_max: 35, score_label: 'Elevated Risk',
        narrative: 'Has received federal infrastructure grants for 6 consecutive years while the same entity (under a slightly different name, resolved via entity matching) holds Alberta Ministry of Transportation contracts. T3010 and fed data combined show $9.1M in cumulative public funding — none via competitive procurement.',
        flags: ['$9.1M cumulative public funding (6 years)', 'Entity alias resolved: "Prov. Infra Corp" ↔ "Provincial Infrastructure Corporation"', 'Zero competitive procurement across all funding', 'Federal + AB Ministry of Transportation dual relationship', '6-year consecutive funding with no evaluation event'],
        policy_pulse: { alignment: 'aligned', priority_area: 'Infrastructure', risk_level: 'high', policy_note: 'Long-term sole-source concentration in the $115B infrastructure priority area is a top-tier Auditor General target.' }
      },
      {
        id: 'ent_045', canonical_name: 'Resource Management Solutions', bn_root: '728394610',
        dataset_sources: ['fed', 'ab'], score: 15, score_max: 35, score_label: 'Moderate Risk',
        narrative: 'A relatively small operator with $420K in federal grants and 2 sole-source provincial contracts. The entity resolution system matched this organization to two previously separate records in the federal and Alberta databases — demonstrating the value of cross-dataset identity resolution even for lower-value actors.',
        flags: ['$420K federal grants', '2 AB sole-source contracts: $290K', 'Entity resolved from 2 separate database records', 'Different names in federal vs AB data', 'Combined public revenue only visible post-resolution'],
        policy_pulse: { alignment: 'neutral', priority_area: 'Resource Management', risk_level: 'low', policy_note: 'Lower risk profile individually; notable primarily as a demonstration of entity resolution uncovering hidden relationships.' }
      }
    ]
  }

};

// ─── Mock Web Intelligence ───────────────────────────────────────────────────

const MOCK_WEB_INTEL = {

  '847291630': {
    news_mentions: [
      { headline: 'Green Future Foundation under formal CRA audit, sources say', source: 'CBC News', date: '2024-11-12', sentiment: 'negative' },
      { headline: 'Director of environmental charity linked to dissolved shell company', source: 'Globe and Mail', date: '2024-08-03', sentiment: 'negative' },
      { headline: 'Watchdog flags circular grant flows in Canadian environmental sector', source: 'The Logic', date: '2024-05-28', sentiment: 'negative' }
    ],
    registry_status: 'Active — last annual return filed 2023 (2024 overdue)',
    red_flags_found: ['CRA audit initiated November 2024', 'Director bankruptcy filing 2022 (not disclosed in T3010)', 'No public-facing program outcomes since 2021', 'Website shows outdated 2019 project photos'],
    positive_signals: [],
    web_summary: 'CBC News reported in November 2024 that the CRA opened a formal audit of Green Future Foundation following whistleblower complaints. The Globe and Mail independently identified a director link to a dissolved Alberta shell company. No positive public outcome reporting has been found.'
  },

  '203948571': {
    news_mentions: [
      { headline: 'Affordable housing charity\'s executive pay draws scrutiny', source: 'Toronto Star', date: '2025-02-14', sentiment: 'negative' },
      { headline: 'New housing grants: who actually benefits?', source: 'Policy Options', date: '2025-01-08', sentiment: 'negative' }
    ],
    registry_status: 'Active — filings current',
    red_flags_found: ['Executive compensation: $340K/year (not disclosed in federal grant application)', 'No housing units attributable to organization in public records', 'Charity Intelligence Canada: D rating (efficiency)'],
    positive_signals: ['Organization has active community partnerships listed on website'],
    web_summary: 'The Toronto Star raised concerns about executive compensation relative to program outcomes in February 2025. Charity Intelligence Canada rates this organization D for financial efficiency. No independently verifiable housing units have been attributed to the organization.'
  },

  '394827165': {
    news_mentions: [
      { headline: 'First Nations Education Council recognized for student outcomes', source: 'National Post', date: '2025-03-22', sentiment: 'positive' },
      { headline: 'Indigenous education funding model praised by Parliamentary committee', source: 'CBC News', date: '2024-10-15', sentiment: 'positive' },
      { headline: 'Rural Indigenous schools see literacy gains — report', source: 'Globe and Mail', date: '2024-07-09', sentiment: 'positive' }
    ],
    registry_status: 'Active — filings current, in good standing',
    red_flags_found: [],
    positive_signals: ['Parliamentary committee commendation (Oct 2024)', 'Charity Intelligence Canada: A+ rating', 'Annual impact report published each year since 2019', 'Listed as model organization in CIRNAC reconciliation report'],
    web_summary: 'First Nations Education Council has received consistent positive coverage and government recognition. A Parliamentary committee specifically cited this organization as a model for outcomes-based Indigenous education funding in October 2024. Charity Intelligence rates it A+.'
  },

  '284716539': {
    news_mentions: [
      { headline: 'Youth mental health organization expands to 3 new cities on same budget', source: 'CBC News', date: '2025-01-30', sentiment: 'positive' },
      { headline: 'Peer support model cuts crisis response costs by 40%, study finds', source: 'Globe and Mail', date: '2024-09-11', sentiment: 'positive' }
    ],
    registry_status: 'Active — filings current, in good standing',
    red_flags_found: [],
    positive_signals: ['Charity Intelligence Canada: A rating', 'Independent program evaluation: outcomes verified', 'CAMH partnership for service delivery', 'Featured in Health Canada best practices guide'],
    web_summary: 'Youth Mental Health Network has received strong independent validation. A 2024 Globe and Mail report cited a study showing their peer support model reduces crisis response costs by 40%. They are featured in Health Canada\'s mental health best practices guide and partnered with CAMH.'
  },

  'default': {
    news_mentions: [
      { headline: 'No major news coverage found for this organization', source: 'Web search result', date: '2025-04-01', sentiment: 'neutral' }
    ],
    registry_status: 'Status could not be confirmed — limited web presence',
    red_flags_found: [],
    positive_signals: ['No negative coverage found'],
    web_summary: 'Limited public web presence for this organization. No news coverage, third-party ratings, or government audit references were found. This may indicate a small community organization operating below media visibility threshold, or a recently formed entity.'
  }

};

// ─── Scenario Detection ──────────────────────────────────────────────────────

function detectScenario(query) {
  const q = (query || '').toLowerCase();
  if (/environ|climat|circular|green|loop|ecosyst/.test(q)) return 'env_bad';
  if (/housing|afford|shelter|home|overhead|depend/.test(q)) return 'housing_bad';
  if (/indigenous|first.?nation|m[eé]tis|reconcil|treaty|native|inuit/.test(q)) return 'indigenous_good';
  if (/mental.?health|wellness|counsel|psychiatr|psycholog|wellbeing/.test(q)) return 'health_good';
  if (/sole.?source|dual.?fund|alberta.*federal|federal.*alberta|contractor|vendor/.test(q)) return 'crossdata';
  return 'indigenous_good';
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/ai-search', async (req, res) => {
  try {
    await mockDelay();
    const { query } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ error: 'Query required' });
    const scenario = detectScenario(query);
    const result = MOCK_RESULTS[scenario];
    res.json({ ...result, query: query.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/entity/:bn/web-intel', async (req, res) => {
  try {
    await shortDelay();
    const data = MOCK_WEB_INTEL[req.params.bn] || MOCK_WEB_INTEL['default'];
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Funding heatmap ─────────────────────────────────────────────────────────
//
// Seeds the realtime heatmap demo. The page generates ticks client-side; this
// endpoint just sets the starting amounts so the demo opens with a coherent
// snapshot regardless of refresh order. Vertical names + quarter count must
// stay in sync with VERTICALS / QUARTERS in heatmap.html.

const HEATMAP_SEED = {
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
  ]
};

app.get('/api/funding-heatmap', (req, res) => {
  // Apply a tiny per-call drift so the seed feels live across reloads
  const jitter = HEATMAP_SEED.rows.map(r => ({
    vertical: r.vertical,
    amounts: r.amounts.map(a => Math.max(8, Math.round(a + (Math.random() - 0.5) * a * 0.05)))
  }));
  res.json({ quarters: HEATMAP_SEED.quarters, rows: jitter, generated_at: new Date().toISOString() });
});

// ─── Action Plan (Opus 4.7) ──────────────────────────────────────────────────
//
// POST /api/action-plan
// Body: { vertical, quarters, amounts, source_filter, recent_signals }
// Returns a structured action plan. Uses Claude Opus 4.7 with adaptive
// thinking + structured JSON output and prompt caching when ANTHROPIC_API_KEY
// is set. Falls back to a deterministic templated plan otherwise so the demo
// works without API keys.

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
  const sourceLabel = source_filter === 'all' ? 'all sources' : source_filter.toUpperCase();
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
    forecast_band: {
      low: Math.max(8, Math.round(pred * 0.9)),
      mid: pred,
      high: Math.round(pred * 1.1)
    },
    fallback: true,
    model_label: 'fallback (template)',
    cache_hits: '—'
  };
}

function extractJSONFromContent(content) {
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

  // No API key → templated fallback
  if (!anthropic) {
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

    const plan = extractJSONFromContent(response.content);
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

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || process.env.MOCK_PORT || 3802;
app.listen(PORT, () => {
  console.log(`\n🎯  Mock demo server running`);
  console.log(`    → http://localhost:${PORT}/search.html`);
  console.log(`    → http://localhost:${PORT}/heatmap.html\n`);
});
