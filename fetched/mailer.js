// Отправка почты (07 сент) — для раздела «Уведомления и отклонения»: инциденты/тревоги должны
// уметь долетать до почты, а не только висеть в кабинете (см. ROADMAP.md, п.2 «Проактивные
// уведомления»). Аккаунт-отправитель — общий сервисный ящик irz_dir2@mail.ru (не привязан к
// конкретному проекту/клиенту), пароль для внешних приложений лежит на VPS в
// /root/.irz_smtp_password (см. CLAUDE.md «Доступ к почте») — тем же паттерном, что
// DB_PASSWORD/WEB_PASSWORD в server.js: секрет не хардкодится в исходнике.
//
// Этот модуль — только инфраструктура (транспорт + verify + отправка одного письма). ЧТО
// именно триггерит письмо (какие виды инцидентов, с какой частотой, дайджестом или поштучно) —
// сознательно не здесь и не решено; см. обсуждение с пользователем 07.09.2026, раздел ещё
// строится по шагам (сначала — поле для email в UI, отправка подключается отдельно).
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const SMTP_USER = 'irz_dir2@mail.ru';
const SMTP_PASSWORD_FILE = '/root/.irz_smtp_password';

// Ленивая инициализация: если файла с паролем ещё нет (например, при локальном запуске не на
// VPS), модуль не должен ронять весь процесс на одном require() — транспорт создаётся только
// при первом реальном обращении (verifyTransport/sendMail), а не при загрузке файла.
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const password = fs.readFileSync(SMTP_PASSWORD_FILE, 'utf8').trim();
  // smtp.mail.ru: 465 + secure:true (SSL) — задокументированная связка для mail.ru, 587/STARTTLS
  // тоже работает, но 465 меньше капризничает с самоподписанными/строгими TLS-настройками клиентов.
  transporter = nodemailer.createTransport({
    host: 'smtp.mail.ru',
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: password },
  });
  return transporter;
}

// Проверка связи с SMTP БЕЗ реальной отправки письма (nodemailer сам не шлёт ничего лишнего —
// просто логинится и сразу закрывает соединение) — безопасно вызывать при каждом старте
// процесса, ничей почтовый ящик от этого не пострадает.
async function verifyTransport() {
  return getTransporter().verify();
}

// Отображаемое имя отправителя и Reply-To (07.09.2026) — добавлены после того, как первое же
// письмо с отчётом попало получателю в «Спам». Голый адрес без имени — заметный признак
// автоматической рассылки для фильтров, а без Reply-To на письмо нельзя просто ответить.
const SMTP_FROM = '"АСКУЭ · Дом Инженерных Решений" <' + SMTP_USER + '>';

// Message-ID задаём сами. По умолчанию nodemailer подставляет в него hostname машины, а у этого
// VPS он вида «6206753-uk992597» — не FQDN и не совпадает с доменом отправителя; часть фильтров
// считает такое несоответствие признаком подделки. Письмо действительно уходит через smtp.mail.ru
// от ящика на mail.ru, поэтому домен mail.ru здесь — корректное указание источника, а не маскировка.
function newMessageId() {
  return '<' + crypto.randomUUID() + '@mail.ru>';
}

// attachments — необязательный массив вложений в формате nodemailer ([{filename, content: Buffer}]);
// нужен «Автоматизированным отчётам», где к письму прикладывается .xlsx (см. sendSiteReport в
// server.js). Для писем по инцидентам поле просто не передаётся, и nodemailer его игнорирует.
async function sendMail({ to, subject, text, html, attachments }) {
  return getTransporter().sendMail({
    from: SMTP_FROM, replyTo: SMTP_USER, messageId: newMessageId(),
    to, subject, text, html, attachments,
  });
}

module.exports = { verifyTransport, sendMail };
