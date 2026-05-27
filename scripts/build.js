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

function readPartial(name) { return fs.readFileSync(path.join(PARTIALS, name), 'utf8'); }
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
    tarifChienPetit: brand.tarifs.chiensPetitGibier,
    tarifChienGros: brand.tarifs.chiensGrosGibier,
    garantieChienPetit: brand.tarifs.garantieChiensPetit,
    garantieChienGros: brand.tarifs.garantieChiensGros,
    franchiseChienPetit: brand.tarifs.franchiseChiensPetit,
    franchiseChienGros: brand.tarifs.franchiseChiensGros,
    fraisAdminParLigne: brand.tarifs.fraisAdminParLigne,
    nameLowerArticle: articleByName[cfg.name] || `du ${cfg.name}`,
    nameLocalSpecialist: localSpecialistByName[cfg.name] || `dans ${cfg.name}`,
    stylesCommon: fs.readFileSync(path.join(PARTIALS, 'styles-common.css'), 'utf8'),
    buildDate: new Date().toISOString().slice(0, 10),
  };
  vars.secureLink = cfg.showSecureArea
    ? ' · <a href="/secure-login.html" style="opacity:0.6">Siège</a>'
    : '';
  vars.logoSvg = applyVars(readPartial('logo.svg'), vars);
  vars.nav = applyVars(readPartial('nav.html'), vars);
  vars.footer = applyVars(readPartial('footer.html'), vars);
  vars.videoBlock = cfg.showVideo ? applyVars(readPartial('video-section.html'), vars) : '';
  vars.allianzDocsBlock = cfg.dualEntryHomepage ? applyVars(readPartial('allianz-docs.html'), vars) : '';
  vars.docGroupTitleChasseur = cfg.dualEntryHomepage ? 'Garantie obligatoire RC chasseur individuel' : 'Chasseur individuel';
  const seoHead = applyVars(readPartial('seo-head.html'), vars);
  const outDir = path.join(DIST, cfg.slug);
  fs.mkdirSync(outDir, { recursive: true });
  const SECURE_ONLY_TEMPLATES = new Set(['secure-login.html', 'espace-securise.html']);
  const ALTERNATE_TEMPLATES = new Set(['index-dual.html']);
  const DUAL_ONLY_TEMPLATES = new Set([
    'garanties.html',
    'presentation.html',
    'installations.html',
    'lecture-securite.html',
    'lecture-chiens.html',
    'lecture-installation.html',
  ]);
  const templates = fs.readdirSync(TEMPLATES).filter(f => /\.(html|xml|txt)$/.test(f));
  for (const tpl of templates) {
    if (SECURE_ONLY_TEMPLATES.has(tpl) && !cfg.showSecureArea) continue;
    if (DUAL_ONLY_TEMPLATES.has(tpl) && !cfg.dualEntryHomepage) continue;
    if (ALTERNATE_TEMPLATES.has(tpl)) continue;
    // Pour Gironde (dualEntryHomepage), on remplace le contenu d'index.html par index-dual.html
    let srcPath = path.join(TEMPLATES, tpl);
    if (tpl === 'index.html' && cfg.dualEntryHomepage) {
      srcPath = path.join(TEMPLATES, 'index-dual.html');
    }
    const src = fs.readFileSync(srcPath, 'utf8');
    let out = applyVars(src, vars);
    // Injection du bloc SEO (Schema.org + OG) dans le <head> des pages HTML publiques uniquement
    if (tpl.endsWith('.html') && out.includes('</head>') && !SECURE_ONLY_TEMPLATES.has(tpl)) {
      out = out.replace('</head>', seoHead + '\n</head>');
    }
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

// FIX : si UN SEUL dept buildé via DEPT env var, on déplace à la racine de dist/
// (comportement par défaut sur Vercel pour qu'il serve correctement le site)
if (argDept) {
  const srcDir = path.join(DIST, argDept);
  if (fs.existsSync(srcDir)) {
    const files = fs.readdirSync(srcDir);
    for (const f of files) fs.renameSync(path.join(srcDir, f), path.join(DIST, f));
    fs.rmdirSync(srcDir);
    console.log(`→ contenu de ${argDept} déplacé à la racine de dist/`);
  }
}
