'use strict';

/*
 * Checks that every text the app shows exists in all supported languages.
 * Run with `npm test`. Exits with code 1 and a list of problems if any are found.
 *
 * - Homey Compose sources (.homeycompose, drivers/*, widgets/*): every translated
 *   object ({ "en": ..., ... }) has all languages, none empty, and the same
 *   [[arg]] placeholders and !{{...}} parts as English.
 * - locales/*.json: the same keys as en.json, none empty, same __placeholders__.
 * - Keys used in code (homey.__('...') / Homey.__('...') / data-label="...") exist.
 * - .homeychangelog.json: every version in all languages.
 * - Store texts: README.txt (English) and README.<lang>.txt for the others.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LANGUAGES = ['en', 'nl', 'sv', 'de', 'da', 'no'];
const problems = [];

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, filter, out);
    } else if (filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Placeholders that must appear in every translation: Flow card [[args]], and the
// number of !{{...|...}} parts (their words are translated, so only counted).
function placeholders(text) {
  const args = (text.match(/\[\[[^\]]+\]\]/g) || []).sort().join(' ');
  const negations = (text.match(/!\{\{[^}]*\}\}/g) || []).length;
  const locale = (text.match(/__[a-zA-Z0-9_]+__/g) || []).sort().join(' ');
  return `${args}|${negations}|${locale}`;
}

function isTranslation(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.en === 'string';
}

function checkTranslation(value, where) {
  for (const lang of LANGUAGES) {
    if (typeof value[lang] !== 'string' || !value[lang].trim()) {
      problems.push(`${where}: missing "${lang}"`);
    } else if (placeholders(value[lang]) !== placeholders(value.en)) {
      problems.push(`${where}: "${lang}" has other placeholders than "en": ${JSON.stringify(value[lang])}`);
    }
  }
}

function checkManifestNode(node, where) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => checkManifestNode(item, `${where}[${item && item.id ? item.id : item && item.name ? item.name : i}]`));
  } else if (isTranslation(node)) {
    // Unit symbols (°C, kWh, h) given only in English are used for every language.
    if (where.endsWith('.units') && Object.keys(node).length === 1) return;
    checkTranslation(node, where);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) checkManifestNode(value, `${where}.${key}`);
  }
}

// 1. Homey Compose sources
const composeFiles = [
  ...walk(path.join(ROOT, '.homeycompose'), (name) => name.endsWith('.json')),
  ...walk(path.join(ROOT, 'drivers'), (name) => name.endsWith('.compose.json')),
  ...walk(path.join(ROOT, 'widgets'), (name) => name === 'widget.compose.json'),
];
for (const file of composeFiles) checkManifestNode(readJson(file), rel(file));

// 2. locales/*.json against en.json
function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, id, out);
    else out[id] = value;
  }
  return out;
}
const locales = {};
for (const lang of LANGUAGES) {
  const file = path.join(ROOT, 'locales', `${lang}.json`);
  if (!fs.existsSync(file)) {
    problems.push(`locales/${lang}.json is missing`);
    continue;
  }
  locales[lang] = flatten(readJson(file));
}
const english = locales.en || {};
for (const lang of LANGUAGES.filter((l) => l !== 'en' && locales[l])) {
  for (const [key, text] of Object.entries(english)) {
    const value = locales[lang][key];
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`locales/${lang}.json: missing "${key}"`);
    } else if (placeholders(value) !== placeholders(text)) {
      problems.push(`locales/${lang}.json: "${key}" has other placeholders than en.json`);
    }
  }
  for (const key of Object.keys(locales[lang])) {
    if (!(key in english)) problems.push(`locales/${lang}.json: "${key}" is not in en.json`);
  }
}

// 3. Keys used in code. Keys built at runtime (template strings) can't be checked.
const codeFiles = [
  path.join(ROOT, 'app.js'),
  ...walk(path.join(ROOT, 'drivers'), (name) => name.endsWith('.js') || name.endsWith('.html')),
  ...walk(path.join(ROOT, 'widgets'), (name) => name.endsWith('.js') || name.endsWith('.html')),
  ...walk(path.join(ROOT, 'lib'), (name) => name.endsWith('.js')),
];
for (const file of codeFiles) {
  const code = fs.readFileSync(file, 'utf8');
  const used = [
    ...code.matchAll(/\b__\(\s*['"]([a-zA-Z0-9_.]+)['"]/g),
    ...code.matchAll(/data-label="([a-zA-Z0-9_.]+)"/g),
  ].map((match) => match[1]);
  for (const key of new Set(used)) {
    if (!(key in english)) problems.push(`${rel(file)}: uses "${key}", which is not in locales/en.json`);
  }
}

// 4. Changelog
const changelogFile = path.join(ROOT, '.homeychangelog.json');
if (fs.existsSync(changelogFile)) {
  for (const [version, entry] of Object.entries(readJson(changelogFile))) {
    checkTranslation(entry, `.homeychangelog.json ${version}`);
  }
}

// 5. Store texts
for (const lang of LANGUAGES) {
  const file = lang === 'en' ? 'README.txt' : `README.${lang}.txt`;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full) || !fs.readFileSync(full, 'utf8').trim()) problems.push(`${file} is missing or empty`);
}

if (problems.length) {
  console.error(`${problems.length} translation problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Translations OK: ${LANGUAGES.join(', ')} (${composeFiles.length} compose files, ${Object.keys(english).length} locale keys)`);
