// Schema + taxonomy validation.
//   --static : file-level checks only (no database)
//   default  : also boots an ephemeral DB, applies migrations, and verifies the
//              security posture (RLS enabled+forced everywhere, zero anon grants,
//              policies present, skills seed matches taxonomy).
// The taxonomy is validated against the REAL index.html (parsed live), so this
// fails loudly if the game's curriculum and the data layer ever drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { root, loadTaxonomy, parseGame, ephemeralDb, applyMigrations, seedSkills } from './lib.mjs';

const problems = [];
const ok = (msg) => console.log('  ✓', msg);
const bad = (msg) => { problems.push(msg); console.error('  ✗', msg); };

// ---------------- static checks ----------------
console.log('STATIC checks (taxonomy vs the real game code):');
const tax = loadTaxonomy();
const game = parseGame();

const taxIds = tax.skills.map(s => s.id);
if (JSON.stringify(taxIds) === JSON.stringify(game.stageKeys)) {
  ok(`taxonomy covers all ${game.stageKeys.length} stage keys in the game's ladder order`);
} else {
  bad(`taxonomy ids != game STAGES keys.\n    game: ${game.stageKeys.join(',')}\n    tax : ${taxIds.join(',')}`);
}

const positions = tax.skills.map(s => s.position);
if (JSON.stringify(positions) === JSON.stringify(positions.map((_, i) => i))) ok('positions are contiguous 0..n-1');
else bad('taxonomy positions are not contiguous 0..n-1');

const taxTags = new Set();
for (const s of tax.skills) { taxTags.add(s.category); for (const a of s.altCategories) taxTags.add(a); }
const missingTags = game.skillTags.filter(t => !taxTags.has(t));
const extraTags = [...taxTags].filter(t => !game.skillTags.includes(t));
if (!missingTags.length && !extraTags.length) ok(`all ${game.skillTags.length} game skill tags covered, no extras`);
else bad(`skill-tag mismatch — missing: [${missingTags}] extra: [${extraTags}]`);

for (const s of tax.skills) {
  if (!s.ccss.length && !s.ccssGap) bad(`${s.id}: no CCSS codes and no ccssGap explanation`);
  if (s.ccss.some(c => !/^[K1-8]\.[A-Z]{1,3}\.[A-Z]\.\d+$/.test(c))) bad(`${s.id}: malformed CCSS code`);
}
ok('every skill has CCSS codes (or an explicit flagged gap)');

const dataMap = fs.readFileSync(path.join(root, 'docs', 'DATA_MAP.md'), 'utf8');
const unmapped = taxIds.filter(id => !dataMap.includes('`' + id + '`'));
if (!unmapped.length) ok('docs/DATA_MAP.md mentions every skill id');
else bad(`docs/DATA_MAP.md missing: ${unmapped.join(', ')}`);

// ---------------- database checks ----------------
if (!process.argv.includes('--static')) {
  console.log('\nDATABASE checks (ephemeral Postgres):');
  const db = await ephemeralDb();
  try {
    await applyMigrations(db.client, { local: true });
    const n = await seedSkills(db.client);

    const NEW_TABLES = ['skills', 'children', 'consent_ledger', 'attempts', 'sessions',
                        'child_skill_mastery', 'child_skill_misconception',
                        'tutor_grants', 'rpc_rate_limits',
                        // group engine (0007/0008) — S0 gate: every group table must be RLS-forced
                        'groups', 'memberships', 'channels', 'channel_members', 'events',
                        'suppressions', 'derivation_rules', 'derivation_outbox',
                        // S3b (0042): the academy staff background-check clearance surface
                        'academy_staff_clearances',
                        // S4 (0043): the pending cross-family add lane (RPC-only; no membership)
                        'membership_requests',
                        // S5b (0045): the standalone-leader ID-verification clearance surface
                        'standalone_leader_clearances',
                        // S6 (0046): the adult-scoped removal/flag accountability record
                        'membership_removals'];
    // deny-by-default tables that intentionally have ZERO policies (definer/service only)
    const NO_CLIENT_TABLES = ['rpc_rate_limits', 'derivation_outbox', 'academy_staff_clearances', 'membership_requests', 'standalone_leader_clearances'];

    const rls = await db.client.query(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and relkind = 'r' and relname = any($1)`, [NEW_TABLES]);
    for (const r of rls.rows) {
      if (r.relrowsecurity && r.relforcerowsecurity) ok(`RLS enabled+forced on ${r.relname}`);
      else bad(`RLS not enabled+forced on ${r.relname}`);
    }
    if (rls.rows.length !== NEW_TABLES.length) bad('some expected tables are missing');

    const anonGrants = await db.client.query(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'anon' and table_schema = 'public'`);
    if (!anonGrants.rows.length) ok('zero grants to anon on public tables (game key can never reach child data)');
    else bad(`anon has grants: ${JSON.stringify(anonGrants.rows)}`);

    const pol = await db.client.query(
      `select tablename, count(*)::int as n from pg_policies where schemaname='public' group by tablename`);
    const polMap = Object.fromEntries(pol.rows.map(r => [r.tablename, r.n]));
    for (const t of NEW_TABLES) {
      if (NO_CLIENT_TABLES.includes(t)) {
        if (!polMap[t]) ok(`${t}: zero policies (intentional — service/definer-only, deny-by-default)`);
        else bad(`${t}: expected ZERO policies (service-only table) but found ${polMap[t]}`);
      } else if (polMap[t] > 0) ok(`${t}: ${polMap[t]} RLS polic${polMap[t] > 1 ? 'ies' : 'y'}`);
      else bad(`${t}: no RLS policies (deny-by-default blocks clients, but spec expects explicit owner policies)`);
    }

    // SELF-EXTENDING GUARD (no silent gap): EVERY public table carrying a child/group key must be
    // RLS enabled+forced — so a future group-scoped child-keyed table (an S5a grant table,
    // attendance, etc.) cannot ship without RLS even if it is never added to NEW_TABLES.
    const keyed = await db.client.query(`
      select distinct c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
       where c.relkind = 'r'
         and a.attname = any(array['child_id','group_id','member_child_id','subject_child_id'])
       order by c.relname`);
    let keyedBad = 0;
    for (const r of keyed.rows) {
      if (!(r.relrowsecurity && r.relforcerowsecurity)) { bad(`child/group-keyed table ${r.relname} is NOT RLS enabled+forced`); keyedBad++; }
    }
    if (!keyedBad) ok(`all ${keyed.rows.length} child/group-keyed tables are RLS enabled+forced (self-extending guard)`);

    const cnt = await db.client.query(`select count(*)::int as n from public.skills`);
    if (cnt.rows[0].n === n && n === tax.skills.length) ok(`skills seed matches taxonomy (${n} rows)`);
    else bad(`skills seed mismatch: db=${cnt.rows[0].n} taxonomy=${tax.skills.length}`);
  } finally {
    await db.stop();
  }
}

console.log('');
if (problems.length) { console.error(`FAILED — ${problems.length} problem(s)`); process.exit(1); }
console.log('ALL CHECKS PASSED');
