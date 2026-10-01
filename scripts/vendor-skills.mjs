// Re-vendors templates/skills/ from the commit pinned in its UPSTREAM.json: edit the pin, run this,
// review the diff. Generated rather than hand-copied so the vendored bytes come from that commit.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../templates/skills/', import.meta.url));
const upstream = JSON.parse(readFileSync(path.join(dir, 'UPSTREAM.json'), 'utf8'));
// A branch or tag here would float the vendored copy; only a full commit SHA is a pin.
if (!/^[0-9a-f]{40}$/.test(upstream.commit)) throw new Error(`UPSTREAM.json commit is not a full SHA: ${upstream.commit}`);
// Same segment rule as src/templates.ts: a key of ".." would rmSync templates/ itself.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function fetchRaw(rel) {
  const url = `https://raw.githubusercontent.com/${upstream.repo}/${upstream.commit}/${rel}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// Everything is fetched and patched in memory first, so a 404 or a stale patch leaves the tree untouched.
const out = new Map([['LICENSE', await fetchRaw('LICENSE')]]);
for (const [name, skill] of Object.entries(upstream.skills)) {
  for (const seg of [name, ...skill.files]) if (!SAFE_SEGMENT.test(seg)) throw new Error(`unsafe path segment in UPSTREAM.json: ${JSON.stringify(seg)}`);
  for (const file of skill.files) out.set(`${name}/${file}`, await fetchRaw(`${skill.path}/${file}`));
}
// Exactly one match or abort: a re-pin where upstream reworded the text must not ship it unpatched.
for (const { file, find, replace } of upstream.patches ?? []) {
  const text = out.get(file);
  if (text === undefined) throw new Error(`patch targets ${file}, which UPSTREAM.json does not vendor`);
  const hits = text.split(find).length - 1;
  if (hits !== 1) throw new Error(`patch for ${file} matched ${hits} times, expected 1 — re-check it against the new pin`);
  out.set(file, text.replace(find, () => replace));
}

for (const name of Object.keys(upstream.skills)) rmSync(path.join(dir, name), { recursive: true, force: true });
for (const [rel, text] of out) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}
console.log(`vendored ${Object.keys(upstream.skills).length} skills from ${upstream.repo}@${upstream.commit}`);
