# Инструкция по развертыванию на VPS

## Подготовка сервера

1. **Подключитесь к VPS серверу по SSH**

2. **Установите Node.js** (если не установлен):
```bash
# Для Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Проверьте установку
node --version
npm --version
```

3. **Создайте директорию для проекта**:
```bash
mkdir -p /var/www/irz-modem-control
cd /var/www/irz-modem-control
```

4. **Загрузите файлы проекта** на сервер (через git, scp или другой способ)

## Установка и запуск

1. **Установите зависимости**:
```bash
npm install
```

2. **Запустите сервер**:

**Вариант А: Через PM2 (рекомендуется для постоянной работы):**
```bash
chmod +x start-pm2.sh
./start-pm2.sh
```

**Вариант Б: Вручную через PM2:**
```bash
pm2 start server.js --name irz-modem-control
pm2 save  # Сохранить для автозапуска
```

**Вариант В: Обычный запуск (остановится при закрытии терминала):**
```bash
npm start
```

Сервер будет доступен по адресу: `http://147.45.212.205:3004`

## Запуск в фоновом режиме (PM2)

Для постоянной работы сервера рекомендуется использовать PM2:

1. **Установите PM2**:
```bash
sudo npm install -g pm2
```

2. **Запустите приложение через PM2**:
```bash
pm2 start server.js --name irz-modem-control
```

3. **Настройте автозапуск**:
```bash
pm2 startup
pm2 save
```

4. **Полезные команды PM2**:
```bash
pm2 status          # Статус приложений
pm2 logs            # Просмотр логов
pm2 restart irz-modem-control  # Перезапуск
pm2 stop irz-modem-control     # Остановка
```

## Настройка файрвола

Если используется файрвол, откройте порт 3003:

```bash
# UFW (Ubuntu)
sudo ufw allow 3004/tcp

# Firewalld (CentOS/RHEL)
sudo firewall-cmd --permanent --add-port=3004/tcp
sudo firewall-cmd --reload
```

## Настройка Nginx (опционально)

Если хотите использовать Nginx как reverse proxy:

1. **Установите Nginx**:
```bash
sudo apt-get install nginx
```

2. **Создайте конфигурацию** `/etc/nginx/sites-available/irz-modem`:
```nginx
server {
    listen 80;
    server_name 147.45.212.205;

    location / {
        proxy_pass http://localhost:3004;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

3. **Активируйте конфигурацию**:
```bash
sudo ln -s /etc/nginx/sites-available/irz-modem /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Настройка SMS-шлюза

Для работы с реальными модемами необходимо настроить отправку SMS:

1. Откройте веб-интерфейс: `http://147.45.212.205:3004`
2. Перейдите в раздел "Конфигурация"
3. Настройте параметры SMS-шлюза:
   - URL API вашего SMS-провайдера
   - API ключ
   - Или настройте GSM-модем для прямой отправки SMS

## Проверка работы

1. Откройте браузер и перейдите на `http://147.45.212.205:3004`
2. Добавьте модем с номером телефона
3. Попробуйте управлять GPIO выходами
4. Проверьте логи сервера для отладки

## Обновление

Для обновления приложения:

```bash
cd /var/www/irz-modem-control
git pull  # или загрузите новые файлы
npm install
pm2 restart irz-modem-control
```
