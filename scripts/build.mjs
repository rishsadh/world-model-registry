// Build script for the world model output registry.
// Node standard library only. Validates data/registry.json against data/schema.json,
// then writes README.md (from templates/README.template.md) and dist/index.html.
// Output is deterministic: a second run produces no diff.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const schema = JSON.parse(read('data/schema.json'));
const data = JSON.parse(read('data/registry.json'));

// ---------- Minimal JSON Schema validator (the subset used by data/schema.json) ----------

function resolveRef(ref) {
  if (!ref.startsWith('#/')) throw new Error('Only local $ref supported: ' + ref);
  return ref.slice(2).split('/').reduce((o, k) => o[k], schema);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validate(value, sch, path, errors) {
  if (sch.$ref) return validate(value, resolveRef(sch.$ref), path, errors);
  if (sch.oneOf) {
    const results = sch.oneOf.map((s) => { const e = []; validate(value, s, path, e); return e; });
    const ok = results.filter((e) => e.length === 0).length;
    if (ok !== 1) errors.push(`${path}: expected exactly one of ${sch.oneOf.length} shapes to match, ${ok} matched`);
    return;
  }
  if ('const' in sch && value !== sch.const) errors.push(`${path}: expected ${JSON.stringify(sch.const)}`);
  if (sch.enum && !sch.enum.includes(value)) errors.push(`${path}: expected one of ${sch.enum.join(', ')}`);
  if (sch.type) {
    const t = typeOf(value);
    const want = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!want.includes(t)) { errors.push(`${path}: expected ${want.join('|')}, got ${t}`); return; }
  }
  if (typeOf(value) === 'string') {
    if (sch.minLength !== undefined && value.length < sch.minLength) errors.push(`${path}: shorter than ${sch.minLength}`);
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) errors.push(`${path}: does not match ${sch.pattern}`);
  }
  if (typeOf(value) === 'array') {
    if (sch.minItems !== undefined && value.length < sch.minItems) errors.push(`${path}: fewer than ${sch.minItems} items`);
    if (sch.items) value.forEach((v, i) => validate(v, sch.items, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    const props = sch.properties || {};
    (sch.required || []).forEach((k) => { if (!(k in value)) errors.push(`${path}: missing required "${k}"`); });
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(v, props[k], `${path}.${k}`, errors);
      else if (sch.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
    }
  }
}

const errors = [];
validate(data, schema, '$', errors);

// ---------- Registry rules beyond the schema ----------

const today = data.meta.last_verified;
const all = [...data.exportable, ...data.streamed, ...data.object_only];
const ids = new Set();
for (const e of all) {
  if (ids.has(e.id)) errors.push(`duplicate id ${e.id}`);
  ids.add(e.id);
  if (e.last_verified !== today) errors.push(`${e.id}: last_verified ${e.last_verified} is not ${today}`);
}
const host = (u) => new URL(u).hostname.replace(/^www\./, '');
const rootOf = (h) => h.split('.').slice(-2).join('.');
const sameOrg = (a, b) => host(a) === host(b) || rootOf(host(a)) === rootOf(host(b));
for (const e of [...data.exportable, ...data.streamed]) {
  if (e.sources.length < 2) errors.push(`${e.id}: fewer than two sources`);
  const vendorHosted = e.sources.some((s) => sameOrg(s, e.vendor_url));
  const codeHosted = e.sources.some((s) => /github\.com|huggingface\.co/.test(host(s)));
  if (!vendorHosted && !codeHosted) errors.push(`${e.id}: no source on the vendor's own domain`);
}
const sentenceCount = (s) => s.split(/(?<=[.!?])\s+/).filter(Boolean).length;
for (const e of data.exportable) {
  for (const c of e.commercial_rights) {
    if (c.status === 'quoted' && !(c.section && c.quote && c.url)) errors.push(`${e.id}: commercial right "${c.tier}" is quoted but lacks section, quote or url`);
    if (c.conflict && !(c.conflict_section && c.conflict_quote && c.conflict_url)) errors.push(`${e.id}: conflict on "${c.tier}" lacks section, quote or url`);
  }
  if (sentenceCount(e.notes) > 3) errors.push(`${e.id}: notes has ${sentenceCount(e.notes)} sentences, max 3`);
}
for (const e of data.streamed) {
  if (e.notes && sentenceCount(e.notes) > 3) errors.push(`${e.id}: notes has ${sentenceCount(e.notes)} sentences, max 3`);
}
// Registry prose must be free of opinion words and em dashes. Verbatim quotes are exempt.
const banned = /\b(impressive|limited|best for|revolutionary|game-changing|powerful|stunning|amazing)\b/i;
const proseKey = /(^|\.)(notes|summary\.[a-z_]+|what_it_shows|why_no_export|price|scope)$/;
const quoteKey = /(quote|conflict_quote|includes|limits|detail|dated)/;
const scan = (obj, path) => {
  if (typeof obj === 'string') {
    if (proseKey.test(path) && banned.test(obj)) errors.push(`${path}: contains opinion word "${obj.match(banned)[0]}"`);
    if (/—/.test(obj) && !quoteKey.test(path)) errors.push(`${path}: contains an em dash`);
  } else if (Array.isArray(obj)) obj.forEach((v, i) => scan(v, `${path}[${i}]`));
  else if (obj && typeof obj === 'object') Object.entries(obj).forEach(([k, v]) => scan(v, path ? `${path}.${k}` : k));
};
scan(data, '');

if (errors.length) {
  console.error(`Validation failed with ${errors.length} error(s):`);
  errors.forEach((e) => console.error('  ' + e));
  process.exit(1);
}
console.log(`Validation passed: ${data.exportable.length} exportable, ${data.streamed.length} streamed, ${data.object_only.length} object-level names.`);

// ---------- Helpers ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const CREDIT = 'Rish Sadh, founder of Reidify, an AI-first design studio in Mumbai.';
const NAME = 'World model registry';
const TAGLINE = 'What you actually get as a file, what it costs, and what you are allowed to do with it.';

// ---------- README ----------

const exportableRows = data.exportable.map((e) => `| [${mdCell(e.name)}](#${e.id}) | ${mdCell(e.vendor)} | ${mdCell(e.summary.you_get)} | ${mdCell(e.summary.price)} | ${mdCell(e.summary.rights)} | ${mdCell(e.summary.local)} | ${e.last_verified} |`).join('\n');
const streamedRows = data.streamed.map((e) => `| [${mdCell(e.name)}](#${e.id}) | ${mdCell(e.vendor)} | ${mdCell(e.what_it_shows)} | ${mdCell(e.why_no_export)} | ${mdCell(e.price)} | ${e.last_verified} |`).join('\n');
const objectList = data.object_only.map((e) => `- ${e.name} (${e.vendor}): ${e.vendor_url}`).join('\n');

const mdClause = (c) => `- ${c.topic ? c.topic + '. ' : ''}Section ${c.section}: "${c.quote}" ([source](${c.url}))`;

function mdExportableDetail(e) {
  const out = [];
  out.push(`### ${e.name}`, '', `<a id="${e.id}"></a>`, '', `Vendor: [${e.vendor}](${e.vendor_url}). Last verified ${e.last_verified}.`, '');
  out.push('**Inputs**', '');
  e.inputs.forEach((i) => out.push(`- ${i.type}${i.detail ? ' (' + i.detail + ')' : ''}: ${i.limits}. Tier: ${i.tier}`));
  out.push('', '**Outputs**', '');
  e.outputs.forEach((o) => out.push(`- ${o.format}${o.detail ? ': ' + o.detail : ''}. Tier: ${o.tier}`));
  out.push('', '**Tiers, as published**', '');
  e.tiers.forEach((t) => out.push(`- ${t.name}: ${t.price} ${t.currency} per ${t.billing_period}. ${t.includes.join(' ')} ([price page](${t.price_page_url}))`));
  out.push('', `**Licence:** [${e.licence.name}](${e.licence.url})${e.licence.dated ? '. ' + e.licence.dated : ''}`, '');
  out.push('**Commercial rights**', '');
  e.commercial_rights.forEach((c) => {
    if (c.status === 'not published') out.push(`- ${c.tier}: not published`);
    else {
      out.push(`- ${c.tier}. Section ${c.section}: "${c.quote}" ([source](${c.url}))`);
      if (c.conflict) out.push(`  - Conflict. ${c.conflict_section}: ${c.conflict_quote} ([source](${c.conflict_url}))`);
    }
  });
  out.push('', '**Restrictive clauses**', '');
  if (e.restrictive_clauses === 'not published') out.push('- not published');
  else e.restrictive_clauses.forEach((c) => out.push(mdClause(c)));
  out.push('', `**API:** ${e.api.status}${e.api.url !== 'not published' ? ', ' + e.api.url : ''}. Pricing: ${e.api.pricing}`, '');
  out.push(`**Runs locally:** ${e.runs_locally.value ? 'yes' : 'no'}. VRAM: ${e.runs_locally.vram}. Hardware: ${e.runs_locally.hardware}`, '');
  out.push(`**Open weights:** ${e.open_weights.value ? 'yes' : 'no'}. Licence: ${e.open_weights.licence}${e.open_weights.url ? ' (' + e.open_weights.url + ')' : ''}`, '');
  out.push(`**Notes:** ${e.notes}`, '');
  out.push('**Sources**', '');
  e.sources.forEach((s) => out.push(`- ${s}`));
  out.push('');
  return out.join('\n');
}

function mdStreamedDetail(e) {
  const out = [];
  out.push(`### ${e.name}`, '', `<a id="${e.id}"></a>`, '', `Vendor: [${e.vendor}](${e.vendor_url}). Last verified ${e.last_verified}.`, '');
  out.push(`**What it shows:** ${e.what_it_shows}`, '', `**Why nothing exports:** ${e.why_no_export}`, '', `**Price:** ${e.price}`, '');
  if (e.terms && e.terms.length) { out.push('**Terms**', ''); e.terms.forEach((c) => out.push(mdClause(c))); out.push(''); }
  if (e.notes) out.push(`**Notes:** ${e.notes}`, '');
  out.push('**Sources**', '');
  e.sources.forEach((s) => out.push(`- ${s}`));
  out.push('');
  return out.join('\n');
}

const fill = (tpl, map) => Object.entries(map).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(v), tpl);

