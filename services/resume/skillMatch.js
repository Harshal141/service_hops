// Skill matching, pure half. The stored result keeps skill NAMES; every response that
// returns a draft resolves them against the live skill table (one query, done by
// aiEnrichmentService.findActiveSkills) so ids never go stale in the cache.

// Common spellings → the canonical lowercase name we expect in the skill table.
const ALIASES = Object.freeze({
  'reactjs': 'react', 'react.js': 'react', 'react js': 'react',
  'nodejs': 'node.js', 'node': 'node.js', 'node js': 'node.js',
  'vuejs': 'vue.js', 'vue': 'vue.js',
  'nextjs': 'next.js', 'next': 'next.js',
  'golang': 'go',
  'js': 'javascript', 'ts': 'typescript',
  'postgres': 'postgresql', 'k8s': 'kubernetes',
  'amazon web services': 'aws', 'gcp': 'google cloud',
});

const canonical = (name) => {
  const lower = name.trim().toLowerCase();
  return ALIASES[lower] ?? lower;
};

/** Lowercase names to look up: each name and its alias target. */
function lookupNames(names) {
  const out = new Set();
  for (const n of names) {
    out.add(n.trim().toLowerCase());
    out.add(canonical(n));
  }
  return [...out];
}

/**
 * names: skill_names from the stored draft. rows: [{ id, name }] active level-3 skills whose
 * lower(name) is in lookupNames(names). Exact (case-insensitive) match first, then alias.
 */
function matchSkills(names, rows) {
  const byLower = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const skills = [];
  const unmatched = [];
  const seen = new Set();
  for (const n of names) {
    const row = byLower.get(n.trim().toLowerCase()) ?? byLower.get(canonical(n));
    if (!row) { unmatched.push(n); continue; }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    skills.push({ key: `skill-${row.id}`, id: row.id, name: row.name });
  }
  return { skills, unmatched_skills: unmatched };
}

module.exports = { lookupNames, matchSkills };
