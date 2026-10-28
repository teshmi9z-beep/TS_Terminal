// Lists the French UI texts of src/ that have no English yet in src/i18n/en.json.
//   node scripts/i18n-extract.mjs            -> prints the count and writes scripts/i18n-missing.json
//   node scripts/i18n-extract.mjs --all      -> writes every text found (not only the missing ones)
//   node scripts/i18n-extract.mjs --broad    -> also any word-like string (catches "Dernier", "Var %"...; more noise)
// Fill the English in src/i18n/en.json ("texts" for fixed texts, "patterns" for texts with {0}, {1}...).
// A null English means "leave as it is" (names, codes).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DICT = path.join(SRC, 'i18n', 'en.json');
const all = process.argv.includes('--all');
const broad = process.argv.includes('--broad');
// what looks like code rather than words: ids, keys, paths, camelCase, CSS
const CODE_LIKE = /^[a-z0-9_.:/#@$%-]+$|^[a-z]+[A-Z]\w*$|[_/\\{}<>=;]|^\w+\.\w+|^#|^--|^\.|^[\d\s.,%+-]+$|^(rgba?|hsla?|var|rotate|translate|scale|calc|url)\(|^[A-Z0-9]{2,}$/;
const wordLike = (s) => /[A-Za-zÀ-ÿ]{3}/.test(s) && !CODE_LIKE.test(s.trim());

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p);
  }
})(SRC);

// a text is UI French when it holds a French letter or a common French word
const FR_CHARS = /[àâäçéèêëîïôöùûüÿœæÀÂÇÉÈÊËÎÏÔÙÛŒ]/;
const FR_WORDS = /\b(le|la|les|un|une|des|du|de|et|ou|pour|par|sur|avec|sans|dans|au|aux|ce|cette|ces|est|sont|pas|plus|moins|tout|tous|toutes|aucun|aucune|nouveau|nouvelle|ouvrir|fermer|ajouter|supprimer|retirer|enregistrer|charger|annuler|choisir|afficher|masquer|cacher|voir|lancer|arrêter|acheter|vendre|achat|vente|jour|jours|semaine|mois|année|heure|heures|données|actions|indice|indices|marché|marchés|graphique|fenêtre|fenêtres|onglet|réglages|paramètres|alerte|alertes|ordre|ordres|prix|perte|gain|gains|risque|compte|position|positions|ouvert|ouverte|ouverts|fermé|fermée|haut|bas|gauche|droite|début|fin|depuis|jusqu|encore|déjà|rien|chargement|erreur|recherche|chercher|liste|tendance|hausse|baisse|clôture|ouverture|volume|moyenne|bougie|bougies|robot|robots|stratégie|test|tests|résultat|résultats|copier|coller|exporter|importer|télécharger|mettre|réinitialiser|appliquer|valider|modifier|renommer|dupliquer|épingler|cloner|sélection|tracé|tracés|outil|outils|couleur|épaisseur|style|texte|ligne|lignes|niveau|niveaux|zone|zones|période|périodes|unité|unités|si|quand|alors|entre|après|avant|ici|là|vos|votre|mes|mon|ma|son|sa|ses|leur|leurs|il|elle|on|nous|vous|ils|elles|aujourd|hier|demain|minute|minutes|seconde|secondes)\b/i;
function isFrench(s) {
  const t = s.trim();
  if (t.length < 2 || !/[A-Za-zÀ-ÿ]{2}/.test(t)) return false;
  if (/^(https?:|\/|\.\/|data:|#[0-9a-f]{3,8}$|rgba?\(|var\(--)/i.test(t)) return false;
  return FR_CHARS.test(t) || FR_WORDS.test(t);
}

// texts that never reach the screen: class names, keys, ids compared in code, fonts, logs
const CODE_ATTRS = /^(className|style|key|id|type|href|src|role|name|htmlFor|viewBox|d|fill|stroke|transform|points|data-.*)$/;
const CODE_CALLS = /^(console\.\w+|localStorage\.\w+|sessionStorage\.\w+|.*querySelector(All)?|.*\.closest|fetch|.*addEventListener|.*removeEventListener|RegExp|useKept)$/;
const FONT = /\d*px\b.*(sans-serif|serif|monospace)/;
function offScreen(node, sf) {
  for (let p = node.parent, child = node; p; child = p, p = p.parent) {
    if (ts.isJsxAttribute(p)) return CODE_ATTRS.test(p.name.getText(sf));
    if (ts.isLiteralTypeNode(p) || (ts.isCaseClause(p) && p.expression === child)) return true;
    if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText(sf))) return true;
    if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return true;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(child)) return CODE_CALLS.test(p.expression.getText(sf));
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isJsxElement(p) || ts.isPropertyAssignment(p) || ts.isReturnStatement(p)) return false;
  }
  return false;
}

