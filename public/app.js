// Текущий выбранный модем для управления GPIO
let currentGPIOModem = null;
let currentSettingsModem = null;
let currentMonitorModem = null;
let csqMonitoringInterval = null;
let csqData = [];
const MAX_CSQ_POINTS = 60; // 60 точек для графика (1 минута при обновлении каждую секунду)
let gpioAutoRefreshInterval = null; // Интервал для автоматического обновления GPIO

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    console.log('Страница загружена, инициализация...');
    try {
        initNavigation();
        initForms();
        loadModems();
        loadSMSConfig();
        loadTelegramConfig();
        console.log('Инициализация завершена успешно');
    } catch (error) {
        console.error('Ошибка при инициализации:', error);
        alert('Ошибка загрузки интерфейса. Откройте консоль браузера (F12) для подробностей.');
    }
});

// Навигация между страницами
function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const pages = document.querySelectorAll('.page');

    console.log('Инициализация навигации, найдено кнопок:', navButtons.length, 'страниц:', pages.length);

    navButtons.forEach((btn, index) => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            const targetPage = this.getAttribute('data-page');
            console.log('Клик по кнопке:', targetPage, 'кнопка:', this);
            
            if (!targetPage) {
                console.error('Атрибут data-page не найден');
                return;
            }

            const targetPageElement = document.getElementById(targetPage + '-page');
            console.log('Ищем страницу:', targetPage + '-page', 'найдено:', targetPageElement);
            
            if (!targetPageElement) {
                console.error('Страница не найдена:', targetPage + '-page');
                return;
            }

            // Убираем активный класс у всех кнопок и страниц
            navButtons.forEach(b => b.classList.remove('active'));
            pages.forEach(p => p.classList.remove('active'));

            // Добавляем активный класс выбранным
            this.classList.add('active');
            targetPageElement.classList.add('active');
            
            console.log('Переключено на страницу:', targetPage);

            // Загружаем данные для страницы
            try {
                if (targetPage === 'gpio' || targetPage === 'settings' || targetPage === 'monitor') {
                    updateModemSelects();
                }
            } catch (error) {
                console.error('Ошибка при загрузке данных страницы:', error);
            }
        });
    });
    
    console.log('Навигация инициализирована успешно');
}

// Инициализация форм
function initForms() {
    // Форма добавления модема
    document.getElementById('add-modem-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await addModem();
    });

    // Форма настроек режима
    document.getElementById('mode-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await setModemMode();
    });

    // Форма настроек интерфейса
    document.getElementById('interface-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await setInterface();
    });

    // Форма конфигурации SMS
    document.getElementById('sms-config-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveSMSConfig();
    });

    // Форма конфигурации Telegram
    document.getElementById('telegram-config-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveTelegramConfig();
    });

    // Выбор модема для GPIO
    document.getElementById('gpio-modem-select').addEventListener('change', (e) => {
        currentGPIOModem = e.target.value;
        document.getElementById('gpio-controls').style.display = currentGPIOModem ? 'block' : 'none';
        if (currentGPIOModem) {
            refreshGPIOStates();
        }
    });

    // Выбор модема для настроек
    document.getElementById('settings-modem-select').addEventListener('change', async (e) => {
        currentSettingsModem = e.target.value;
        document.getElementById('modem-settings').style.display = currentSettingsModem ? 'block' : 'none';
        const forceConnectBtn = document.getElementById('force-connect-btn');
        if (currentSettingsModem) {
            await loadModemSettings(currentSettingsModem);
            // Показываем кнопку проверки подключения, если режим Сервер
            const mode = document.getElementById('modem-mode').value;
            if (forceConnectBtn) {
                forceConnectBtn.style.display = mode === 'server' ? 'inline-block' : 'none';
            }
        } else {
            if (forceConnectBtn) {
                forceConnectBtn.style.display = 'none';
            }
        }
    });
    
    // Показываем/скрываем поле IP модема при изменении режима
    const modemModeSelect = document.getElementById('modem-mode');
    if (modemModeSelect) {
        modemModeSelect.addEventListener('change', (e) => {
            const mode = e.target.value;
            const modemIPGroup = document.getElementById('modem-ip-group');
            const serverIPLabel = document.querySelector('label[for="server-ip"]');
            const serverIPGroup = serverIPLabel ? serverIPLabel.parentElement : null;
            const forceConnectBtn = document.getElementById('force-connect-btn');
            
            if (modemIPGroup) {
                modemIPGroup.style.display = mode === 'server' ? 'block' : 'none';
            }
            if (serverIPGroup) {
                serverIPGroup.style.display = mode === 'server' ? 'none' : 'block';
            }
            if (forceConnectBtn) {
                forceConnectBtn.style.display = mode === 'server' && currentSettingsModem ? 'inline-block' : 'none';
            }
        });
    }

    // Выбор модема для мониторинга
    document.getElementById('monitor-modem-select').addEventListener('change', async (e) => {
        // Останавливаем мониторинг предыдущего модема
        stopCSQMonitoring();
        clearMonitorLog();
        
        currentMonitorModem = e.target.value;
        const monitorContent = document.getElementById('monitor-content');
        monitorContent.style.display = currentMonitorModem ? 'block' : 'none';
        
        if (currentMonitorModem) {
            // Сбрасываем все значения
            resetMonitorDisplay();
            // ВРЕМЕННО ОТКЛЮЧЕНО: автоматическое обновление информации конфликтует с GPIO командами
            // await refreshAllModemInfo();
            addLogEntry('⚠️ Автоматическое обновление информации отключено для предотвращения конфликтов с GPIO', 'info');
        }
    });
}

// Загрузка списка модемов
async function loadModems() {
    try {
        const response = await fetch('/api/modems');
        const data = await response.json();
        displayModems(data.modems);
        updateModemSelects(data.modems);
    } catch (error) {
        showMessage('Ошибка загрузки модемов: ' + error.message, 'error');
    }
}

// Автоматическое обновление статуса модемов каждые 5 секунд
// Это безопасно, так как только загружает список модемов, не отправляет AT-команды
setInterval(() => {
    if (document.getElementById('modems-page').classList.contains('active')) {
        loadModems();
    }
}, 5000);

// Отображение списка модемов
function displayModems(modems) {
    const list = document.getElementById('modems-list');
    
    if (!modems || modems.length === 0) {
        list.innerHTML = '<p>Модемы не добавлены</p>';
        return;
    }

    list.innerHTML = modems.map(modem => `
        <div class="modem-item">
            <div class="modem-info">
                <div class="modem-name">${modem.name}</div>
                <div class="modem-phone">${modem.phoneNumber}</div>
            </div>
            <div>
                <span class="modem-status ${modem.status === 'online' ? 'status-online' : 'status-offline'}">
                    ${modem.status === 'online' ? 'Онлайн' : 'Офлайн'}
                </span>
            </div>
        </div>
    `).join('');
}

// Обновление выпадающих списков модемов
function updateModemSelects(modems) {
    if (!modems) {
        loadModems();
        return;
    }

    const selects = ['gpio-modem-select', 'settings-modem-select', 'monitor-modem-select'];
    
    selects.forEach(selectId => {
        const select = document.getElementById(selectId);
        if (!select) {
            console.warn('Элемент не найден:', selectId);
            return;
        }
        
        const currentValue = select.value;
        
        select.innerHTML = '<option value="">Выберите модем...</option>' +
            modems.map(modem => 
                `<option value="${modem.phoneNumber}">${modem.name} (${modem.phoneNumber}) ${modem.status === 'online' ? '🟢' : '🔴'}</option>`
            ).join('');

        if (currentValue) {
            select.value = currentValue;
        }
    });
}