const readme = fill(read('templates/README.template.md'), {
  TITLE: data.meta.title,
  VERSION: data.meta.version,
  LAST_VERIFIED: data.meta.last_verified,
  SCOPE: data.meta.scope,
  COUNT_EXPORTABLE: String(data.exportable.length),
  COUNT_STREAMED: String(data.streamed.length),
  COUNT_OBJECT: String(data.object_only.length),
  EXPORTABLE_TABLE: exportableRows,
  STREAMED_TABLE: streamedRows,
  OBJECT_LIST: objectList,
  EXPORTABLE_DETAILS: data.exportable.map(mdExportableDetail).join('\n'),
  STREAMED_DETAILS: data.streamed.map(mdStreamedDetail).join('\n'),
  CREDIT,
});
writeFileSync(join(root, 'README.md'), readme);

// ---------- HTML ----------

const css = `
:root{--fg:#1a1a1a;--muted:#5c5c5c;--line:#d9d9d9;--bg:#fbfbfa;--mark:#f1f0ec}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e6;--muted:#a3a3a0;--line:#3a3a3a;--bg:#161616;--mark:#222220}}
*{box-sizing:border-box}
html{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:var(--fg);background:var(--bg);-webkit-text-size-adjust:100%}
body{margin:0;padding:0 1rem 4rem}
main{max-width:64rem;margin:0 auto}
header{padding:3rem 0 2rem;border-bottom:1px solid var(--line)}
h1{font-size:1.75rem;font-weight:600;margin:0 0 .5rem;letter-spacing:-.01em}
h2{font-size:1.25rem;font-weight:600;margin:3rem 0 1rem}
h3{font-size:1rem;font-weight:600;margin:0}
p{margin:.5rem 0;max-width:44rem}
.muted{color:var(--muted)}
a{color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
table{width:100%;border-collapse:collapse;font-size:.9375rem}
th,td{text-align:left;vertical-align:top;padding:.75rem .5rem;border-top:1px solid var(--line)}
th{font-weight:600;border-top:0;color:var(--muted);font-size:.8125rem;text-transform:uppercase;letter-spacing:.04em}
tbody.entry tr.detail td{border-top:0;padding-top:0}
details summary{cursor:pointer;color:var(--muted);font-size:.875rem;list-style:none;display:inline-block;padding:.25rem 0}
details summary::before{content:"+ "}
details[open] summary::before{content:"\\2212 "}
details summary::-webkit-details-marker{display:none}
.panel{margin:.5rem 0 1rem;padding:1rem;background:var(--mark);font-size:.9rem}
.panel p{max-width:none}
.panel h4{margin:1rem 0 .25rem;font-size:.8125rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
.panel h4:first-child{margin-top:0}
.panel ul{margin:.25rem 0 .5rem;padding-left:1.25rem}
.panel li{margin:.25rem 0}
.panel q{quotes:"\\201C" "\\201D"}
.panel .conflict{border-left:2px solid var(--fg);padding-left:.75rem;margin:.5rem 0}
.panel a{word-break:break-all}
.ok{white-space:nowrap}
footer{margin-top:4rem;padding-top:1.5rem;border-top:1px solid var(--line);font-size:.875rem;color:var(--muted)}
footer p{margin:.25rem 0}
@media (max-width:700px){
  table,thead,tbody,tr,td,th{display:block;width:100%}
  thead{position:absolute;left:-9999px;top:-9999px}
  tbody.entry{border-top:1px solid var(--line);padding:1rem 0}
  tbody.entry td{border-top:0;padding:.25rem 0}
  tbody.entry tr.detail td{padding-top:.5rem}
  td[data-label]::before{content:attr(data-label);display:block;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .panel{padding:.75rem}
}
`;

