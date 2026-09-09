#!/bin/bash

echo "=========================================="
echo "  Добавление правил UFW для SMTP"
echo "=========================================="
echo ""

# Добавляем правила для исходящих соединений на SMTP порты
echo "Добавление правил для порта 465 (SSL)..."
sudo ufw allow out 465/tcp

echo "Добавление правил для порта 587 (STARTTLS)..."
sudo ufw allow out 587/tcp

echo ""
echo "Проверка добавленных правил:"
sudo ufw status numbered | grep -E "(465|587)"

echo ""
echo "✅ Правила добавлены!"
echo ""
echo "Теперь перезапустите ваш Node.js сервер:"
echo "  pm2 restart all"
echo "  или"
echo "  npm start"
