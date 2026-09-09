const fs = require('fs');

// 1) mailer.js — вернуть комментарий про attachments к самой функции
let m = fs.readFileSync('fetched/mailer.js', 'utf8');
const strayComment = `// attachments — необязательный массив вложений в формате nodemailer ([{filename, content: Buffer}]);
// нужен «Автоматизированным отчётам», где к письму прикладывается .xlsx (см. sendSiteReport в
// server.js). Для писем по инцидентам поле просто не передаётся, и nodemailer его игнорирует.
// Отображаемое имя`;
if (!m.includes(strayComment)) { console.error('mailer: комментарий не найден'); process.exit(1); }
m = m.replace(strayComment, '// Отображаемое имя');
m = m.replace('async function sendMail({ to, subject, text, html, attachments }) {',
`// attachments — необязательный массив вложений в формате nodemailer ([{filename, content: Buffer}]);
// нужен «Автоматизированным отчётам», где к письму прикладывается .xlsx (см. sendSiteReport в
// server.js). Для писем по инцидентам поле просто не передаётся, и nodemailer его игнорирует.
async function sendMail({ to, subject, text, html, attachments }) {`);
fs.writeFileSync('fetched/mailer.js', m);
console.log('mailer.js: комментарий возвращён на место');

// 2) server.js — тема без нагромождения разделителей + HTML-версия письма рядом с текстовой
let s = fs.readFileSync('fetched/server.js', 'utf8');
const oldSend = `  await mailer.sendMail({
    to: recipients,
    subject: \`АСКУЭ · Отчёт · \${siteName} · \${periodTxt}\`,
    text: \`Объект: \${siteName}\n\`
        + \`Период: \${periodTxt}\n\`
        + \`Отчётный день: \${day} число месяца\n\`
        + \`Приборов в отчёте: \${rows.length}\n\`
        + \`Суммарный расход: \${fmtRu(totals.consumption)} кВт·ч\n\n\`
        + \`Отчёт во вложении.\nОткрыть панель: https://askue.o-dir.ru/\`,
    attachments: [{ filename: \`\${siteName} - отчёт \${periodStart} - \${periodEnd}.xlsx\`, content: Buffer.from(content) }],
  });`;
const newSend = `  // Письмо шлётся и текстом, и HTML (multipart/alternative). Так его лучше пропускают спам-фильтры
  // (07.09.2026: первое письмо с отчётом попало получателю в «Спам») — письмо только из plain text
  // с вложением и ссылкой выглядит для них хуже, чем обычное письмо с телом. HTML нарочно
  // простейший, без картинок и вёрстки таблицами: тяжёлый шаблон рассылки поднимает спам-балл.
  // Тема — без цепочки разделителей «·», обычной фразой: она читается человеком, а не только
  // фильтром, и не обрезается в списке писем на самом важном.
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    ['Объект', siteName],
    ['Период', periodTxt],
    ['Отчётный день', \`\${day} число месяца\`],
    ['Приборов в отчёте', String(rows.length)],
    ['Суммарный расход', \`\${fmtRu(totals.consumption)} кВт·ч\`],
  ];
  await mailer.sendMail({
    to: recipients,
    subject: \`Отчёт о потреблении электроэнергии, \${siteName}, \${periodTxt}\`,
    text: lines.map(([k, v]) => \`\${k}: \${v}\`).join('\n')
        + \`\n\nОтчёт во вложении.\nОткрыть панель: https://askue.o-dir.ru/\`,
    html: \`<p>Отчёт о потреблении электроэнергии — во вложении.</p>\`
        + \`<table cellpadding="0" cellspacing="0">\`
        + lines.map(([k, v]) => \`<tr><td style="padding:2px 12px 2px 0;color:#555">\${esc(k)}</td><td style="padding:2px 0"><b>\${esc(v)}</b></td></tr>\`).join('')
        + \`</table>\`
        + \`<p><a href="https://askue.o-dir.ru/">Открыть панель АСКУЭ</a></p>\`,
    attachments: [{ filename: \`\${siteName} - отчёт \${periodStart} - \${periodEnd}.xlsx\`, content: Buffer.from(content) }],
  });`;
if (!s.includes(oldSend)) { console.error('server: блок отправки не найден'); process.exit(1); }
fs.writeFileSync('fetched/server.js', s.replace(oldSend, newSend));
console.log('server.js: тема и HTML-тело обновлены');