const htmlClause = (c) => `<li>${c.topic ? esc(c.topic) + '. ' : ''}Section ${esc(c.section)}: <q>${esc(c.quote)}</q> <a href="${esc(c.url)}">source</a></li>`;
const htmlSources = (e) => `<h4>Sources, fetched ${esc(e.last_verified)}</h4><ul>${e.sources.map((s) => `<li><a href="${esc(s)}">${esc(s)}</a></li>`).join('')}</ul>`;

function htmlExportable(e) {
  const inputs = e.inputs.map((i) => `<li>${esc(i.type)}${i.detail ? ' (' + esc(i.detail) + ')' : ''}: ${esc(i.limits)}. Tier: ${esc(i.tier)}</li>`).join('');
  const outputs = e.outputs.map((o) => `<li>${esc(o.format)}${o.detail ? ': ' + esc(o.detail) : ''}. Tier: ${esc(o.tier)}</li>`).join('');
  const tiers = e.tiers.map((t) => `<li>${esc(t.name)}: ${esc(t.price)} ${esc(t.currency)} per ${esc(t.billing_period)}. ${esc(t.includes.join(' '))} <a href="${esc(t.price_page_url)}">price page</a></li>`).join('');
  const rights = e.commercial_rights.map((c) => c.status === 'not published'
    ? `<li>${esc(c.tier)}: not published</li>`
    : `<li>${esc(c.tier)}. Section ${esc(c.section)}: <q>${esc(c.quote)}</q> <a href="${esc(c.url)}">source</a>${c.conflict ? `<div class="conflict">Conflict. ${esc(c.conflict_section)}: ${esc(c.conflict_quote)} <a href="${esc(c.conflict_url)}">source</a></div>` : ''}</li>`).join('');
  const clauses = e.restrictive_clauses === 'not published' ? '<li>not published</li>' : e.restrictive_clauses.map(htmlClause).join('');
  const apiUrl = e.api.url !== 'not published' ? `, <a href="${esc(e.api.url)}">${esc(e.api.url)}</a>` : '';
  const owUrl = e.open_weights.url ? ` (<a href="${esc(e.open_weights.url)}">${esc(e.open_weights.url)}</a>)` : '';
  return `<tbody class="entry" id="${e.id}">
<tr>
<td data-label="Tool"><h3>${esc(e.name)}</h3><span class="muted">${esc(e.vendor)}</span></td>
<td data-label="You get">${esc(e.summary.you_get)}</td>
<td data-label="Price">${esc(e.summary.price)}</td>
<td data-label="Commercial use">${esc(e.summary.rights)}</td>
<td data-label="Runs locally">${esc(e.summary.local)}</td>
<td data-label="Last verified" class="ok">${esc(e.last_verified)}</td>
</tr>
<tr class="detail"><td colspan="6"><details><summary>Quotes, tiers and sources</summary><div class="panel">
<h4>Inputs</h4><ul>${inputs}</ul>
<h4>Outputs</h4><ul>${outputs}</ul>
<h4>Tiers, as published</h4><ul>${tiers}</ul>
<h4>Licence</h4><p><a href="${esc(e.licence.url)}">${esc(e.licence.name)}</a>${e.licence.dated ? '. ' + esc(e.licence.dated) : ''}</p>
<h4>Commercial rights</h4><ul>${rights}</ul>
<h4>Restrictive clauses</h4><ul>${clauses}</ul>
<h4>API</h4><p>${esc(e.api.status)}${apiUrl}. Pricing: ${esc(e.api.pricing)}</p>
<h4>Runs locally</h4><p>${e.runs_locally.value ? 'Yes' : 'No'}. VRAM: ${esc(e.runs_locally.vram)}. Hardware: ${esc(e.runs_locally.hardware)}</p>
<h4>Open weights</h4><p>${e.open_weights.value ? 'Yes' : 'No'}. Licence: ${esc(e.open_weights.licence)}${owUrl}</p>
<h4>Notes</h4><p>${esc(e.notes)}</p>
${htmlSources(e)}
</div></details></td></tr>
</tbody>`;
}

