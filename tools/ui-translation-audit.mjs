import { readFile } from 'node:fs/promises';
import { parseAst } from 'rollup/parseAst';
import { setLocale, t } from '../src/i18n.js';
globalThis.localStorage = { setItem() {} };
globalThis.document = { documentElement: {}, querySelectorAll: () => [] };
const keys = new Set();
const html = await readFile('index.html', 'utf8');
for (const match of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) keys.add(match[1]);
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'CallExpression' && ['tr','t'].includes(node.callee?.name) && typeof node.arguments[0]?.value === 'string') keys.add(node.arguments[0].value);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
}
for (const file of ['main','promptIdea']) walk(parseAst(await readFile(`src/${file}.js`, 'utf8')));
for (const code of ['en','zh','ko']) {
  setLocale(code);
  const missing = [...keys].filter(key => t(key) === key && /[ぁ-んァ-ヶ一-龯]|^[a-z]+\./.test(key));
  console.log(JSON.stringify({ code, count: keys.size, missing }));
}
