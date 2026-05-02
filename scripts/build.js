#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATES = path.join(ROOT, 'templates');
const PARTIALS = path.join(TEMPLATES, '_partials');
const CONFIG_DIR = path.join(ROOT, 'config');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

const brand = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, '_brand.json'), 'utf8'));

const articleByName = {
  Gironde: 'de Gironde',
  Calvados: 'du Calvados',
  Dordogne: 'de Dordogne',
  'Lot-et-Garonne': 'du Lot-et-Garonne'
};

const localSpecialistByName = {
  Gironde: 'en Gironde',
  Calvados: 'dans le Calvados',
  Dordogne: 'en Dordogne',
  'Lot-et-Garonne': 'en Lot-et-Garonne'
};

function readPartial(name) {
  return fs.readFileSync(path.join(PARTIALS, name), 'utf8');
}

function applyVars(content, vars) {
  return content.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    return m;
  });
}

function buildDept(deptFile) {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, deptFile), 'utf8'));
  const vars = {
    ...brand,
    ...cfg,
    tarifSecurite: brand.tarifs.securiteChasse,
    tarifChienPerDog: brand.tarifs.chiensChassePerDog,
    fraisAdminPerOption: brand.tarifs.fraisAdminPerOption,
    nameLowerArticle: articleByName[cfg.name] || `du ${cfg.name}`,
    nameLocalSpecialist: localSpecialistByName[cfg.name] || `dans ${cfg.name}`,
    stylesCommon: fs.readFileSync(path.join(PARTIALS, 'styles-common.css'), 'utf8'),
  };
  vars.logoSvg = applyVars(readPartial('logo.svg'), vars);
  vars.nav = applyVars(readPartial('nav.html'), vars);
  vars.footer = applyVars(readPartial('footer.html'), vars);
  const outDir = path.join(DIST, cfg.slug);
  fs.mkdirSync(outDir, { recursive: true });
  const templates = fs.readdirSync(TEMPLATES).filter(f => f.endsWith('.html'));
  for (const tpl of templates) {
    const src = fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8');
    const out = applyVars(src, vars);
    fs.writeFileSync(path.join(outDir, tpl), out);
  }
  if (fs.existsSync(PUBLIC_DIR)) copyRecursive(PUBLIC_DIR, outDir);
  console.log(`✓ ${cfg.slug.padEnd(15)} → dist/${cfg.slug}/  (${cfg.domain})`);
}

function copyRecursive(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyRecursive(s, d);
    } else fs.copyFileSync(s, d);
  }
}

const argDept = process.argv[2] || process.env.DEPT;
const allDepts = fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
let toBuild = allDepts;
if (argDept) {
  const match = `${argDept}.json`;
  if (!allDepts.includes(match)) {
    console.error(`✗ Département inconnu: ${argDept}`);
    process.exit(1);
  }
  toBuild = [match];
}
console.log(`Building ${toBuild.length} site(s)...`);
fs.rmSync(DIST, { recursive: true, force: true });
toBuild.forEach(buildDept);
console.log('Done.');
if (argDept && process.env.VERCEL) {
  const srcDir = path.join(DIST, argDept);
  const files = fs.readdirSync(srcDir);
  for (const f of files) fs.renameSync(path.join(srcDir, f), path.join(DIST, f));
  fs.rmdirSync(srcDir);
}
