#!/bin/bash

echo "=========================================="
echo "  Проверка файрвола на Linux VPS"
echo "=========================================="
echo ""

# Проверка UFW
echo "1. Проверка UFW..."
if command -v ufw &> /dev/null; then
    UFW_STATUS=$(sudo ufw status 2>/dev/null | head -1)
    if echo "$UFW_STATUS" | grep -q "active"; then
        echo "   ✅ UFW активен"
        echo "   Текущие правила:"
        sudo ufw status numbered 2>/dev/null | grep -E "(465|587)" || echo "   ⚠️  Правила для портов 465/587 не найдены"
    else
        echo "   ℹ️  UFW установлен, но не активен"
    fi
else
    echo "   ℹ️  UFW не установлен"
fi
echo ""

# Проверка firewalld
echo "2. Проверка firewalld..."
if command -v firewall-cmd &> /dev/null; then
    if sudo systemctl is-active firewalld &> /dev/null; then
        echo "   ✅ firewalld активен"
        echo "   Текущие правила:"
        sudo firewall-cmd --list-rich-rules 2>/dev/null | grep -E "(465|587)" || echo "   ⚠️  Правила для портов 465/587 не найдены"
    else
        echo "   ℹ️  firewalld установлен, но не активен"
    fi
else
    echo "   ℹ️  firewalld не установлен"
fi
echo ""

# Проверка iptables
echo "3. Проверка iptables..."
if command -v iptables &> /dev/null; then
    IPTABLES_RULES=$(sudo iptables -L OUTPUT -n -v 2>/dev/null | wc -l)
    if [ "$IPTABLES_RULES" -gt 2 ]; then
        echo "   ✅ iptables активен"
        echo "   Правила для портов 465/587:"
        sudo iptables -L OUTPUT -n -v 2>/dev/null | grep -E "(465|587)" || echo "   ⚠️  Правила для портов 465/587 не найдены"
    else
        echo "   ℹ️  iptables установлен, но правил нет (по умолчанию разрешено)"
    fi
else
    echo "   ℹ️  iptables не установлен"
fi
echo ""

# Проверка доступности портов
echo "4. Проверка доступности SMTP портов Mail.ru..."
echo "   Проверка порта 465..."
if timeout 5 bash -c "</dev/tcp/smtp.mail.ru/465" 2>/dev/null; then
    echo "   ✅ Порт 465 доступен"
else
    echo "   ❌ Порт 465 недоступен (таймаут или блокировка)"
fi

echo "   Проверка порта 587..."
if timeout 5 bash -c "</dev/tcp/smtp.mail.ru/587" 2>/dev/null; then
    echo "   ✅ Порт 587 доступен"
else
    echo "   ❌ Порт 587 недоступен (таймаут или блокировка)"
fi
echo ""

# Проверка DNS
echo "5. Проверка DNS..."
if host smtp.mail.ru &> /dev/null; then
    DNS_RESULT=$(host smtp.mail.ru | grep "has address" | head -1)
    echo "   ✅ DNS работает: $DNS_RESULT"
else
    echo "   ❌ Проблема с DNS"
fi
echo ""

echo "=========================================="
echo "  Рекомендации:"
echo "=========================================="
echo ""
echo "Если порты недоступны:"
echo "1. Проверьте файрвол (команды выше покажут, какой активен)"
echo "2. Разрешите исходящие соединения на порты 465 и 587"
echo "3. Проверьте настройки безопасности в панели управления VPS"
echo "4. Свяжитесь с провайдером VPS, если проблема сохраняется"
echo ""
echo "Для разрешения портов используйте команды из файла ПРОВЕРКА_ФАЙРВОЛА.md"
echo ""
