// Автопроверка страниц панели перед выкладкой (план редизайна, UI_REDESIGN_PLAN.md, правило 4).
// Ловит то, что при переделке разметки ломается молча, без ошибок в консоли до первого клика:
//   1. синтаксис встроенных <script> (компиляция через vm.Script, без выполнения);
//   2. $('id') / getElementById('id') из скрипта, для которых нет id="..." ни в разметке, ни в
//      HTML-строках, которые скрипт строит сам;
//   3. on*="fn(...)" — обработчики, которые нигде не объявлены.
// Запуск: node tools/check-ui.js [файл.html ...]  (по умолчанию fetched/index.html, admin.html, login.html)
// Код выхода 1 — есть проблемы.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'fetched');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['index.html', 'admin.html', 'login.html'].map(f => path.join(root, f));

// Имена, которые объявлены не в странице, а средой браузера.
const BUILTINS = new Set(['event', 'this', 'alert', 'confirm', 'history', 'location', 'window', 'document']);

let failed = false;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const problems = [];

  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((code, i) => {
    try { new vm.Script(code, { filename: `${path.basename(file)}#script${i + 1}` }); }
    catch (e) { problems.push(`синтаксис script#${i + 1}: ${e.message}`); }
  });
  const js = scripts.join('\n');

  const ids = new Set([...html.matchAll(/\bid=["'`]([A-Za-z_][\w-]*)["'`]/g)].map(m => m[1]));
  const refs = new Set([...js.matchAll(/(?:\$|getElementById)\(\s*['"]([A-Za-z_][\w-]*)['"]\s*\)/g)].map(m => m[1]));
  for (const id of refs) if (!ids.has(id)) problems.push(`нет элемента id="${id}" (на него ссылается скрипт)`);

  const declared = new Set([
    ...[...js.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]),
    ...[...js.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
    ...[...js.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
  ]);
  const handlers = new Set([...html.matchAll(/\bon[a-z]+=["']\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  for (const fn of handlers) if (!declared.has(fn) && !BUILTINS.has(fn)) problems.push(`обработчик ${fn}() не объявлен`);

  const name = path.relative(path.join(__dirname, '..'), file);
  if (problems.length) {
    failed = true;
    console.log(`✗ ${name}`);
    for (const p of problems) console.log('   - ' + p);
  } else {
    console.log(`✓ ${name}: скриптов ${scripts.length}, id ${ids.size}, ссылок ${refs.size}, обработчиков ${handlers.size}`);
  }
}
process.exit(failed ? 1 : 0);