function htmlStreamed(e) {
  const terms = e.terms && e.terms.length ? `<h4>Terms</h4><ul>${e.terms.map(htmlClause).join('')}</ul>` : '';
  const notes = e.notes ? `<h4>Notes</h4><p>${esc(e.notes)}</p>` : '';
  return `<tbody class="entry" id="${e.id}">
<tr>
<td data-label="Tool"><h3>${esc(e.name)}</h3><span class="muted">${esc(e.vendor)}</span></td>
<td data-label="What it shows">${esc(e.what_it_shows)}</td>
<td data-label="Why nothing exports">${esc(e.why_no_export)}</td>
<td data-label="Price">${esc(e.price)}</td>
<td data-label="Last verified" class="ok">${esc(e.last_verified)}</td>
</tr>
<tr class="detail"><td colspan="5"><details><summary>Terms, notes and sources</summary><div class="panel">
${terms}${notes}
${htmlSources(e)}
</div></details></td></tr>
</tbody>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${NAME}</title>
<meta name="description" content="For every world model or scene generator: what you get as a file, what it costs, and what you are allowed to do with it. Every value quoted from the vendor's live page with the date.">
<style>${css}</style>
</head>
<body>
<main>
<header>
<h1>${NAME}</h1>
<p>${TAGLINE}</p>
<p>For every world model or scene generator. Every figure and clause is quoted from the vendor's own page, with the date it was read.</p>
<p class="muted">Version ${esc(data.meta.version)}. Last verified ${esc(data.meta.last_verified)}. ${data.exportable.length} exportable, ${data.streamed.length} streamed only, ${data.object_only.length} object-level names out of scope.</p>
<p class="muted">${esc(data.meta.scope)}</p>
</header>

<h2 id="exportable">Exportable</h2>
<p class="muted">The tool hands you a file you can take away.</p>
<table>
<thead><tr><th>Tool</th><th>You get</th><th>Price</th><th>Commercial use</th><th>Runs locally</th><th>Last verified</th></tr></thead>
${data.exportable.map(htmlExportable).join('\n')}
</table>

<h2 id="streamed">Streamed only</h2>
<p class="muted">The tool shows you a world and gives you no file.</p>
<table>
<thead><tr><th>Tool</th><th>What it shows</th><th>Why nothing exports</th><th>Price</th><th>Last verified</th></tr></thead>
${data.streamed.map(htmlStreamed).join('\n')}
</table>

<h2 id="object-level">Object-level, out of scope</h2>
<p class="muted">Single-object generators, a chair rather than a room. Listed so a reader knows they were considered. Not covered.</p>
<ul>
${data.object_only.map((e) => `<li>${esc(e.name)} (${esc(e.vendor)}): <a href="${esc(e.vendor_url)}">${esc(e.vendor_url)}</a></li>`).join('\n')}
</ul>

<h2 id="correct">Correct an entry</h2>
<p>Open a pull request against data/registry.json. Every change needs a source URL on the vendor's own domain and the date you read it. Quote clauses, do not paraphrase them.</p>

<footer>
<p>Data: CC BY 4.0. Code: MIT.</p>
<p>${esc(CREDIT)}</p>
</footer>
</main>
</body>
</html>
`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/index.html'), html);
console.log('Wrote README.md and dist/index.html');