// Добавление модема
async function addModem() {
    const phoneNumber = document.getElementById('modem-phone').value;
    const name = document.getElementById('modem-name').value;
    const password = document.getElementById('modem-password').value;

    try {
        const response = await fetch('/api/modems', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber, name, password })
        });

        const data = await response.json();

        if (response.ok) {
            showMessage('Модем успешно добавлен', 'success');
            document.getElementById('add-modem-form').reset();
            document.getElementById('modem-password').value = '5492';
            loadModems();
        } else {
            showMessage(data.error || 'Ошибка добавления модема', 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

// Управление GPIO
async function setGPIO(gpioNumber, level) {
    if (!currentGPIOModem) {
        showMessage('Выберите модем', 'error');
        return;
    }

    try {
        const response = await fetch(`/api/modems/${currentGPIOModem}/gpio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                gpioNumber,
                action: 'set',
                level
            })
        });

        const data = await response.json();
        
        if (data.success) {
            let message = `GPIO ${gpioNumber} установлен в ${level}`;
            if (data.method === 'tcp') {
                message += `\n✅ Команда отправлена через TCP (режим: ${data.mode || 'неизвестен'})`;
                if (data.response) {
                    // Показываем ответ модема, если он есть
                    const responsePreview = data.response.length > 100 
                        ? data.response.substring(0, 100) + '...' 
                        : data.response;
                    message += `\n📥 Ответ модема: ${responsePreview}`;
                }
                if (data.command) {
                    message += `\n🔧 Команда: ${data.command}`;
                }
            } else if (data.method === 'sms') {
                if (!document.getElementById('sms-enabled') || !document.getElementById('sms-enabled').checked) {
                    message += '\n⚠️ SMS-шлюз не настроен - команда показана в консоли сервера';
                } else {
                    message += '\n📱 Команда отправлена через SMS';
                }
                if (data.note) {
                    message += `\n\n${data.note}`;
                }
            }
            showMessage(message, 'success');
            // Обновляем состояния GPIO после успешной команды
            setTimeout(() => refreshGPIOStates(), 1000);
        } else {
            let errorMessage = data.message || data.error || 'Ошибка управления GPIO';
            if (data.method === 'tcp' && data.response) {
                errorMessage += `\n📥 Ответ модема: ${data.response.substring(0, 200)}`;
            }
            if (data.note) {
                errorMessage += `\n\n${data.note}`;
            }
            showMessage(errorMessage, 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

async function impulseGPIO(gpioNumber) {
    if (!currentGPIOModem) {
        showMessage('Выберите модем', 'error');
        return;
    }

    try {
        const response = await fetch(`/api/modems/${currentGPIOModem}/gpio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                gpioNumber,
                action: 'impulse',
                impulse: 0
            })
        });

        const data = await response.json();
        
        if (data.success) {
            let message = `Импульс отправлен на GPIO ${gpioNumber}`;
            if (data.method === 'tcp') {
                message += `\n✅ Команда отправлена через TCP (режим: ${data.mode || 'неизвестен'})`;
                if (data.response) {
                    const responsePreview = data.response.length > 100 
                        ? data.response.substring(0, 100) + '...' 
                        : data.response;
                    message += `\n📥 Ответ модема: ${responsePreview}`;
                }
                if (data.command) {
                    message += `\n🔧 Команда: ${data.command}`;
                }
            } else if (data.method === 'sms') {
                if (!document.getElementById('sms-enabled') || !document.getElementById('sms-enabled').checked) {
                    message += '\n⚠️ SMS-шлюз не настроен - команда показана в консоли сервера';
                } else {
                    message += '\n📱 Команда отправлена через SMS';
                }
            }
            showMessage(message, 'success');
            // Обновляем состояния GPIO после успешной команды
            setTimeout(() => refreshGPIOStates(), 1000);
        } else {
            let errorMessage = data.message || data.error || 'Ошибка отправки импульса';
            if (data.method === 'tcp' && data.response) {
                errorMessage += `\n📥 Ответ модема: ${data.response.substring(0, 200)}`;
            }
            if (data.note) {
                errorMessage += `\n\n${data.note}`;
            }
            showMessage(errorMessage, 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

// Настройка режима работы модема
async function setModemMode() {
    if (!currentSettingsModem) {
        showMessage('Выберите модем', 'error');
        return;
    }

    const mode = document.getElementById('modem-mode').value;
    const ipAddress = document.getElementById('server-ip').value;
    const modemIP = document.getElementById('modem-ip').value;
    const port = document.getElementById('server-port').value;
    const connectionNumber = document.getElementById('connection-number').value;
    
    // Показываем/скрываем поле IP модема в зависимости от режима
    const modemIPGroup = document.getElementById('modem-ip-group');
    const serverIPLabel = document.querySelector('label[for="server-ip"]');
    const serverIPGroup = serverIPLabel ? serverIPLabel.parentElement : null;
    
    if (modemIPGroup) {
        modemIPGroup.style.display = mode === 'server' ? 'block' : 'none';
    }
    if (serverIPGroup) {
        serverIPGroup.style.display = mode === 'server' ? 'none' : 'block';
    }

    if (mode === 'client' && (!ipAddress || !port)) {
        showMessage('Для режима Клиент необходимо указать IP и порт', 'error');
        return;
    }

    if (mode === 'server' && !port) {
        showMessage('Для режима Сервер необходимо указать порт', 'error');
        return;
    }
    
    // Предупреждение, если IP модема не указан для режима Сервер
    if (mode === 'server' && !modemIP) {
        const confirmMessage = '⚠️ ВНИМАНИЕ: IP-адрес модема не указан!\n\n' +
            'Для работы в режиме "Сервер" нужно знать IP-адрес модема.\n\n' +
            'Варианты:\n' +
            '1. Укажите IP модема сейчас (можно узнать из программы ATM Control SE)\n' +
            '2. Сначала настройте модем в режиме "Клиент" - система узнает IP автоматически\n\n' +
            'Продолжить без указания IP? (Подключение не будет работать до указания IP)';
        
        if (!confirm(confirmMessage)) {
            return;
        }
    }

    try {
        const response = await fetch(`/api/modems/${currentSettingsModem}/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode,
                ipAddress: mode === 'client' ? ipAddress : null,
                modemIP: mode === 'server' ? modemIP : null,
                port: parseInt(port),
                connectionNumber: parseInt(connectionNumber)
            })
        });

        const data = await response.json();
        
        if (data.success) {
            let message = '✅ Настройки режима применены и сохранены!';
            if (data.commands && data.commands.length > 0) {
                message += `\n📱 Сформировано команд: ${data.commands.length}`;
                if (!document.getElementById('sms-enabled').checked) {
                    message += '\n\n⚠️ SMS-шлюз не настроен! Команды показаны ниже.';
                    // Показываем команды в интерфейсе
                    showCommands(data.commands);
                } else {
                    message += '\n✅ Команды отправлены на модем через SMS';
                }
            }
            
            // Добавляем предупреждение для режима Сервер
            if (mode === 'server') {
                if (data.note) {
                    message += '\n\n' + data.note;
                }
                if (!modemIP) {
                    message += '\n\n⚠️ ВАЖНО: IP-адрес модема не указан! Укажите IP в настройках для работы подключения.';
                } else {
                    message += '\n\n💡 После перезагрузки модема система автоматически попытается подключиться.';
                }
            }
            
            showMessage(message, 'success');
            
            // Перезагружаем настройки, чтобы показать сохраненные значения
            setTimeout(() => {
                loadModemSettings(currentSettingsModem);
            }, 500);
        } else {
            showMessage(data.message || 'Ошибка применения настроек', 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

// Настройка интерфейса
async function setInterface() {
    if (!currentSettingsModem) {
        showMessage('Выберите модем', 'error');
        return;
    }

    const interface = document.getElementById('interface-type').value;
    const baudRate = document.getElementById('baud-rate').value;
    const dataBits = document.getElementById('data-bits').value;
    const stopBits = document.getElementById('stop-bits').value;
    const parity = document.getElementById('parity').value;

    try {
        const response = await fetch(`/api/modems/${currentSettingsModem}/interface`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                interface,
                baudRate: parseInt(baudRate),
                dataBits: parseInt(dataBits),
                stopBits: parseFloat(stopBits),
                parity
            })
        });

        const data = await response.json();
        
        if (data.success) {
            let message = '✅ Настройки интерфейса применены и сохранены!';
            if (!document.getElementById('sms-enabled').checked && data.command) {
                message += '\n\n⚠️ SMS-шлюз не настроен! Команда показана ниже.';
                // Показываем команду в интерфейсе
                showCommands([data.command]);
            } else {
                message += '\n✅ Команда отправлена на модем через SMS';
            }
            showMessage(message, 'success');
            
            // Перезагружаем настройки
            setTimeout(() => {
                loadModemSettings(currentSettingsModem);
            }, 500);
        } else {
            showMessage(data.message || 'Ошибка применения настроек', 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

// Управление ждущим режимом
async function setWaitMode(action) {
    if (!currentSettingsModem) {
        showMessage('Выберите модем', 'error');
        return;
    }

    const connectionNumber = document.getElementById('wait-connection').value;

    try {
        const response = await fetch(`/api/modems/${currentSettingsModem}/wait`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action,
                connectionNumber: connectionNumber ? parseInt(connectionNumber) : null
            })
        });

        const data = await response.json();
        
        if (data.success) {
            let message = `Ждущий режим ${action === 'on' ? 'включен' : 'выключен'}`;
            if (!document.getElementById('sms-enabled').checked) {
                message += '\n⚠️ SMS-шлюз не настроен - команда показана в консоли сервера';
            }
            showMessage(message, 'success');
        } else {
            showMessage(data.message || 'Ошибка управления ждущим режимом', 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

// Загрузка настроек модема
async function loadModemSettings(phoneNumber) {
    try {
        const response = await fetch(`/api/modems/${phoneNumber}/settings`);
        const data = await response.json();
        const settings = data.settings || {};
        
        // Загружаем полную информацию о модеме для получения IP
        const modemResponse = await fetch(`/api/modems/${phoneNumber}/status`);
        const modemData = await modemResponse.json();
        const modem = modemData.modem || {};

        // Загружаем настройки режима работы
        if (settings.mode) {
            document.getElementById('modem-mode').value = settings.mode;
            // Обновляем видимость полей в зависимости от режима
            const mode = settings.mode;
            const modemIPGroup = document.getElementById('modem-ip-group');
            const serverIPLabel = document.querySelector('label[for="server-ip"]');
            const serverIPGroup = serverIPLabel ? serverIPLabel.parentElement : null;
            const forceConnectBtn = document.getElementById('force-connect-btn');
            
            if (modemIPGroup) {
                modemIPGroup.style.display = mode === 'server' ? 'block' : 'none';
            }
            if (serverIPGroup) {
                serverIPGroup.style.display = mode === 'server' ? 'none' : 'block';
            }
            if (forceConnectBtn) {
                forceConnectBtn.style.display = mode === 'server' ? 'inline-block' : 'none';
            }
        }
        if (settings.ipAddress) {
            document.getElementById('server-ip').value = settings.ipAddress;
        }
        // Загружаем IP модема из настроек или из последнего известного IP
        if (settings.modemIP) {
            document.getElementById('modem-ip').value = settings.modemIP;
        } else if (modem.lastKnownIP) {
            document.getElementById('modem-ip').value = modem.lastKnownIP;
        }
        if (settings.port) {
            document.getElementById('server-port').value = settings.port;
        }
        if (settings.connectionNumber) {
            document.getElementById('connection-number').value = settings.connectionNumber;
        }

        // Загружаем настройки интерфейса
        if (settings.interface) {
            document.getElementById('interface-type').value = settings.interface.type || 'RS485';
            document.getElementById('baud-rate').value = settings.interface.baudRate || '9600';
            document.getElementById('data-bits').value = settings.interface.dataBits || '8';
            document.getElementById('stop-bits').value = settings.interface.stopBits || '1';
            document.getElementById('parity').value = settings.interface.parity || 'none';
        }
    } catch (error) {
        console.error('Ошибка загрузки настроек модема:', error);
    }
}

// Загрузка конфигурации SMS
async function loadSMSConfig() {
    try {
        const response = await fetch('/api/config/sms');
        const data = await response.json();
        const config = data.config;

        document.getElementById('sms-enabled').checked = config.enabled || false;
        document.getElementById('sms-api-url').value = config.apiUrl || '';
        document.getElementById('sms-api-key').value = config.apiKey || '';
        document.getElementById('use-gsm-modem').checked = config.useGSMModem || false;
        document.getElementById('gsm-modem-port').value = config.gsmModemPort || '';
    } catch (error) {
        console.error('Ошибка загрузки конфигурации SMS:', error);
    }
}

// Сохранение конфигурации SMS
async function saveSMSConfig() {
    const config = {
        enabled: document.getElementById('sms-enabled').checked,
        apiUrl: document.getElementById('sms-api-url').value,
        apiKey: document.getElementById('sms-api-key').value,
        useGSMModem: document.getElementById('use-gsm-modem').checked,
        gsmModemPort: document.getElementById('gsm-modem-port').value
    };

    try {
        const response = await fetch('/api/config/sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        const data = await response.json();
        
        if (data.success) {
            showMessage('Конфигурация SMS сохранена', 'success');
        } else {
            showMessage('Ошибка сохранения конфигурации', 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

// Загрузка конфигурации Telegram
async function loadTelegramConfig() {
    try {
        const response = await fetch('/api/config/telegram');
        const data = await response.json();
        const config = data.config;

        document.getElementById('telegram-enabled').checked = config.enabled || false;
        document.getElementById('telegram-bot-token').value = config.botToken || '';
        document.getElementById('telegram-chat-ids').value = Array.isArray(config.chatIds) ? config.chatIds.join(', ') : '';

        // Настройки уведомлений
        const notifications = config.notifications || {};
        document.getElementById('notify-modem-connected').checked = notifications.modemConnected !== false;
        document.getElementById('notify-modem-disconnected').checked = notifications.modemDisconnected !== false;
        document.getElementById('notify-modem-offline').checked = notifications.modemOffline || false;
        document.getElementById('modem-offline-minutes').value = notifications.modemOfflineMinutes || 30;
        document.getElementById('notify-command-error').checked = notifications.commandError !== false;
        document.getElementById('notify-low-signal').checked = notifications.lowSignal !== false;
        document.getElementById('low-signal-threshold').value = notifications.lowSignalThreshold || 10;
        document.getElementById('notify-gpio-changed').checked = notifications.gpioChanged || false;
        document.getElementById('notify-gpio-command').checked = notifications.gpioCommand || false;
        document.getElementById('notify-settings-changed').checked = notifications.settingsChanged || false;
    } catch (error) {
        console.error('Ошибка загрузки конфигурации Telegram:', error);
    }
}

// Сохранение конфигурации Telegram
async function saveTelegramConfig() {
    const chatIdsInput = document.getElementById('telegram-chat-ids').value;
    const chatIds = chatIdsInput
        .split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0)
        .map(id => {
            // Преобразуем в число, если возможно
            const numId = parseInt(id);
            return isNaN(numId) ? id : numId;
        });

    console.log('💾 Сохранение конфигурации Telegram:', {
        enabled: document.getElementById('telegram-enabled').checked,
        botToken: document.getElementById('telegram-bot-token').value ? 'установлен' : 'не установлен',
        chatIds: chatIds
    });

    const config = {
        enabled: document.getElementById('telegram-enabled').checked,
        botToken: document.getElementById('telegram-bot-token').value.trim(),
        chatIds: chatIds,
        notifications: {
            modemConnected: document.getElementById('notify-modem-connected').checked,
            modemDisconnected: document.getElementById('notify-modem-disconnected').checked,
            modemOffline: document.getElementById('notify-modem-offline').checked,
            modemOfflineMinutes: parseInt(document.getElementById('modem-offline-minutes').value) || 30,
            commandError: document.getElementById('notify-command-error').checked,
            lowSignal: document.getElementById('notify-low-signal').checked,
            lowSignalThreshold: parseInt(document.getElementById('low-signal-threshold').value) || 10,
            gpioChanged: document.getElementById('notify-gpio-changed').checked,
            gpioCommand: document.getElementById('notify-gpio-command').checked,
            settingsChanged: document.getElementById('notify-settings-changed').checked
        }
    };

    try {
        const response = await fetch('/api/config/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        const data = await response.json();
        
        if (data.success) {
            showMessage('Конфигурация Telegram сохранена', 'success');
        } else {
            showMessage('Ошибка сохранения конфигурации Telegram', 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    }
}

// Тестовая отправка Telegram
async function testTelegramNotification(event) {
    const btn = event?.target || document.querySelector('button[onclick*="testTelegramNotification"]');
    const originalText = btn ? btn.textContent : '📱 Отправить тестовое сообщение';
    
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Отправка...';
    }

    // Создаем контроллер для отмены запроса при таймауте
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 секунд таймаут

    try {
        const response = await fetch('/api/config/telegram/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            // Пытаемся получить текст ошибки
            let errorText = `HTTP ${response.status}`;
            try {
                const errorData = await response.json();
                errorText = errorData.error || errorData.message || errorText;
            } catch (e) {
                const text = await response.text();
                if (text) errorText = text.substring(0, 200);
            }
            throw new Error(errorText);
        }

        const data = await response.json();
        
        if (data.success) {
            showMessage(`✅ Тестовое сообщение отправлено! Проверьте Telegram (отправлено в ${data.sent} из ${data.total} чатов).`, 'success');
        } else {
            let errorMsg = data.error || data.message || 'Неизвестная ошибка';
            showMessage('❌ Ошибка отправки тестового сообщения: ' + errorMsg, 'error');
        }
    } catch (error) {
        clearTimeout(timeoutId);
        
        let errorMsg = 'Неизвестная ошибка';
        if (error.name === 'AbortError') {
            errorMsg = 'Таймаут запроса (15 секунд). Проверьте настройки Telegram и доступность сервера.';
        } else if (error.message) {
            errorMsg = error.message;
        } else {
            errorMsg = error.toString();
        }
        
        console.error('Ошибка отправки тестового сообщения:', error);
        showMessage('❌ Ошибка: ' + errorMsg, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

// Показ команд в интерфейсе
function showCommands(commands) {
    const commandsDiv = document.getElementById('last-commands');
    const commandsList = document.getElementById('commands-list');
    
    if (commands && commands.length > 0) {
        commandsList.innerHTML = commands.map((cmd, i) => 
            `<div style="margin-bottom: 8px;">
                <strong>${i + 1}.</strong> <code style="background: #e9ecef; padding: 4px 8px; border-radius: 3px;">${cmd}</code>
                <button onclick="copyCommand('${cmd.replace(/'/g, "\\'")}')" style="margin-left: 10px; padding: 2px 8px; font-size: 0.85em; cursor: pointer;">📋 Копировать</button>
            </div>`
        ).join('');
        commandsDiv.style.display = 'block';
        
        // Прокручиваем к командам
        commandsDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// Копирование команды в буфер обмена
function copyCommand(command) {
    navigator.clipboard.writeText(command).then(() => {
        showMessage('Команда скопирована в буфер обмена!', 'success');
    }).catch(err => {
        // Fallback для старых браузеров
        const textarea = document.createElement('textarea');
        textarea.value = command;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showMessage('Команда скопирована!', 'success');
    });
}

// Показ сообщений
function showMessage(text, type = 'info') {
    const messageEl = document.getElementById('message');
    messageEl.textContent = text;
    messageEl.className = `message ${type} show`;

    setTimeout(() => {
        messageEl.classList.remove('show');
    }, 5000); // Увеличил время показа до 5 секунд
}

// ========== ФУНКЦИИ МОНИТОРИНГА МОДЕМА ==========


// Проверка статуса подключения модема
async function checkModemConnection() {
    if (!currentMonitorModem) return false;
    
    try {
        const response = await fetch(`/api/modems/${currentMonitorModem}/connection-status`);
        
        if (!response.ok) {
            if (response.status === 404) {
                // API endpoint не найден - используем альтернативный способ проверки
                addLogEntry('⚠️ API проверки подключения недоступен, проверяю через список модемов...', 'info');
                return await checkConnectionViaModemsList();
            }
            const errorText = await response.text();
            addLogEntry(`Ошибка HTTP ${response.status}: ${errorText.substring(0, 100)}`, 'error');
            return await checkConnectionViaModemsList();
        }
        
        const data = await response.json();
        
        if (!data.isConnected) {
            const totalConn = data.totalConnections !== undefined ? data.totalConnections : 'неизвестно';
            
            // Проверяем режим модема для более точного сообщения
            const modemResponse = await fetch(`/api/modems/${currentMonitorModem}/settings`);
            const modemSettings = await modemResponse.json();
            const modemMode = modemSettings.settings?.mode;
            
            if (modemMode === 'server') {
                addLogEntry(`⚠️ Модем не подключен (режим Сервер). Проверьте:`, 'error');
                addLogEntry(`   1. Указан ли IP-адрес модема в настройках?`, 'info');
                addLogEntry(`   2. Модем перезагрузился после настройки?`, 'info');
                addLogEntry(`   3. Модем запустил сервер на указанном порту?`, 'info');
                addLogEntry(`   4. Нет ли файрвола, блокирующего подключение?`, 'info');
            } else {
                addLogEntry(`⚠️ Модем не подключен к серверу. Активных соединений: ${totalConn}`, 'error');
                if (data.allConnections && data.allConnections.length > 0) {
                    addLogEntry(`Активные соединения: ${data.allConnections.map(c => c.modemPhone || 'неизвестен').join(', ')}`, 'info');
                }
            }
            
            // Проверяем через список модемов как резервный вариант
            return await checkConnectionViaModemsList();
        }
        
        addLogEntry(`✅ Модем подключен (${data.connectionInfo?.address || 'адрес неизвестен'})`, 'success');
        return true;
    } catch (error) {
        addLogEntry('Ошибка проверки подключения: ' + error.message, 'error');
        // Пробуем альтернативный способ
        return await checkConnectionViaModemsList();
    }
}

// Альтернативная проверка через список модемов
async function checkConnectionViaModemsList() {
    try {
        const response = await fetch('/api/modems');
        const data = await response.json();
        
        if (data.modems) {
            const modem = data.modems.find(m => m.phoneNumber === currentMonitorModem);
            if (modem && modem.status === 'online') {
                addLogEntry(`✅ Модем подключен (статус: ${modem.status})`, 'success');
                return true;
            } else if (modem) {
                addLogEntry(`⚠️ Модем в статусе: ${modem.status}`, 'error');
                return false;
            }
        }
        
        addLogEntry('⚠️ Модем не найден в списке', 'error');
        return false;
    } catch (error) {
        addLogEntry('Ошибка проверки через список модемов: ' + error.message, 'error');
        return false;
    }
}

// Обновление всей информации о модеме
// ВРЕМЕННО ОТКЛЮЧЕНО: эта функция конфликтует с GPIO командами
async function refreshAllModemInfo() {
    if (!currentMonitorModem) return;
    
    // ВРЕМЕННО ОТКЛЮЧЕНО - чтобы не конфликтовать с GPIO командами
    addLogEntry('⚠️ Автоматическое обновление информации отключено', 'info');
    return;
    
    /* ЗАКОММЕНТИРОВАНО
    addLogEntry('Проверка подключения модема...', 'info');
    
    // Сначала проверяем подключение
    const isConnected = await checkModemConnection();
    if (!isConnected) {
        // Проверяем режим модема для более точного сообщения
        try {
            const settingsResponse = await fetch(`/api/modems/${currentMonitorModem}/settings`);
            const settingsData = await settingsResponse.json();
            const modemMode = settingsData.settings?.mode;
            
            if (modemMode === 'server') {
                showMessage('Модем не подключен (режим Сервер). Проверьте IP-адрес модема в настройках и убедитесь, что модем запустил сервер.', 'error');
            } else {
                showMessage('Модем не подключен к серверу. Убедитесь, что модем в режиме "Клиент" и подключен.', 'error');
            }
        } catch (error) {
            showMessage('Модем не подключен к серверу. Проверьте настройки подключения.', 'error');
        }
        return;
    }
    
    addLogEntry('Запрос информации о модеме...', 'info');
    
    // Запрашиваем информацию об устройстве
    await refreshModemInfo();
    
    // Запрашиваем уровень сигнала
    await refreshCSQ();
    
    // Запрашиваем время
    await refreshModemTime();
    */
}

// Очередь команд для последовательного выполнения
let commandQueue = [];
let isProcessingQueue = false;

// Добавление команды в очередь
async function queueCommand(phoneNumber, command, description) {
    return new Promise((resolve, reject) => {
        commandQueue.push({
            phoneNumber,
            command,
            description,
            resolve,
            reject
        });
        
        processCommandQueue();
    });
}

// Обработка очереди команд
async function processCommandQueue() {
    if (isProcessingQueue || commandQueue.length === 0) {
        return;
    }
    
    isProcessingQueue = true;
    
    while (commandQueue.length > 0) {
        const item = commandQueue.shift();
        
        try {
            addLogEntry(`Выполнение: ${item.description}...`, 'info');
            const result = await sendATCommand(item.phoneNumber, item.command);
            
            // Ждем между командами, чтобы модем успел обработать
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 секунды между командами
            
            item.resolve(result);
        } catch (error) {
            item.reject(error);
        }
    }
    
    isProcessingQueue = false;
}

// Получение данных через SMS (альтернативный способ)
async function getDataViaSMS() {
    if (!currentMonitorModem) return;
    
    addLogEntry('⚠️ AT-команды через TCP не работают без протокола iRZ Collector', 'error');
    addLogEntry('💡 Попробуйте получить данные через SMS-команды', 'info');
    addLogEntry('📱 Отправьте на номер модема SMS с командами:', 'info');
    addLogEntry('   1. 5492 0AT$ATM_IMEI?', 'info');
    addLogEntry('   2. 5492 0AT$ATM_NAME?', 'info');
    addLogEntry('   3. 5492 0AT$ATM_SOFT?', 'info');
    addLogEntry('   4. 5492 0AT$ATM_HARD?', 'info');
    addLogEntry('   5. 5492 0AT$ATM_CSQ?', 'info');
    addLogEntry('   Модем ответит SMS с результатами', 'info');
    
    showMessage('Для работы AT-команд через TCP нужен протокол iRZ Collector с инкапсуляцией. Команды для SMS показаны в логе.', 'error');
}

// Получение извлеченных данных из автоматических сообщений
async function refreshParsedData() {
    if (!currentMonitorModem) return;
    
    try {
        const response = await fetch(`/api/modems/${currentMonitorModem}/parsed-data`);
        const data = await response.json();
        
        if (data.success && data.data) {
            if (data.data.imei) {
                document.getElementById('monitor-imei').textContent = data.data.imei;
                addLogEntry(`✅ IMEI из автоматических данных: ${data.data.imei}`, 'success');
            }
            if (data.data.deviceName) {
                document.getElementById('monitor-device').textContent = data.data.deviceName;
                addLogEntry(`✅ Название из автоматических данных: ${data.data.deviceName}`, 'success');
            }
            if (data.data.software) {
                document.getElementById('monitor-software').textContent = data.data.software;
                addLogEntry(`✅ Версия ПО из автоматических данных: ${data.data.software}`, 'success');
            }
            if (data.data.hardware) {
                document.getElementById('monitor-hardware').textContent = data.data.hardware;
                addLogEntry(`✅ Версия железа из автоматических данных: ${data.data.hardware}`, 'success');
            }
            if (data.data.operator) {
                document.getElementById('monitor-operator').textContent = data.data.operator;
                addLogEntry(`✅ Оператор из автоматических данных: ${data.data.operator}`, 'success');
            }
            if (data.data.csq !== undefined) {
                const percent = Math.round((data.data.csq / 31) * 100);
                document.getElementById('monitor-csq').textContent = data.data.csq;
                document.getElementById('monitor-csq-percent').textContent = `${percent}%`;
                addCSQPoint(data.data.csq);
                addLogEntry(`✅ CSQ из автоматических данных: ${data.data.csq} (${percent}%)`, 'success');
            }
        } else {
            addLogEntry('Данные из автоматических сообщений пока не получены', 'info');
        }
    } catch (error) {
        addLogEntry('Ошибка получения извлеченных данных: ' + error.message, 'error');
    }
}

// Обновление информации об устройстве
async function refreshModemInfo() {
    if (!currentMonitorModem) return;
    
    addLogEntry('Запрос информации о модеме...', 'info');
    
    // Сначала пробуем получить извлеченные данные
    await refreshParsedData();
    
    try {
        // Используем очередь для последовательного выполнения команд
        // IMEI
        const imeiResult = await queueCommand(currentMonitorModem, 'AT$ATM_IMEI?', 'Получение IMEI');
        
        if (imeiResult.success && imeiResult.response) {
            const imei = extractValue(imeiResult.response, 'ATM_IMEI');
            document.getElementById('monitor-imei').textContent = imei || '—';
            addLogEntry(`✅ IMEI получен: ${imei}`, 'success');
        } else if (imeiResult.error) {
            addLogEntry('Ошибка получения IMEI: ' + imeiResult.error, 'error');
        }
        
        // Название устройства
        const nameResult = await queueCommand(currentMonitorModem, 'AT$ATM_NAME?', 'Получение названия');
        
        if (nameResult.success && nameResult.response) {
            const name = extractValue(nameResult.response, 'ATM_NAME');
            document.getElementById('monitor-device').textContent = name || '—';
            addLogEntry(`✅ Название получено: ${name}`, 'success');
        } else if (nameResult.error) {
            addLogEntry('Ошибка получения названия: ' + nameResult.error, 'error');
        }
        
        // Версия железа
        const hardResult = await queueCommand(currentMonitorModem, 'AT$ATM_HARD?', 'Получение версии железа');
        
        if (hardResult.success && hardResult.response) {
            const hardware = extractValue(hardResult.response, 'ATM_HARD');
            document.getElementById('monitor-hardware').textContent = hardware || '—';
            addLogEntry(`✅ Версия железа получена: ${hardware}`, 'success');
        } else if (hardResult.error) {
            addLogEntry('Ошибка получения версии железа: ' + hardResult.error, 'error');
        }
        
        // Версия ПО
        const softResult = await queueCommand(currentMonitorModem, 'AT$ATM_SOFT?', 'Получение версии ПО');
        
        if (softResult.success && softResult.response) {
            const software = extractValue(softResult.response, 'ATM_SOFT');
            document.getElementById('monitor-software').textContent = software || '—';
            addLogEntry(`✅ Версия ПО получена: ${software}`, 'success');
        } else if (softResult.error) {
            addLogEntry('Ошибка получения версии ПО: ' + softResult.error, 'error');
        }
        
        // Информация об операторе
        await refreshOperator();
        
        addLogEntry('Информация об устройстве обновлена', 'success');
    } catch (error) {
        const errorMsg = error.message || 'Неизвестная ошибка';
        addLogEntry('Ошибка получения информации: ' + errorMsg, 'error');
        showMessage('Ошибка получения информации о модеме: ' + errorMsg, 'error');
    }
}

// Обновление информации об операторе
async function refreshOperator() {
    if (!currentMonitorModem) return;
    
    try {
        const result = await queueCommand(currentMonitorModem, 'AT+COPS?', 'Получение информации об операторе');
        if (result.success && result.response) {
            // Формат ответа: +COPS: <mode>[,<format>,<oper>[,<AcT>]]
            const match = result.response.match(/\+COPS:\s*(\d+),(\d+),"([^"]+)"/);
            if (match) {
                const operatorName = match[3];
                document.getElementById('monitor-operator').textContent = operatorName || '—';
            } else {
                document.getElementById('monitor-operator').textContent = '—';
            }
        }
    } catch (error) {
        // Игнорируем ошибки получения оператора
        console.error('Ошибка получения оператора:', error);
    }
}

// Обновление уровня сигнала CSQ
async function refreshCSQ() {
    if (!currentMonitorModem) return;
    
    // Проверяем, не выполняется ли уже запрос
    if (csqRequestInProgress) {
        return;
    }
    
    csqRequestInProgress = true;
    
    try {
        // Используем очередь для CSQ тоже
        const result = await queueCommand(currentMonitorModem, 'AT$ATM_CSQ?', 'Получение уровня сигнала');
        
        if (!result.success) {
            // Если ошибка подключения, не логируем каждую секунду
            if (result.error && result.error.includes('не подключен')) {
                // Логируем только один раз
                if (!document.getElementById('monitor-csq').hasAttribute('data-error-logged')) {
                    addLogEntry('Модем не подключен к серверу. Убедитесь, что модем в режиме "Клиент" и подключен.', 'error');
                    document.getElementById('monitor-csq').setAttribute('data-error-logged', 'true');
                }
                document.getElementById('monitor-csq').textContent = 'Не подключен';
                document.getElementById('monitor-csq-percent').textContent = '—';
                return;
            }
            
            // Обработка ошибки 429 (слишком много запросов)
            if (result.error && (result.error.includes('429') || result.error.includes('уже выполняется'))) {
                // Не логируем эту ошибку, просто пропускаем
                console.log('Запрос пропущен - предыдущий еще выполняется');
                return;
            }
            
            // Для других ошибок логируем, но не слишком часто
            const now = Date.now();
            const lastErrorTime = parseInt(document.getElementById('monitor-csq').getAttribute('data-last-error') || '0');
            if (now - lastErrorTime > 10000) { // Логируем не чаще раза в 10 секунд
                addLogEntry('Ошибка получения CSQ: ' + result.error, 'error');
                document.getElementById('monitor-csq').setAttribute('data-last-error', now.toString());
            }
            return;
        }
        
        // Сбрасываем флаг ошибки, если команда успешна
        document.getElementById('monitor-csq').removeAttribute('data-error-logged');
        document.getElementById('monitor-csq').removeAttribute('data-last-error');
        
        if (result.response) {
            const csq = extractValue(result.response, 'ATM_CSQ');
            const csqNum = parseInt(csq);
            
            if (!isNaN(csqNum) && csqNum >= 0 && csqNum <= 31) {
                const percent = Math.round((csqNum / 31) * 100);
                document.getElementById('monitor-csq').textContent = csqNum;
                document.getElementById('monitor-csq-percent').textContent = `${percent}%`;
                
                // Добавляем точку в график
                addCSQPoint(csqNum);
            } else {
                // Обработка ошибок
                let errorMsg = 'Ошибка';
                if (csqNum === 99) errorMsg = 'Нет сигнала';
                else if (csqNum === 51) errorMsg = 'Нет питания GSM';
                else if (csqNum === 52) errorMsg = 'Нет внешнего питания';
                else if (csqNum === 53 || csqNum === 54) errorMsg = 'Нет SIM-карты';
                else if (csqNum === 55 || csqNum === 56) errorMsg = 'SIM-карта не готова';
                
                document.getElementById('monitor-csq').textContent = errorMsg;
                document.getElementById('monitor-csq-percent').textContent = '—';
            }
        }
    } catch (error) {
        const errorMsg = error.message || 'Неизвестная ошибка';
        const now = Date.now();
        const lastErrorTime = parseInt(document.getElementById('monitor-csq').getAttribute('data-last-error') || '0');
        if (now - lastErrorTime > 10000) {
            addLogEntry('Ошибка получения CSQ: ' + errorMsg, 'error');
            document.getElementById('monitor-csq').setAttribute('data-last-error', now.toString());
        }
    } finally {
        csqRequestInProgress = false;
    }
}

// Обновление времени модема
async function refreshModemTime() {
    if (!currentMonitorModem) return;
    
    try {
        // Используем очередь для времени
        const result = await queueCommand(currentMonitorModem, 'AT+CCLK?', 'Получение времени модема');
        if (result.success && result.response) {
            // Формат ответа: +CCLK: "YY/MM/DD,HH:MM:SS+ZZ"
            const match = result.response.match(/\+CCLK:\s*"(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})/);
            if (match) {
                const [, yy, mm, dd, hh, min, ss] = match;
                const year = '20' + yy;
                document.getElementById('monitor-date').textContent = `${dd}.${mm}.${year}`;
                document.getElementById('monitor-time').textContent = `${hh}:${min}:${ss}`;
            }
        }
    } catch (error) {
        addLogEntry('Ошибка получения времени: ' + error.message, 'error');
    }
}

// Извлечение значения из ответа модема
function extractValue(response, prefix) {
    const regex = new RegExp(`\\^${prefix}:(.+)`);
    const match = response.match(regex);
    return match ? match[1].trim() : null;
}

// Добавление точки в график CSQ
function addCSQPoint(value) {
    csqData.push({ time: new Date(), value });
    
    // Ограничиваем количество точек
    if (csqData.length > MAX_CSQ_POINTS) {
        csqData.shift();
    }
    
    drawCSQChart();
}

// Отрисовка графика CSQ
function drawCSQChart() {
    const canvas = document.getElementById('csq-chart');
    if (!canvas || csqData.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const padding = 20;
    
    // Очищаем canvas
    ctx.clearRect(0, 0, width, height);
    
    // Фон
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, width, height);
    
    // Сетка
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
        const y = padding + (height - 2 * padding) * (i / 5);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }
    
    // Оси
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, height - padding);
    ctx.lineTo(width - padding, height - padding);
    ctx.stroke();
    
    // Подписи осей
    ctx.fillStyle = '#666';
    ctx.font = '10px Arial';
    ctx.fillText('CSQ', 5, padding + 10);
    ctx.fillText('0', padding - 15, height - padding);
    ctx.fillText('31', padding - 20, padding + 5);
    
    // Данные
    if (csqData.length > 1) {
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        const stepX = (width - 2 * padding) / (csqData.length - 1);
        const maxValue = 31;
        
        csqData.forEach((point, index) => {
            const x = padding + index * stepX;
            const y = height - padding - (point.value / maxValue) * (height - 2 * padding);
            
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        
        ctx.stroke();
        
        // Заливка под графиком
        ctx.fillStyle = 'rgba(102, 126, 234, 0.2)';
        ctx.lineTo(width - padding, height - padding);
        ctx.lineTo(padding, height - padding);
        ctx.closePath();
        ctx.fill();
    }
}

// Флаг для отслеживания выполнения запроса
let csqRequestInProgress = false;

// Запуск мониторинга CSQ
// ВРЕМЕННО ОТКЛЮЧЕНО: мониторинг конфликтует с GPIO командами
function startCSQMonitoring() {
    // ВРЕМЕННО ОТКЛЮЧЕНО - чтобы не конфликтовать с GPIO командами
    addLogEntry('⚠️ Мониторинг CSQ временно отключен для предотвращения конфликтов с GPIO командами', 'info');
    return;
    
    /* ЗАКОММЕНТИРОВАНО
    if (csqMonitoringInterval) {
        stopCSQMonitoring();
    }
    
    csqData = [];
    csqRequestInProgress = false;
    document.getElementById('start-csq-btn').style.display = 'none';
    document.getElementById('stop-csq-btn').style.display = 'inline-block';
    
    // Первый запрос сразу
    refreshCSQ();
    
    // Затем каждые 3 секунды (чтобы не перегружать модем)
    csqMonitoringInterval = setInterval(() => {
        if (!csqRequestInProgress) {
            refreshCSQ();
        } else {
            // Пропускаем этот запрос, если предыдущий еще выполняется
            console.log('Пропуск запроса CSQ - предыдущий еще выполняется');
        }
    }, 3000); // Увеличил интервал до 3 секунд
    
    addLogEntry('Мониторинг уровня сигнала запущен (обновление каждые 3 секунды)', 'success');
    */
}

// Остановка мониторинга CSQ
function stopCSQMonitoring() {
    if (csqMonitoringInterval) {
        clearInterval(csqMonitoringInterval);
        csqMonitoringInterval = null;
    }
    
    csqRequestInProgress = false;
    document.getElementById('start-csq-btn').style.display = 'inline-block';
    document.getElementById('stop-csq-btn').style.display = 'none';
    
    addLogEntry('Мониторинг уровня сигнала остановлен', 'info');
}

// Добавление записи в лог
function addLogEntry(message, type = 'info') {
    const logDiv = document.getElementById('monitor-log');
    if (!logDiv) return;
    
    // Удаляем сообщение о пустом логе
    if (logDiv.querySelector('p[style*="italic"]')) {
        logDiv.innerHTML = '';
    }
    
    const time = new Date().toLocaleTimeString('ru-RU');
    const entry = document.createElement('div');
    entry.className = 'monitor-log-entry';
    entry.innerHTML = `<span class="monitor-log-time">${time}</span><span class="monitor-log-${type}">${message}</span>`;
    
    logDiv.appendChild(entry);
    logDiv.scrollTop = logDiv.scrollHeight;
}

// Очистка лога
function clearMonitorLog() {
    const logDiv = document.getElementById('monitor-log');
    if (logDiv) {
        logDiv.innerHTML = '<p style="color: #999; font-style: italic;">Лог событий будет отображаться здесь...</p>';
    }
}

// Сброс отображения мониторинга
function resetMonitorDisplay() {
    document.getElementById('monitor-device').textContent = '—';
    document.getElementById('monitor-imei').textContent = '—';
    document.getElementById('monitor-hardware').textContent = '—';
    document.getElementById('monitor-software').textContent = '—';
    document.getElementById('monitor-operator').textContent = '—';
    document.getElementById('monitor-csq').textContent = '—';
    document.getElementById('monitor-csq-percent').textContent = '—';
    document.getElementById('monitor-time').textContent = '—';
    document.getElementById('monitor-date').textContent = '—';
    csqData = [];
    drawCSQChart();
}

// Улучшенная обработка ошибок при отправке команд
async function sendATCommand(phoneNumber, command) {
    try {
        const response = await fetch(`/api/modems/${phoneNumber}/at-command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        });
        
        // Проверяем Content-Type перед парсингом
        const contentType = response.headers.get('content-type');
        const isJSON = contentType && contentType.includes('application/json');
        
        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            
            if (isJSON) {
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch (e) {
                    // Если не удалось распарсить JSON, используем текст
                    const text = await response.text();
                    errorMessage = text.substring(0, 200) || errorMessage;
                }
            } else {
                // Если это HTML или другой формат, читаем как текст
                const text = await response.text();
                // Пытаемся извлечь полезную информацию из HTML
                if (text.includes('Модем не подключен')) {
                    errorMessage = 'Модем не подключен к серверу';
                } else if (text.includes('не найден')) {
                    errorMessage = 'Модем не найден';
                } else {
                    errorMessage = `Ошибка сервера (${response.status})`;
                }
            }
            
            return { 
                success: false, 
                error: errorMessage,
                response: null
            };
        }
        
        if (!isJSON) {
            const text = await response.text();
            return {
                success: false,
                error: 'Сервер вернул не JSON ответ',
                response: text.substring(0, 200)
            };
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Ошибка отправки AT-команды:', error);
        
        // Обрабатываем ошибки парсинга JSON
        let errorMessage = error.message || 'Неизвестная ошибка';
        if (errorMessage.includes('Unexpected token')) {
            errorMessage = 'Сервер вернул некорректный ответ. Проверьте, что модем подключен.';
        }
        
        return { 
            success: false, 
            error: errorMessage,
            response: null
        };
    }
}

// Принудительная проверка подключения к модему в режиме Сервер
async function forceConnectToModem() {
    if (!currentSettingsModem) {
        showMessage('Выберите модем', 'error');
        return;
    }

    const mode = document.getElementById('modem-mode').value;
    if (mode !== 'server') {
        showMessage('Эта функция работает только для режима "Сервер"', 'error');
        return;
    }

    const forceConnectBtn = document.getElementById('force-connect-btn');
    if (forceConnectBtn) {
        forceConnectBtn.disabled = true;
        forceConnectBtn.textContent = '⏳ Проверка...';
    }

    try {
        const response = await fetch(`/api/modems/${currentSettingsModem}/force-connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (data.success) {
            showMessage(`✅ Подключение успешно! Адрес: ${data.address}`, 'success');
            // Обновляем список модемов, чтобы статус обновился
            setTimeout(() => {
                loadModems();
            }, 1000);
        } else {
            let errorMsg = `❌ ${data.error || 'Ошибка подключения'}`;
            if (data.hint) {
                errorMsg += `\n\n💡 ${data.hint}`;
            }
            if (data.diagnostic) {
                errorMsg += `\n\n📊 Диагностика:`;
                errorMsg += `\n   IP модема: ${data.diagnostic.modemIP || 'не указан'}`;
                errorMsg += `\n   Порт: ${data.diagnostic.port || 'не указан'}`;
            }
            showMessage(errorMsg, 'error');
        }
    } catch (error) {
        showMessage('Ошибка: ' + error.message, 'error');
    } finally {
        if (forceConnectBtn) {
            forceConnectBtn.disabled = false;
            forceConnectBtn.textContent = '🔍 Проверить подключение';
        }
    }
}

// Загрузка и отображение состояний GPIO
async function refreshGPIOStates() {
    if (!currentGPIOModem) {
        return;
    }
    
    const tbody = document.getElementById('gpio-states-tbody');
    if (!tbody) return;
    
    const refreshBtn = document.getElementById('refresh-gpio-btn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ Обновление...';
    }
    
    try {
        const response = await fetch(`/api/modems/${currentGPIOModem}/gpio`);
        const data = await response.json();
        
        if (data.success) {
            // Определяем названия GPIO
            const gpioNames = {
                1: 'GPIO 1',
                2: 'GPIO 2',
                3: 'GPIO 3 / АЦП',
                4: 'GPO 4 (Силовой)',
                5: 'GPO 5 (DCD)',
                6: 'GPO 6 (DSR)',
                7: 'GPO 7 (CTS)',
                8: 'GPO 8 (RING)'
            };
            
            // Определяем типы GPIO
            const gpioTypes = {
                1: 'Универсальный',
                2: 'Универсальный',
                3: 'Универсальный / АЦП',
                4: 'Силовой выход',
                5: 'RS232 (DCD)',
                6: 'RS232 (DSR)',
                7: 'RS232 (CTS)',
                8: 'RS232 (RING)'
            };
            
            // Создаем строки таблицы (всегда показываем все GPIO)
            let html = '';
            const gpios = data.gpios || {};
            
            for (let i = 1; i <= 8; i++) {
                const gpioData = gpios[i];
                const name = gpioNames[i] || `GPIO ${i}`;
                const type = gpioTypes[i] || 'Неизвестно';
                
                if (gpioData && gpioData.value !== undefined && gpioData.value !== null) {
                    const value = gpioData.value;
                    const stateText = value === 1 ? 'ВКЛ' : value === 0 ? 'ВЫКЛ' : 'НЕИЗВЕСТНО';
                    const stateClass = value === 1 ? 'status-online' : value === 0 ? 'status-offline' : '';
                    const stateIcon = value === 1 ? '🟢' : value === 0 ? '⚪' : '❓';
                    const gpioType = gpioData.type || 'unknown';
                    const time = gpioData.time ? new Date(gpioData.time).toLocaleString('ru-RU') : '—';
                    
                    html += `
                        <tr>
                            <td><strong>${i}</strong></td>
                            <td>${name}</td>
                            <td>${type}<br><small style="color: #666;">(${gpioType})</small></td>
                            <td><span class="${stateClass}">${stateIcon} ${stateText}</span></td>
                            <td><code>${value}</code></td>
                            <td><small>${time}</small></td>
                        </tr>
                    `;
                } else {
                    html += `
                        <tr>
                            <td><strong>${i}</strong></td>
                            <td>${name}</td>
                            <td>${type}</td>
                            <td><span style="color: #999;">—</span></td>
                            <td><code>—</code></td>
                            <td><small>—</small></td>
                        </tr>
                    `;
                }
            }
            
            tbody.innerHTML = html;
            
            // Если данных нет, показываем подсказку под таблицей
            if (!data.gpios || Object.keys(data.gpios).length === 0) {
                const noteMsg = data.note || 'Модем подключен, но данные о GPIO отсутствуют. Настройте автоматическую отправку: GPIO_SEND1=1, GPIO_SEND2=1, GPIO_SEND3=1';
                tbody.innerHTML += `
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 20px; color: #999; background: #f5f5f5; border-top: 2px solid #ddd;">
                            <small><strong>💡 Информация:</strong> ${noteMsg}</small><br>
                            <small style="color: #666; margin-top: 10px; display: block;">
                                Проверьте настройки модема:<br>
                                1. GPIO настроены как входы (GPIO_SET<X>=0,0)<br>
                                2. Автоматическая отправка включена (GPIO_SEND<X>=1)<br>
                                3. Инкапсуляция включена (CLNT_SET1=1,0,0,1)
                            </small>
                        </td>
                    </tr>
                `;
            } else {
                console.log('GPIO States received:', data.gpios); // Отладка
            }
        } else {
            // Ошибка запроса
            console.log('GPIO States error:', data); // Отладка
            let errorMsg = data.error || 'Ошибка получения данных о GPIO';
            let noteMsg = data.note || 'Убедитесь, что модем подключен и настроен на отправку данных';
            
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 20px; color: #d32f2f;">
                        ${errorMsg}<br>
                        <small>${noteMsg}</small><br>
                        <small style="color: #666; margin-top: 10px; display: block;">
                            💡 Проверьте:<br>
                            1. Модем подключен через TCP<br>
                            2. GPIO настроены как входы (GPIO_SET<X>=0,0)<br>
                            3. Автоматическая отправка включена (GPIO_SEND<X>=1)<br>
                            4. Инкапсуляция включена (CLNT_SET1=1,0,0,1)
                        </small>
                    </td>
                </tr>
            `;
        }
    } catch (error) {
        const tbody = document.getElementById('gpio-states-tbody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 20px; color: #d32f2f;">
                        Ошибка загрузки состояний: ${error.message}
                    </td>
                </tr>
            `;
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 Обновить';
        }
    }
}

// Включение/выключение автоматического обновления GPIO
function toggleAutoRefreshGPIO() {
    const checkbox = document.getElementById('auto-refresh-gpio');
    if (!checkbox) return;
    
    if (checkbox.checked) {
        // Включаем автоматическое обновление каждые 5 секунд
        if (gpioAutoRefreshInterval) {
            clearInterval(gpioAutoRefreshInterval);
        }
        gpioAutoRefreshInterval = setInterval(() => {
            if (currentGPIOModem) {
                refreshGPIOStates();
            }
        }, 5000);
    } else {
        // Выключаем автоматическое обновление
        if (gpioAutoRefreshInterval) {
            clearInterval(gpioAutoRefreshInterval);
            gpioAutoRefreshInterval = null;
        }
    }
}