// a text in a place that is shown on screen, French or not (single words like "Barres" hold no French marker)
const UI_ATTRS = /^(title|placeholder|aria-label|alt|label)$/;
const UI_PROPS = /^(label|title|name|desc|description|hint|help|tip|text|short|long|msg|message|caption|header|unit|note|why|what|summary|detail|details|empty|placeholder)$/;
const UI_CALLS = /^(.*showToast|alert|confirm|prompt|window\.(alert|confirm|prompt)|.*fillText|.*measureText)$/;
function onScreen(node, sf) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isJsxAttribute(p)) return UI_ATTRS.test(p.name.getText(sf));
  if (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) return UI_ATTRS.test(p.parent.name.getText(sf));
  if (ts.isJsxExpression(p)) return true;
  if (ts.isPropertyAssignment(p) && p.initializer === node) return UI_PROPS.test(p.name.getText(sf));
  if (ts.isCallExpression(p) && p.arguments.includes(node)) return UI_CALLS.test(p.expression.getText(sf));
  if (ts.isConditionalExpression(p)) return onScreen(p, sf);
  return false;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const texts = new Map(); // text -> first file:line
const patterns = new Map();
const add = (map, s, sf, node) => {
  const k = norm(s);
  if (!k || map.has(k)) return;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  map.set(k, `${path.relative(ROOT, sf.fileName).replace(/\\/g, '/')}:${line + 1}`);
};

for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) {
      // the page shows "&gt;" as ">"
      const text = node.text.replace(/&(gt|lt|amp|quot|apos|nbsp);/g, (_, e) => ({ gt: '>', lt: '<', amp: '&', quot: '"', apos: "'", nbsp: ' ' })[e])
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
      if (/[A-Za-zÀ-ÿ]{2}/.test(text)) add(texts, text, sf, node);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      // skip property keys, module names and object keys
      const isKey = p && (ts.isPropertyAssignment(p) && p.name === node);
      const shown = isFrench(node.text) || (onScreen(node, sf) && /[A-Za-zÀ-ÿ]{3}/.test(node.text)) || (broad && wordLike(node.text));
      if (!isKey && shown && !FONT.test(node.text) && !offScreen(node, sf)) add(texts, node.text, sf, node);
    } else if (ts.isTemplateExpression(node)) {
      let s = node.head.text;
      node.templateSpans.forEach((span, i) => { s += `{${i}}` + span.literal.text; });
      const lit = s.replace(/\{\d+\}/g, ' ');
      const shown = isFrench(lit) || (onScreen(node, sf) && /[A-Za-zÀ-ÿ]{3}/.test(lit)) || (broad && /[A-Za-zÀ-ÿ]{3}/.test(lit) && !/[_/\\<>=;]|\b(rgba?|var|translate|calc|url)\(|^\s*[a-z]+(-[a-z]+)+-?\s*$/.test(lit));
      if (shown && !FONT.test(s) && !offScreen(node, sf)) add(patterns, s, sf, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

let dict = { texts: {}, patterns: {} };
try { dict = JSON.parse(fs.readFileSync(DICT, 'utf8')); } catch { /* first run */ }
const outTexts = {}, outPatterns = {};
for (const [k, where] of texts) if (all || !(k in dict.texts)) outTexts[k] = where;
for (const [k, where] of patterns) if (all || !(k in dict.patterns)) outPatterns[k] = where;
const out = path.join(ROOT, 'scripts', 'i18n-missing.json');
fs.writeFileSync(out, JSON.stringify({ texts: outTexts, patterns: outPatterns }, null, 1));
console.log(`${files.length} files - texts ${texts.size} (missing ${Object.keys(outTexts).length}) - patterns ${patterns.size} (missing ${Object.keys(outPatterns).length})`);
console.log(`-> ${path.relative(ROOT, out)}`);
