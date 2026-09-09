const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Конфигурация SMS-шлюза (можно настроить позже)
const SMS_CONFIG = {
  enabled: false,
  apiUrl: '',
  apiKey: '',
  // Альтернатива: использовать GSM-модем для отправки SMS
  useGSMModem: false,
  gsmModemPort: ''
};

// Конфигурация Telegram уведомлений
const TELEGRAM_CONFIG = {
  enabled: false,
  botToken: '', // Токен бота от @BotFather
  chatIds: [], // Список Chat ID получателей
  // Правила уведомлений
  notifications: {
    modemConnected: true, // Модем подключился
    modemDisconnected: true, // Модем отключился
    modemOffline: true, // Модем долго офлайн
    modemOfflineMinutes: 30, // Через сколько минут считать офлайн
    gpioChangedPhysical: false, // Физическое изменение GPIO (датчик/кнопка)
    gpioChangedCommand: false, // Команды GPIO из веб-интерфейса
    commandError: true, // Ошибка выполнения команды
    lowSignal: true, // Низкий уровень сигнала
    lowSignalThreshold: 10, // Порог низкого сигнала (CSQ)
    settingsChanged: false // Изменение настроек
  }
};

// Файл для хранения настроек модемов
const MODEMS_FILE = path.join(__dirname, 'modems.json');
const SMS_CONFIG_FILE = path.join(__dirname, 'sms-config.json');
const TELEGRAM_CONFIG_FILE = path.join(__dirname, 'telegram-config.json');

// Хранилище настроек модемов
let modems = {};

// Загрузка модемов из файла
function loadModems() {
  try {
    if (fs.existsSync(MODEMS_FILE)) {
      const data = fs.readFileSync(MODEMS_FILE, 'utf8');
      if (data.trim() === '') {
        console.log('⚠️  Файл модемов пуст, создаю новый');
        modems = {};
        saveModems();
        return;
      }
      modems = JSON.parse(data);
      const count = Object.keys(modems).length;
      console.log(`✅ Загружено модемов: ${count}`);
      if (count > 0) {
        console.log('   Модемы:', Object.keys(modems).join(', '));
      }
    } else {
      console.log('📝 Файл модемов не найден, создам при первом сохранении');
      modems = {};
      // Создаем пустой файл сразу
      saveModems();
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки модемов:', error);
    // Пытаемся загрузить из резервной копии
    const backupFile = MODEMS_FILE + '.backup';
    if (fs.existsSync(backupFile)) {
      console.log('🔄 Пытаюсь загрузить из резервной копии...');
      try {
        const backupData = fs.readFileSync(backupFile, 'utf8');
        modems = JSON.parse(backupData);
        console.log('✅ Загружено из резервной копии');
        // Восстанавливаем основной файл
        fs.copyFileSync(backupFile, MODEMS_FILE);
      } catch (backupError) {
        console.error('❌ Ошибка загрузки резервной копии:', backupError);
        modems = {};
      }
    } else {
      modems = {};
    }
  }
}

// Сохранение модемов в файл
function saveModems() {
  try {
    // Создаем резервную копию перед сохранением
    if (fs.existsSync(MODEMS_FILE)) {
      const backupFile = MODEMS_FILE + '.backup';
      fs.copyFileSync(MODEMS_FILE, backupFile);
    }
    
    // Сохраняем данные
    const dataToSave = JSON.stringify(modems, null, 2);
    fs.writeFileSync(MODEMS_FILE, dataToSave, 'utf8');
    console.log(`💾 Настройки модемов сохранены (${Object.keys(modems).length} модемов)`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка сохранения модемов:', error);
    console.error('Стек ошибки:', error.stack);
    return false;
  }
}

// Загрузка конфигурации SMS из файла
function loadSMSConfig() {
  try {
    if (fs.existsSync(SMS_CONFIG_FILE)) {
      const data = fs.readFileSync(SMS_CONFIG_FILE, 'utf8');
      const savedConfig = JSON.parse(data);
      Object.assign(SMS_CONFIG, savedConfig);
      console.log('✅ Конфигурация SMS загружена');
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки конфигурации SMS:', error);
  }
}

// Сохранение конфигурации SMS в файл
function saveSMSConfig() {
  try {
    fs.writeFileSync(SMS_CONFIG_FILE, JSON.stringify(SMS_CONFIG, null, 2), 'utf8');
    console.log('💾 Конфигурация SMS сохранена');
  } catch (error) {
    console.error('❌ Ошибка сохранения конфигурации SMS:', error);
  }
}

// Загрузка конфигурации Telegram из файла
function loadTelegramConfig() {
  try {
    if (fs.existsSync(TELEGRAM_CONFIG_FILE)) {
      const data = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf8');
      const savedConfig = JSON.parse(data);
      Object.assign(TELEGRAM_CONFIG, savedConfig);
      console.log('✅ Конфигурация Telegram загружена');
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки конфигурации Telegram:', error);
  }
}

// Сохранение конфигурации Telegram в файл
function saveTelegramConfig() {
  try {
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(TELEGRAM_CONFIG, null, 2), 'utf8');
    console.log('💾 Конфигурация Telegram сохранена');
  } catch (error) {
    console.error('❌ Ошибка сохранения конфигурации Telegram:', error);
  }
}

// Функция отправки Telegram уведомления
async function sendTelegramNotification(message) {
  if (!TELEGRAM_CONFIG.enabled) {
    return { success: false, message: 'Telegram уведомления отключены' };
  }

  if (!TELEGRAM_CONFIG.botToken) {
    return { success: false, message: 'Не указан токен бота Telegram' };
  }

  if (!TELEGRAM_CONFIG.chatIds || TELEGRAM_CONFIG.chatIds.length === 0) {
    return { success: false, message: 'Не указаны Chat ID получателей' };
  }

  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`;
  const results = [];

  console.log(`📱 Попытка отправки Telegram сообщения в ${TELEGRAM_CONFIG.chatIds.length} чат(ов)`);
  console.log(`   Chat IDs: ${TELEGRAM_CONFIG.chatIds.join(', ')}`);

  // Отправляем сообщение всем получателям
  for (const chatId of TELEGRAM_CONFIG.chatIds) {
    try {
      // Преобразуем Chat ID в число, если это возможно (Telegram API принимает числа)
      const chatIdNum = typeof chatId === 'string' && !isNaN(chatId) ? parseInt(chatId) : chatId;
      console.log(`   Отправка в чат ${chatIdNum} (тип: ${typeof chatIdNum})...`);
      
      const response = await axios.post(telegramApiUrl, {
        chat_id: chatIdNum,
        text: message,
        parse_mode: 'HTML'
      }, {
        timeout: 10000 // 10 секунд таймаут
      });

      if (response.data.ok) {
        console.log(`✅ Telegram уведомление отправлено в чат ${chatId}`);
        results.push({ chatId, success: true, messageId: response.data.result.message_id });
      } else {
        console.error(`❌ Ошибка отправки Telegram в чат ${chatId}:`, JSON.stringify(response.data, null, 2));
        let errorMsg = response.data.description || response.data.error_code || 'Неизвестная ошибка';
        
        // Улучшаем сообщения об ошибках для пользователя
        if (errorMsg.includes('chat not found')) {
          errorMsg = 'Чат не найден. Убедитесь, что вы написали боту хотя бы одно сообщение (например, /start)';
        } else if (errorMsg.includes('bot was blocked')) {
          errorMsg = 'Бот заблокирован. Разблокируйте бота в Telegram';
        } else if (errorMsg.includes('chat_id is empty')) {
          errorMsg = 'Chat ID пустой. Проверьте правильность Chat ID';
        }
        
        results.push({ chatId, success: false, error: errorMsg, errorCode: response.data.error_code });
      }
    } catch (error) {
      console.error(`❌ Ошибка отправки Telegram в чат ${chatId}:`, error.message);
      if (error.response) {
        console.error(`   Ответ от Telegram API:`, JSON.stringify(error.response.data, null, 2));
        let errorMsg = error.response.data?.description || error.message || 'Неизвестная ошибка';
        
        // Улучшаем сообщения об ошибках для пользователя
        if (errorMsg.includes('chat not found')) {
          errorMsg = 'Чат не найден. Убедитесь, что вы написали боту хотя бы одно сообщение (например, /start)';
        } else if (errorMsg.includes('bot was blocked')) {
          errorMsg = 'Бот заблокирован. Разблокируйте бота в Telegram';
        } else if (errorMsg.includes('chat_id is empty')) {
          errorMsg = 'Chat ID пустой. Проверьте правильность Chat ID';
        }
        
        results.push({ 
          chatId, 
          success: false, 
          error: errorMsg,
          errorCode: error.response.data?.error_code,
          code: error.code
        });
      } else {
        results.push({ 
          chatId, 
          success: false, 
          error: error.message || 'Неизвестная ошибка',
          code: error.code
        });
      }
    }
  }

  // Возвращаем успех, если хотя бы одно сообщение отправлено
  const successCount = results.filter(r => r.success).length;
  if (successCount > 0) {
    return { 
      success: true, 
      sent: successCount,
      total: results.length,
      results 
    };
  } else {
    return { 
      success: false, 
      error: 'Не удалось отправить ни одно сообщение',
      results 
    };
  }
}

// Загружаем данные при старте
loadModems();
loadSMSConfig();
loadTelegramConfig();

// TCP-сервер для приема подключений от модемов
const MODEM_PORT = 2001; // Порт для подключения модемов
const modemConnections = new Map(); // Хранилище активных подключений
const pendingCommands = new Map(); // Ожидающие ответа команды: socket -> { resolve, reject, timeout }

const modemServer = net.createServer((socket) => {
  const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n📱 Новое подключение от модема: ${clientAddress}`);
  
  // Пытаемся определить модем
  // Пока не можем точно определить, какой модем подключился, так как модем не отправляет свой номер при подключении
  // Будем использовать первое доступное соединение или ждать данных от модема
  let connectedModem = null;
  
  // Пытаемся определить модем по IP-адресу
  const clientIP = clientAddress.split(':')[0];
  const modemList = Object.entries(modems);
  
  // Сначала пытаемся найти модем по сохраненному IP-адресу
  for (const [phoneNumber, modem] of modemList) {
    // Проверяем, что модем в режиме "Клиент" или не настроен (по умолчанию клиент)
    const isClientMode = !modem.settings || modem.settings.mode !== 'server';
    
    if (isClientMode) {
      // Проверяем по последнему известному IP
      if (modem.lastKnownIP === clientIP || modem.connectionAddress?.split(':')[0] === clientIP) {
        connectedModem = modem;
        const previousStatus = modem.status;
        modem.status = 'online';
        modem.lastConnection = new Date().toISOString();
        modem.connectionAddress = clientAddress;
        modem.lastKnownIP = clientIP;
        console.log(`✅ Модем ${modem.name} (${phoneNumber}) распознан по IP ${clientIP} и подключен`);
        
        // Отправляем уведомление о подключении
        if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.modemConnected && previousStatus !== 'online') {
          const message = `<b>🔌 Модем подключен</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${phoneNumber}\n<b>Адрес:</b> ${clientAddress}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
          sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления о подключении:', err));
        }
        break;
      }
    }
  }
  
  // Если не нашли по IP, используем старую логику
  if (!connectedModem) {
    if (modemList.length === 1) {
      const [phoneNumber, modem] = modemList[0];
      // Проверяем, что модем не в режиме "Сервер"
      if (!modem.settings || modem.settings.mode !== 'server') {
        connectedModem = modem;
        const previousStatus = modem.status;
        modem.status = 'online';
        modem.lastConnection = new Date().toISOString();
        modem.connectionAddress = clientAddress;
        modem.lastKnownIP = clientIP;
        console.log(`✅ Модем ${modem.name} (${phoneNumber}) подключен с адреса ${clientAddress}`);
        
        // Отправляем уведомление о подключении
        if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.modemConnected && previousStatus !== 'online') {
          const message = `<b>🔌 Модем подключен</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${phoneNumber}\n<b>Адрес:</b> ${clientAddress}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
          sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления о подключении:', err));
        }
      }
    } else if (modemList.length > 1) {
      // Если несколько модемов, ищем модем без активного соединения в режиме "Клиент"
      for (const [phoneNumber, modem] of modemList) {
        // Пропускаем модемы в режиме "Сервер"
        if (modem.settings && modem.settings.mode === 'server') {
          continue;
        }
        
        // Проверяем, есть ли уже активное соединение для этого модема
        let hasActiveConnection = false;
        for (const [addr, conn] of modemConnections.entries()) {
          if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
            hasActiveConnection = true;
            break;
          }
        }
        
        // Если у модема нет активного соединения, связываем его с этим подключением
        if (!hasActiveConnection && !connectedModem) {
          connectedModem = modem;
          const previousStatus = modem.status;
          modem.status = 'online';
          modem.lastConnection = new Date().toISOString();
          modem.connectionAddress = clientAddress;
          modem.lastKnownIP = clientIP;
          console.log(`✅ Модем ${modem.name} (${phoneNumber}) подключен с адреса ${clientAddress}`);
          
          // Отправляем уведомление о подключении
          if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.modemConnected && previousStatus !== 'online') {
            const message = `<b>🔌 Модем подключен</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${phoneNumber}\n<b>Адрес:</b> ${clientAddress}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
            sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления о подключении:', err));
          }
          break;
        }
      }
      
      // Если не нашли свободный модем в режиме "Клиент", используем первый доступный
      if (!connectedModem) {
        for (const [phoneNumber, modem] of modemList) {
          if (!modem.settings || modem.settings.mode !== 'server') {
            connectedModem = modem;
            modem.status = 'online';
            modem.lastConnection = new Date().toISOString();
            modem.connectionAddress = clientAddress;
            modem.lastKnownIP = clientIP;
            console.log(`⚠️  Несколько модемов, связываю соединение с модемом: ${modem.name} (${phoneNumber})`);
            break;
          }
        }
      }
    }
  }
  
  // Если не нашли модем, создаем временную запись
  if (!connectedModem) {
    console.log(`⚠️  Подключение от неизвестного устройства: ${clientAddress}. Модемы не добавлены в систему.`);
  }
  
  // Настраиваем сокет для поддержания соединения
  // Keep-alive позволяет поддерживать соединение активным даже при отсутствии данных
  socket.setKeepAlive(true, 60000); // Проверка каждые 60 секунд
  // Отключаем таймаут закрытия соединения (0 = без таймаута)
  socket.setTimeout(0);
  
  // Обработка таймаута (если все же произойдет)
  socket.on('timeout', () => {
    console.log(`⚠️ Таймаут соединения с модемом ${clientAddress}, но соединение остается открытым`);
    // Не закрываем соединение, просто сбрасываем таймаут
    socket.setTimeout(0);
  });
  
  // Сохраняем подключение
  modemConnections.set(clientAddress, {
    socket,
    modem: connectedModem,
    connectedAt: new Date().toISOString()
  });
  
  // Сохраняем IP модема для использования в режиме Сервер
  if (connectedModem) {
    const modemIP = clientAddress.split(':')[0];
    connectedModem.lastKnownIP = modemIP;
    connectedModem.connectionAddress = clientAddress;
    console.log(`💾 Сохранен IP модема ${connectedModem.phoneNumber}: ${modemIP}`);
    saveModems(); // Сохраняем в файл
  }
  
  // Буфер для накопления данных от модема
  let dataBuffer = '';
  
  // Обработка данных от модема
  socket.on('data', (data) => {
    const dataStr = data.toString();
    dataBuffer += dataStr;
    
    // Логируем все данные для диагностики
    // Keep-alive пакеты протокола iRZ Collector могут быть в разных форматах
    const dataHex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`📨 Данные от модема ${clientAddress}: ${data.length} байт, HEX: ${dataHex.substring(0, 100)}`);
    
    // Проверяем, является ли это keep-alive пакетом от протокола iRZ Collector
    // Keep-alive пакеты обычно короткие (1-18 байт) и могут быть в бинарном формате
    // Протокол iRZ Collector может отправлять keep-alive в формате инкапсуляции
    const isKeepAlive = data.length <= 18 && (
      dataStr.length === 0 || 
      dataStr.match(/^\x00+$/) ||
      dataStr.match(/^\s*$/) ||
      // Проверяем на возможные форматы keep-alive iRZ Collector
      (data.length > 0 && data[0] === 0x00)
    );
    
    if (isKeepAlive) {
      console.log(`💓 Keep-alive пакет от модема ${clientAddress} (${data.length} байт, HEX: ${dataHex})`);
      // Для протокола iRZ Collector сервер обычно не должен отвечать на keep-alive
      // Но если модем закрывает соединение, возможно нужно отправлять подтверждение
      // Пока просто логируем, чтобы понять паттерн
    }
    
    // Пытаемся извлечь информацию из автоматических данных модема
    // Модем может отправлять данные в разных форматах
    parseModemData(dataStr, connectedModem, clientAddress);
    
    // Проверяем, есть ли ожидающие команды
    const pending = pendingCommands.get(socket);
    if (pending) {
      pending.responseBuffer += dataStr;
      
      // Увеличиваем счетчик полученных данных
      if (!pending.dataCount) pending.dataCount = 0;
      pending.dataCount++;
      
      const response = pending.responseBuffer;
      
      // Проверяем, получили ли мы полный ответ
      // Модем может отвечать в разных форматах:
      // 1. AT$ATM_IMEI?\r\n^ATM_IMEI:123456789012345\r\nOK\r\n
      // 2. Просто данные без OK
      // 3. ERROR или ACCESS ERROR
      
      const hasOK = response.includes('OK');
      const hasERROR = response.includes('ERROR') || response.includes('ACCESS ERROR');
      const hasResponse = response.match(/\^[A-Z_]+\s*:/) || response.match(/\+[A-Z]+:/); // Формат ответа ^ATM_IMEI: или +COPS:
      
      // Если получили OK или ERROR - это полный ответ
      if (hasOK || hasERROR) {
        console.log(`✅ Получен полный ответ от модема ${clientAddress} (${pending.dataCount} пакетов):`, response.substring(0, 200));
        clearTimeout(pending.timeout);
        pendingCommands.delete(socket);
        pending.resolve(response.trim());
      } 
      // Если получили ответ в формате ^ATM_... или +COPS: и прошло достаточно времени (модем может не отправлять OK)
      else if (hasResponse && pending.dataCount >= 2) {
        // Ждем еще немного, может придет OK
        setTimeout(() => {
          if (pendingCommands.has(socket)) {
            const finalResponse = pending.responseBuffer;
            console.log(`⚠️ Ответ без OK от модема ${clientAddress}, считаем завершенным:`, finalResponse.substring(0, 200));
            clearTimeout(pending.timeout);
            pendingCommands.delete(socket);
            pending.resolve(finalResponse.trim());
          }
        }, 500); // Ждем 500мс на случай если OK еще придет
      }
    }
    
    // Сохраняем последние данные для возможного использования в API
    if (connectedModem) {
      if (!connectedModem.lastData) {
        connectedModem.lastData = [];
      }
      connectedModem.lastData.push({
        timestamp: new Date().toISOString(),
        data: dataStr
      });
      // Храним только последние 100 записей
      if (connectedModem.lastData.length > 100) {
        connectedModem.lastData.shift();
      }
    }
  });
  
  // Обработка закрытия соединения
  socket.on('close', (hadError) => {
    const reason = hadError ? 'из-за ошибки' : 'нормально';
    const connectionDuration = connectedModem ? 
      Math.round((Date.now() - new Date(connectedModem.lastConnection || Date.now()).getTime()) / 1000) : 0;
    
    console.log(`❌ Модем ${clientAddress} отключился (${reason})`);
    console.log(`   💡 Информация о соединении:`);
    console.log(`      - Destroyed: ${socket.destroyed}`);
    console.log(`      - Readable: ${socket.readable}`);
    console.log(`      - Writable: ${socket.writable}`);
    if (connectionDuration > 0) {
      console.log(`      - Длительность соединения: ${connectionDuration} секунд (${Math.round(connectionDuration / 60)} минут)`);
      
      // Если соединение закрывается примерно через минуту, это может быть проблема с keep-alive
      if (connectionDuration >= 55 && connectionDuration <= 65) {
        console.log(`   ⚠️  ВНИМАНИЕ: Соединение закрылось примерно через минуту!`);
        console.log(`   💡 Это может указывать на проблему с keep-alive или настройками модема:`);
        console.log(`      1. ⚠️  Ждущий режим включен (AT$WAIT_PAUSE) - ОБЯЗАТЕЛЬНО ОТКЛЮЧИТЕ!`);
        console.log(`      2. ⚠️  Протокол не iRZ Collector - проверьте AT$CLNT_PRTCL1=1`);
        console.log(`      3. ⚠️  Инкапсуляция не включена - проверьте AT$CLNT_SET1=1,0,0,1`);
        console.log(`      4. ⚠️  Модем не получает ответ на keep-alive пакеты`);
      }
    }
    console.log(`   💡 Для протокола iRZ Collector модем должен автоматически переподключиться.`);
    console.log(`   💡 Если переподключение не происходит, проверьте:`);
    console.log(`      1. Ждущий режим отключен (AT$WAIT_PAUSE=0)`);
    console.log(`      2. Протокол iRZ Collector (AT$CLNT_PRTCL1=1)`);
    console.log(`      3. Инкапсуляция включена (AT$CLNT_SET1=1,0,0,1)`);
    console.log(`      4. Стабильность интернет-соединения модема`);
    modemConnections.delete(clientAddress);
    
    // Очищаем ожидающие команды для этого сокета
    if (pendingCommands.has(socket)) {
      const pending = pendingCommands.get(socket);
      clearTimeout(pending.timeout);
      pending.reject(new Error('Соединение закрыто'));
      pendingCommands.delete(socket);
    }
    
    // Обновляем статус модема на офлайн
    if (connectedModem) {
      const previousStatus = connectedModem.status;
      connectedModem.status = 'offline';
      connectedModem.lastDisconnection = new Date().toISOString();
      saveModems();
      
      // Отправляем уведомление об отключении
      if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.modemDisconnected && previousStatus === 'online') {
        const message = `<b>❌ Модем отключен</b>\n\n<b>Модем:</b> ${connectedModem.name}\n<b>Номер:</b> ${connectedModem.phoneNumber}\n<b>Адрес:</b> ${clientAddress}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
        sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления об отключении:', err));
      }
    }
  });
  
  // Обработка ошибок
  socket.on('error', (err) => {
    console.error(`❌ Ошибка соединения с модемом ${clientAddress}:`, err.message);
    console.error(`   💡 Детали ошибки:`, {
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      address: err.address,
      port: err.port
    });
  });
  
  // Отправляем приветственное сообщение (опционально)
  // socket.write('OK\n');
});

// Запуск TCP-сервера для модемов
modemServer.listen(MODEM_PORT, '0.0.0.0', () => {
  console.log(`\n📡 TCP-сервер для модемов запущен на порту ${MODEM_PORT}`);
  console.log(`   Модемы могут подключаться по адресу: 147.45.212.205:${MODEM_PORT}\n`);
});

modemServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ ОШИБКА: Порт ${MODEM_PORT} уже занят!\n`);
    console.log('Решения:');
    console.log(`1. Найдите процесс: sudo lsof -i :${MODEM_PORT}`);
    console.log('2. Остановите процесс: sudo kill <PID>');
    console.log('3. Или измените порт в настройках модема\n');
  } else {
    console.error('❌ Ошибка TCP-сервера:', err);
  }
});

// Функция для отправки SMS-команды на модем
async function sendSMSCommand(phoneNumber, command) {
  if (!SMS_CONFIG.enabled) {
    console.log(`\n📱 [SMS] Команда для модема ${phoneNumber}:`);
    console.log(`   Команда: ${command}`);
    console.log(`   ⚠️  Режим тестирования - SMS не отправлено. Настройте SMS-шлюз для реальной отправки.\n`);
    return { success: true, message: 'Команда подготовлена (режим тестирования - SMS не отправлено)' };
  }

  try {
    // Здесь должна быть интеграция с SMS-шлюзом
    // Пример для API SMS-шлюза:
    if (SMS_CONFIG.apiUrl) {
      const response = await axios.post(SMS_CONFIG.apiUrl, {
        phone: phoneNumber,
        message: command,
        apiKey: SMS_CONFIG.apiKey
      });
      return { success: true, message: 'Команда отправлена', data: response.data };
    }
    
    return { success: false, message: 'SMS-шлюз не настроен' };
  } catch (error) {
    console.error('Ошибка отправки SMS:', error);
    return { success: false, message: error.message };
  }
}

// Формирование SMS-команды по стандарту IRZ
function formatSMSCommand(password, apply, command) {
  // Формат: <пароль> <0/1>AT$<команда>
  return `${password} ${apply ? '1' : '0'}AT$${command}`;
}

// Парсинг данных от модема для извлечения информации
function parseModemData(dataStr, modem, address) {
  if (!modem) return;
  
  // Инициализируем объект для хранения извлеченных данных
  if (!modem.parsedData) {
    modem.parsedData = {};
  }
  
  // Пытаемся найти IMEI в данных
  const imeiMatch = dataStr.match(/\^ATM_IMEI:\s*(\d+)/i) || dataStr.match(/IMEI[:\s]+(\d+)/i);
  if (imeiMatch) {
    modem.parsedData.imei = imeiMatch[1];
    console.log(`📱 Извлечен IMEI из данных модема ${modem.phoneNumber}: ${imeiMatch[1]}`);
  }
  
  // Пытаемся найти название устройства
  const nameMatch = dataStr.match(/\^ATM_NAME:\s*([^\r\n]+)/i) || dataStr.match(/ATM\d+[\.\w\/]+/i);
  if (nameMatch) {
    modem.parsedData.deviceName = nameMatch[1] || nameMatch[0];
    console.log(`📱 Извлечено название из данных модема ${modem.phoneNumber}: ${modem.parsedData.deviceName}`);
  }
  
  // Пытаемся найти версию ПО
  const softMatch = dataStr.match(/\^ATM_SOFT:\s*([^\r\n]+)/i);
  if (softMatch) {
    modem.parsedData.software = softMatch[1];
    console.log(`📱 Извлечена версия ПО из данных модема ${modem.phoneNumber}: ${softMatch[1]}`);
  }
  
  // Пытаемся найти версию железа
  const hardMatch = dataStr.match(/\^ATM_HARD:\s*([^\r\n]+)/i);
  if (hardMatch) {
    modem.parsedData.hardware = hardMatch[1];
    console.log(`📱 Извлечена версия железа из данных модема ${modem.phoneNumber}: ${hardMatch[1]}`);
  }
  
  // Пытаемся найти уровень сигнала CSQ
  const csqMatch = dataStr.match(/\^ATM_CSQ:\s*(\d+)/i);
  if (csqMatch) {
    const csqValue = parseInt(csqMatch[1]);
    const previousCSQ = modem.parsedData?.csq;
    modem.parsedData.csq = csqValue;
    modem.parsedData.csqTime = new Date().toISOString();
    console.log(`📱 Извлечен CSQ из данных модема ${modem.phoneNumber}: ${csqMatch[1]}`);
    
    // Проверяем низкий уровень сигнала и отправляем уведомление
    if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.lowSignal) {
      const threshold = TELEGRAM_CONFIG.notifications.lowSignalThreshold || 10;
      if (csqValue <= threshold && csqValue >= 0 && csqValue <= 31) {
        // Отправляем уведомление только если CSQ изменился или это первое значение
        if (previousCSQ === undefined || previousCSQ > threshold) {
          const percent = Math.round((csqValue / 31) * 100);
          const message = `<b>⚠️ Низкий уровень сигнала</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${modem.phoneNumber}\n<b>CSQ:</b> ${csqValue} (${percent}%)\n<b>Порог:</b> ${threshold}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
          sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления о низком сигнале:', err));
        }
      }
    }
  }
  
  // Пытаемся найти оператора
  const operatorMatch = dataStr.match(/\+COPS:\s*\d+,\d+,"([^"]+)"/i);
  if (operatorMatch) {
    modem.parsedData.operator = operatorMatch[1];
    console.log(`📱 Извлечен оператор из данных модема ${modem.phoneNumber}: ${operatorMatch[1]}`);
  }
  
  // Пытаемся найти данные о GPIO (различные форматы)
  // Формат 1: ^GPIO_SET<X>:<направление>,<значение> или ^GPIO_SET<X>:<значение> (для входов)
  const gpioSetMatch = dataStr.match(/\^GPIO_SET(\d+):\s*(\d+)(?:,(\d+))?/i);
  // Формат 2: ^GPIO_OUT<X>:<значение> (для выходов)
  const gpioOutMatch = dataStr.match(/\^GPIO_OUT(\d+):\s*(\d+)/i);
  // Формат 3: GPIO<X>=<значение> или GPIO<X>:<значение> или GPIO_<X>=<значение>
  const gpioSimpleMatch = dataStr.match(/GPIO[_\s]*(\d+)[=:]\s*(\d+)/i);
  
  // Логируем, если данные содержат GPIO, но не распознаны
  if (dataStr.toLowerCase().includes('gpio') && !gpioSetMatch && !gpioOutMatch && !gpioSimpleMatch) {
    console.log(`⚠️  Обнаружено упоминание GPIO в данных, но формат не распознан:`);
    console.log(`   📨 Данные: ${dataStr.substring(0, 200)}`);
    console.log(`   💡 Добавьте поддержку этого формата в parseModemData, если это данные о GPIO`);
  }
  
  // Формат 3: Данные в бинарном формате с инкапсуляцией (нужно будет парсить отдельно)
  
  let gpioNumber = null;
  let gpioValue = null;
  let gpioType = null; // 'input' или 'output'
  
  if (gpioSetMatch) {
    gpioNumber = parseInt(gpioSetMatch[1]);
    // Если есть два значения (направление, значение), второе - это значение GPIO
    // Если только одно значение, это может быть либо направление, либо значение
    gpioValue = gpioSetMatch[3] !== undefined ? parseInt(gpioSetMatch[3]) : parseInt(gpioSetMatch[2]);
    gpioType = 'input'; // GPIO_SET обычно для входов
  } else if (gpioOutMatch) {
    gpioNumber = parseInt(gpioOutMatch[1]);
    gpioValue = parseInt(gpioOutMatch[2]);
    // GPIO_OUT4 - это GPO4 (силовой выход)
    gpioType = gpioNumber === 4 ? 'gpo4' : 'output'; // GPIO_OUT для выходов, GPO4 - специальный силовой выход
  } else if (gpioSimpleMatch) {
    gpioNumber = parseInt(gpioSimpleMatch[1]);
    gpioValue = parseInt(gpioSimpleMatch[2]);
    // Если номер 4, это может быть GPO4
    gpioType = gpioNumber === 4 ? 'gpo4' : 'unknown';
  }
  
  // Если нашли данные о GPIO, обрабатываем их
  if (gpioNumber !== null && gpioValue !== null) {
    // Инициализируем объект для хранения состояний GPIO
    if (!modem.parsedData.gpio) {
      modem.parsedData.gpio = {};
    }
    
    const gpioKey = `gpio${gpioNumber}`;
    const previousValue = modem.parsedData.gpio[gpioKey]?.value;
    const previousTime = modem.parsedData.gpio[gpioKey]?.time;
    
    // Сохраняем текущее состояние
    modem.parsedData.gpio[gpioKey] = {
      value: gpioValue,
      type: gpioType,
      time: new Date().toISOString()
    };
    
    console.log(`📱 Извлечено состояние GPIO${gpioNumber} из данных модема ${modem.phoneNumber}: ${gpioValue} (${gpioType})`);
    console.log(`   💡 Предыдущее значение: ${previousValue !== undefined ? previousValue : 'неизвестно'}`);
    console.log(`   💡 Текущее значение: ${gpioValue}`);
    console.log(`   💡 Изменение: ${previousValue !== undefined && previousValue !== gpioValue ? 'ДА' : 'НЕТ'}`);
    console.log(`   💡 Уведомления включены: ${TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.gpioChangedPhysical ? 'ДА' : 'НЕТ'}`);
    
    // Отправляем уведомление только если значение изменилось
    if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.gpioChangedPhysical) {
      if (previousValue === undefined || previousValue !== gpioValue) {
        const stateText = gpioValue === 1 ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
        const stateEmoji = gpioValue === 1 ? '🔴' : '⚪';
        const changeText = previousValue === undefined ? 'новое состояние' : `изменение с ${previousValue === 1 ? 'ВКЛ' : 'ВЫКЛ'} на ${gpioValue === 1 ? 'ВКЛ' : 'ВЫКЛ'}`;
        
        // Для GPO4 используем специальное название
        const gpioName = gpioNumber === 4 ? 'GPO4 (силовой выход)' : `GPIO${gpioNumber}`;
        const gpioTypeText = gpioType === 'gpo4' ? 'GPO4 (силовой выход)' : 
                             gpioType === 'input' ? 'вход' : 
                             gpioType === 'output' ? 'выход' : 'неизвестно';
        
        const message = `<b>${stateEmoji} Физическое изменение ${gpioName}</b>\n\n` +
          `<b>🔌 Источник:</b> Физическое изменение (датчик/кнопка/внешнее устройство)\n` +
          `<b>Модем:</b> ${modem.name}\n` +
          `<b>Номер:</b> ${modem.phoneNumber}\n` +
          `<b>GPIO:</b> ${gpioName} (${gpioTypeText})\n` +
          `<b>Состояние:</b> ${stateText} (${gpioValue})\n` +
          `<b>Изменение:</b> ${changeText}\n` +
          `<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
        
        sendTelegramNotification(message).catch(err => {
          console.error('Ошибка отправки уведомления об изменении GPIO:', err);
        });
        
        console.log(`📢 Отправлено Telegram уведомление о ФИЗИЧЕСКОМ изменении GPIO${gpioNumber} модема ${modem.phoneNumber}: ${changeText}`);
      }
    }
  }
  
  // Сохраняем время последнего обновления
  modem.parsedData.lastUpdate = new Date().toISOString();
}

// API: Получить список модемов
app.get('/api/modems', async (req, res) => {
  // Обновляем статусы модемов на основе активных подключений
  const activeConnections = Array.from(modemConnections.values());
  const activeModemPhones = new Set();
  
  activeConnections.forEach(conn => {
    if (conn.modem) {
      activeModemPhones.add(conn.modem.phoneNumber);
      conn.modem.status = 'online';
    }
  });
  
  // Проверяем модемы в режиме "Сервер"
  for (const [phoneNumber, modem] of Object.entries(modems)) {
    if (!activeModemPhones.has(phoneNumber)) {
      // Если модем в режиме "Сервер", проверяем подключение к нему
      if (modem.settings && modem.settings.mode === 'server') {
        // Сначала проверяем существующее подключение
        if (serverModeConnections.has(phoneNumber)) {
          const socket = serverModeConnections.get(phoneNumber);
          if (socket && !socket.destroyed && socket.writable) {
            modem.status = 'online';
            activeModemPhones.add(phoneNumber);
            console.log(`✅ Модем ${phoneNumber} в режиме Сервер - активное подключение найдено`);
            continue;
          } else {
            serverModeConnections.delete(phoneNumber);
            console.log(`⚠️  Модем ${phoneNumber} в режиме Сервер - старое подключение недействительно, удалено`);
          }
        }
        
        // Проверяем, есть ли IP для подключения
        const modemIP = modem.settings.modemIP || modem.lastKnownIP || modem.connectionAddress?.split(':')[0];
        if (!modemIP) {
          console.log(`⚠️  Модем ${phoneNumber} в режиме Сервер - IP-адрес не указан`);
          modem.status = 'offline';
          continue;
        }
        
        console.log(`🔍 Проверка подключения к модему ${phoneNumber} в режиме Сервер (${modemIP}:${modem.settings.port})...`);
        
        // Пытаемся подключиться к модему в режиме сервера (асинхронно, не блокируем ответ)
        connectToModemServer(phoneNumber, modem).then(socket => {
          if (socket) {
            modem.status = 'online';
            modem.lastConnection = new Date().toISOString();
            saveModems();
            console.log(`✅ Модем ${phoneNumber} в режиме Сервер подключен и статус обновлен`);
          }
        }).catch(err => {
          // Логируем ошибки для диагностики, но не блокируем ответ API
          const errorCode = err.code || '';
          if (errorCode === 'ECONNREFUSED') {
            console.log(`❌ Модем ${phoneNumber} в режиме Сервер не принимает подключения на порту ${modem.settings.port}`);
            console.log(`   💡 Возможные причины:`);
            console.log(`      - Модем еще не перезагрузился после настройки`);
            console.log(`      - Модем не принял SMS-команды`);
            console.log(`      - Порт указан неправильно`);
            console.log(`      - Модем не запустил сервер`);
          } else if (errorCode === 'ETIMEDOUT') {
            console.log(`❌ Таймаут подключения к модему ${phoneNumber} (${modemIP}:${modem.settings.port})`);
            console.log(`   💡 Возможные причины:`);
            console.log(`      - Модем недоступен по сети`);
            console.log(`      - Файрвол блокирует подключение`);
            console.log(`      - IP-адрес неверный`);
          } else if (errorCode === 'ENOTFOUND') {
            console.log(`❌ Не удалось найти модем ${phoneNumber} по адресу ${modemIP}`);
            console.log(`   💡 Проверьте правильность IP-адреса`);
          } else {
            console.log(`❌ Ошибка подключения к модему ${phoneNumber} в режиме Сервер: ${err.message} (код: ${errorCode})`);
          }
        });
      }
      
      // Если не в режиме сервера и нет активных подключений - офлайн
      if (!activeModemPhones.has(phoneNumber)) {
        modem.status = 'offline';
      }
    }
  }
  
  const modemsList = Object.values(modems);
  console.log(`📋 Запрос списка модемов: найдено ${modemsList.length}`);
  
  res.json({ modems: modemsList });
});

// API: Добавить/обновить модем
app.post('/api/modems', (req, res) => {
  const { phoneNumber, name, password = '5492' } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Номер телефона обязателен' });
  }

  // Сохраняем или обновляем модем
  if (!modems[phoneNumber]) {
    modems[phoneNumber] = {
      phoneNumber,
      name: name || `Модем ${phoneNumber}`,
      password,
      status: 'offline',
      createdAt: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      settings: {}
    };
  } else {
    // Обновляем только измененные поля
    if (name) modems[phoneNumber].name = name;
    if (password) modems[phoneNumber].password = password;
    modems[phoneNumber].lastUpdate = new Date().toISOString();
  }

  const saved = saveModems();
  if (!saved) {
    return res.status(500).json({ error: 'Ошибка сохранения модема' });
  }
  
  res.json({ success: true, modem: modems[phoneNumber] });
});

// Вспомогательная функция для получения TCP-соединения с модемом
async function getModemSocket(phoneNumber, modem) {
  let modemSocket = null;
  let connectionMode = null;
  
  // Проверяем режим работы модема
  if (modem.settings && modem.settings.mode === 'server') {
    // Режим "Сервер" - подключаемся к модему
    try {
      modemSocket = await connectToModemServer(phoneNumber, modem);
      connectionMode = 'server';
    } catch (error) {
      console.log(`⚠️  Не удалось подключиться к модему ${phoneNumber} в режиме Сервер: ${error.message}`);
    }
  } else {
    // Режим "Клиент" - ищем активное TCP соединение от модема
    for (const [address, conn] of modemConnections.entries()) {
      if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
        modemSocket = conn.socket;
        connectionMode = 'client';
        break;
      }
    }
    
    // Если не нашли точное совпадение, но модем показывает статус "online" и есть активные соединения
    if (!modemSocket && modem.status === 'online' && modemConnections.size > 0) {
      const [address, conn] = modemConnections.entries().next().value;
      if (conn.socket && !conn.socket.destroyed) {
        modemSocket = conn.socket;
        connectionMode = 'client';
        
        // Связываем соединение с модемом, если еще не связано
        if (!conn.modem) {
          conn.modem = modem;
          console.log(`🔗 Связал соединение ${address} с модемом ${phoneNumber} для управления GPIO`);
        }
      }
    }
  }
  
  return { socket: modemSocket, mode: connectionMode };
}

// Вспомогательная функция для отправки AT-команды через TCP с ожиданием ответа
async function sendATCommandViaTCP(modemSocket, command, phoneNumber) {
  // Проверяем, нет ли уже ожидающей команды для этого сокета
  if (pendingCommands.has(modemSocket)) {
    throw new Error('Другая команда уже выполняется. Подождите немного.');
  }
  
  // Проверяем, что сокет доступен
  if (modemSocket.destroyed || modemSocket.writable === false) {
    throw new Error('Соединение с модемом закрыто');
  }
  
  const commandWithNewline = command + '\r\n';
  
  // Создаем Promise для ожидания ответа
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingCommands.has(modemSocket)) {
        const pending = pendingCommands.get(modemSocket);
        const partialResponse = pending.responseBuffer;
        pendingCommands.delete(modemSocket);
        
        if (partialResponse && partialResponse.trim().length > 0) {
          console.log(`⚠️ Таймаут, но есть частичный ответ от модема ${phoneNumber}:`, partialResponse.substring(0, 200));
          resolve(partialResponse.trim());
        } else {
          reject(new Error('Таймаут ожидания ответа от модема (5 секунд)'));
        }
      } else {
        reject(new Error('Таймаут ожидания ответа от модема (5 секунд)'));
      }
    }, 5000);
    
    pendingCommands.set(modemSocket, {
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
      timeout,
      responseBuffer: '',
      dataCount: 0,
      command: command,
      sentAt: new Date().toISOString()
    });
  });
  
  try {
    modemSocket.write(commandWithNewline);
    console.log(`📤 AT-команда отправлена модему ${phoneNumber}: ${command}`);
    
    const response = await responsePromise;
    console.log(`📥 Ответ от модема ${phoneNumber}: ${response.substring(0, 200)}`);
    
    const hasError = response.includes('ERROR') || response.includes('ACCESS ERROR');
    
    // Отправляем уведомление об ошибке команды
    if (hasError && TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.commandError) {
      const modem = modems[phoneNumber];
      if (modem) {
        const message = `<b>❌ Ошибка выполнения команды</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${phoneNumber}\n<b>Команда:</b> <code>${command}</code>\n<b>Ответ:</b> <code>${response.substring(0, 200)}</code>\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
        sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления об ошибке команды:', err));
      }
    }
    
    return {
      success: !hasError,
      response: response
    };
  } catch (error) {
    // Убеждаемся, что очистили pending команду
    if (pendingCommands.has(modemSocket)) {
      pendingCommands.delete(modemSocket);
    }
    
    // Отправляем уведомление об ошибке подключения/таймауте
    if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.commandError) {
      const modem = modems[phoneNumber];
      if (modem) {
        const message = `<b>❌ Ошибка выполнения команды</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${phoneNumber}\n<b>Команда:</b> <code>${command}</code>\n<b>Ошибка:</b> ${error.message}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
        sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления об ошибке:', err));
      }
    }
    
    throw error;
  }
}

// API: Управление GPIO (входами/выходами) через TCP с использованием AT-команд
app.post('/api/modems/:phoneNumber/gpio', async (req, res) => {
  const { phoneNumber } = req.params;
  const { gpioNumber, action, level, impulse } = req.body;

  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  
  // Валидация параметров
  if (!gpioNumber || gpioNumber < 1 || gpioNumber > 8) {
    return res.status(400).json({ error: 'Неверный номер GPIO (должен быть от 1 до 8)' });
  }
  
  if (action !== 'set' && action !== 'impulse') {
    return res.status(400).json({ error: 'Неверное действие. Используйте "set" или "impulse"' });
  }
  
  if (action === 'set' && (level !== 0 && level !== 1)) {
    return res.status(400).json({ error: 'Неверный уровень. Используйте 0 или 1' });
  }
  
  // Пытаемся получить TCP-соединение
  const { socket: modemSocket, mode: connectionMode } = await getModemSocket(phoneNumber, modem);
  
  // Если есть TCP-соединение, отправляем AT-команду через TCP
  if (modemSocket && !modemSocket.destroyed && modemSocket.writable) {
    try {
      let atCommand;
      let commandDescription;
      
      if (action === 'set') {
        // Модемы iRZ принимают SMS-команды через TCP-соединение
        // Формат SMS-команды: <пароль> gpio<X> set=<0/1>
        // Согласно документации, модемы могут принимать SMS-команды через TCP
        atCommand = `${modem.password} gpio${gpioNumber} set=${level}`;
        commandDescription = `установка GPIO${gpioNumber} в состояние ${level} (SMS-формат через TCP)`;
      } else if (action === 'impulse') {
        // Формат SMS-команды для импульса: <пароль> gpio<X> impulse=<0/1>
        const impulseLevel = impulse !== undefined ? impulse : 0; // По умолчанию 0
        atCommand = `${modem.password} gpio${gpioNumber} impulse=${impulseLevel}`;
        commandDescription = `импульс GPIO${gpioNumber} (SMS-формат через TCP)`;
      }
      
      console.log(`📤 Отправка GPIO-команды через TCP (режим ${connectionMode}): ${commandDescription}`);
      
      // Для SMS-команд через TCP модем может не отвечать, но команда может выполниться
      // Отправляем команду и ждем ответ, но если его нет - считаем, что команда могла выполниться
      try {
        const result = await sendATCommandViaTCP(modemSocket, atCommand, phoneNumber);
        
        if (result.success) {
          // Отправляем Telegram уведомление об изменении GPIO (если включено)
          // Используем gpioCommand для команд из веб-интерфейса
          if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.gpioCommand) {
            const stateText = level === 1 ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
            const stateEmoji = level === 1 ? '🔴' : '⚪';
            const actionText = action === 'impulse' ? 'импульс' : `установлен в ${stateText}`;
            
            const message = `<b>${stateEmoji} GPIO${gpioNumber} ${actionText}</b>\n\n` +
              `<b>🖥️ Источник:</b> Команда из веб-интерфейса\n` +
              `<b>Модем:</b> ${modem.name}\n` +
              `<b>Номер:</b> ${phoneNumber}\n` +
              `<b>GPIO:</b> GPIO${gpioNumber}\n` +
              `<b>Действие:</b> ${action === 'set' ? `Установка в ${stateText}` : 'Импульс'}\n` +
              `<b>Метод:</b> TCP (${connectionMode})\n` +
              `<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
            
            sendTelegramNotification(message).catch(err => {
              console.error('Ошибка отправки уведомления об изменении GPIO:', err);
            });
          }
          
          return res.json({ 
            success: true, 
            message: `Команда выполнена успешно через TCP`,
            method: 'tcp',
            mode: connectionMode,
            command: atCommand,
            response: result.response
          });
        } else {
          // Модем вернул ERROR, но это может быть нормально для SMS-команд
          return res.json({ 
            success: false, 
            message: `Модем вернул ошибку`,
            method: 'tcp',
            mode: connectionMode,
            command: atCommand,
            response: result.response,
            error: 'Модем вернул ERROR или ACCESS ERROR',
            note: 'Проверьте состояние GPIO - команда могла выполниться несмотря на ошибку'
          });
        }
      } catch (error) {
        // Для SMS-команд через TCP таймаут - это нормально, команда может выполниться
        if (error.message.includes('Таймаут')) {
          console.log(`⚠️ Таймаут при отправке SMS-команды через TCP, но команда могла выполниться`);
          
          // Отправляем Telegram уведомление даже при таймауте (команда могла выполниться)
          // Используем gpioCommand для команд из веб-интерфейса
          if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.gpioCommand && action === 'set') {
            const stateText = level === 1 ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
            const stateEmoji = level === 1 ? '🔴' : '⚪';
            
            const message = `<b>${stateEmoji} GPIO${gpioNumber} установлен в ${stateText}</b>\n\n` +
              `<b>🖥️ Источник:</b> Команда из веб-интерфейса\n` +
              `<b>Модем:</b> ${modem.name}\n` +
              `<b>Номер:</b> ${phoneNumber}\n` +
              `<b>GPIO:</b> GPIO${gpioNumber}\n` +
              `<b>Состояние:</b> ${stateText}\n` +
              `<b>Метод:</b> TCP (${connectionMode})\n` +
              `<b>⚠️ Примечание:</b> Модем не ответил, но команда могла выполниться\n` +
              `<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
            
            sendTelegramNotification(message).catch(err => {
              console.error('Ошибка отправки уведомления об изменении GPIO:', err);
            });
          }
          
          return res.json({
            success: true, // Считаем успехом, так как команда могла выполниться
            message: 'Команда отправлена через TCP (SMS-формат)',
            method: 'tcp',
            mode: connectionMode,
            command: atCommand,
            note: 'Модем не ответил, но команда могла выполниться. Проверьте состояние GPIO.'
          });
        }
        throw error; // Пробрасываем другие ошибки
      }
    } catch (error) {
      console.error(`❌ Ошибка отправки GPIO-команды через TCP: ${error.message}`);
      
      // Для других ошибок продолжаем с SMS как резервным вариантом
    }
  }
  
  // Если TCP не доступен, возвращаем сохраненные состояния из parsedData (если есть)
  if (modem.parsedData && modem.parsedData.gpio) {
    for (const [key, value] of Object.entries(modem.parsedData.gpio)) {
      const gpioNum = parseInt(key.replace('gpio', ''));
      if (!isNaN(gpioNum) && value && value.value !== undefined) {
        gpioStates[gpioNum] = {
          value: value.value,
          type: value.type || 'unknown',
          time: value.time || new Date().toISOString()
        };
      }
    }
  }
  
  // Если есть хотя бы одно состояние, возвращаем успех
  if (Object.keys(gpioStates).length > 0) {
    return res.json({
      success: true,
      method: 'parsed',
      note: 'Состояния GPIO из сохраненных данных (модем не подключен через TCP)',
      gpios: gpioStates
    });
  }
  
  // Если данных нет, возвращаем сообщение
  return res.json({
    success: false,
    method: 'parsed',
    error: 'Данные о состояниях GPIO отсутствуют',
    note: 'Модем не отправлял данные о GPIO или еще не подключен. Настройте модем на автоматическую отправку данных (GPIO_SEND<X>=1)',
    gpios: {}
  });
});

// API: Получить состояние GPIO (входов и выходов)
app.get('/api/modems/:phoneNumber/gpio', async (req, res) => {
  const { phoneNumber } = req.params;
  const { gpioNumber } = req.query; // Опционально: конкретный GPIO

  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  const gpioStates = {}; // Объявляем один раз в начале функции
  
  // Пытаемся получить состояние через TCP
  let modemSocket = null;
  let connectionMode = 'sms';
  
  // Проверяем режим работы модема
  if (modem.settings && modem.settings.mode === 'server') {
    try {
      modemSocket = await connectToModemServer(phoneNumber, modem);
      connectionMode = 'server';
    } catch (error) {
      console.log(`⚠️  Не удалось подключиться к модему ${phoneNumber} в режиме Сервер для чтения GPIO`);
    }
  } else {
    for (const [address, conn] of modemConnections.entries()) {
      if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
        modemSocket = conn.socket;
        connectionMode = 'client';
        break;
      }
    }
    
    if (!modemSocket && modem.status === 'online' && modemConnections.size > 0) {
      const [address, conn] = modemConnections.entries().next().value;
      if (conn.socket && !conn.socket.destroyed) {
        modemSocket = conn.socket;
        connectionMode = 'client';
        if (!conn.modem) {
          conn.modem = modem;
        }
      }
    }
  }

  // Если есть TCP-соединение, запрашиваем состояние через AT-команды
  if (modemSocket && !modemSocket.destroyed && modemSocket.writable) {
    try {
      // Если указан конкретный GPIO, запрашиваем только его
      const gpiosToCheck = gpioNumber ? [parseInt(gpioNumber)] : [1, 2, 3, 4, 5, 6, 7, 8];
      
      // Инициализируем parsedData.gpio, если его нет
      if (!modem.parsedData) {
        modem.parsedData = {};
      }
      if (!modem.parsedData.gpio) {
        modem.parsedData.gpio = {};
      }
      
      // Пытаемся запросить состояния через AT-команды (но не критично, если не работает)
      let commandsWorked = false;
      for (const gpio of gpiosToCheck) {
        try {
          // Запрашиваем настройки GPIO (направление и состояние) - для входов
          const setCommand = `AT$GPIO_SET${gpio}?`;
          const setResponse = await sendATCommandViaTCP(modemSocket, setCommand, phoneNumber);
          
          if (setResponse && setResponse.success) {
            commandsWorked = true;
            // Парсим ответ на GPIO_SET - формат: ^GPIO_SET<X>:<направление>,<значение> или ^GPIO_SET<X>:<значение>
            const setMatch = setResponse.response.match(/\^GPIO_SET(\d+):\s*(\d+)(?:,(\d+))?/i);
            if (setMatch) {
              const gpioNum = parseInt(setMatch[1]);
              // Если есть два значения (направление, значение), второе - это значение GPIO
              // Если только одно значение, это может быть либо направление, либо значение
              // Обычно формат: ^GPIO_SET<X>:<направление>,<значение>, где направление 0=вход, 1=выход
              const gpioVal = setMatch[3] !== undefined ? parseInt(setMatch[3]) : parseInt(setMatch[2]);
              
              const gpioKey = `gpio${gpioNum}`;
              modem.parsedData.gpio[gpioKey] = {
                value: gpioVal,
                type: 'input',
                time: new Date().toISOString()
              };
              
              console.log(`📱 Получено состояние GPIO${gpioNum} (вход) через AT-команду: ${gpioVal}`);
            } else {
              // Логируем, если формат ответа не распознан
              console.log(`⚠️ Не удалось распарсить ответ GPIO_SET${gpio}: ${setResponse.response.substring(0, 200)}`);
            }
          }
          
          // Небольшая задержка между командами
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Запрашиваем состояние выхода (если это выход)
          const outCommand = `AT$GPIO_OUT${gpio}?`;
          const outResponse = await sendATCommandViaTCP(modemSocket, outCommand, phoneNumber);
          
          if (outResponse && outResponse.success) {
            commandsWorked = true;
            // Парсим ответ на GPIO_OUT - формат: ^GPIO_OUT<X>:<значение>
            const outMatch = outResponse.response.match(/\^GPIO_OUT(\d+):\s*(\d+)/i);
            if (outMatch) {
              const gpioNum = parseInt(outMatch[1]);
              const gpioVal = parseInt(outMatch[2]);
              
              const gpioKey = `gpio${gpioNum}`;
              // Для выходов обновляем значение, если оно еще не было установлено через GPIO_SET
              // или если это выход (GPIO_OUT имеет приоритет для выходов)
              if (!modem.parsedData.gpio[gpioKey] || gpioNum === 4) {
                modem.parsedData.gpio[gpioKey] = {
                  value: gpioVal,
                  type: gpioNum === 4 ? 'gpo4' : 'output',
                  time: new Date().toISOString()
                };
                
                console.log(`📱 Получено состояние GPIO${gpioNum} (выход) через AT-команду: ${gpioVal}`);
              }
            } else {
              // Логируем, если формат ответа не распознан
              console.log(`⚠️ Не удалось распарсить ответ GPIO_OUT${gpio}: ${outResponse.response.substring(0, 200)}`);
            }
          }
          
          // Небольшая задержка между GPIO
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err) {
          // Таймауты и ошибки не критичны - просто логируем и продолжаем
          if (err.message.includes('Таймаут')) {
            console.log(`⏱️ Таймаут при запросе GPIO${gpio} (это нормально, если модем не поддерживает эти команды)`);
          } else {
            console.error(`Ошибка запроса состояния GPIO${gpio}:`, err.message);
          }
        }
      }
      
      // Если команды не сработали, сообщаем об этом
      if (!commandsWorked) {
        console.log(`ℹ️ AT-команды для запроса GPIO не сработали, используем сохраненные данные (если есть)`);
      }
      
      // Собираем все сохраненные состояния GPIO (из parsedData или из ответов на команды)
      if (modem.parsedData && modem.parsedData.gpio) {
        for (const [key, value] of Object.entries(modem.parsedData.gpio)) {
          const gpioNum = parseInt(key.replace('gpio', ''));
          if (!isNaN(gpioNum) && value && value.value !== undefined) {
            gpioStates[gpioNum] = {
              value: value.value,
              type: value.type,
              time: value.time
            };
          }
        }
      }
      
      // Если есть хотя бы одно состояние, возвращаем успех
      if (Object.keys(gpioStates).length > 0) {
        return res.json({
          success: true,
          method: commandsWorked ? 'tcp' : 'parsed',
          mode: connectionMode,
          note: commandsWorked 
            ? 'Состояние GPIO запрошено через TCP' 
            : 'Состояния GPIO из сохраненных данных (AT-команды не сработали, но есть данные от модема)',
          gpios: gpioStates
        });
      }
      
      // Если данных нет, возвращаем сообщение с подсказкой
      return res.json({
        success: false,
        method: 'tcp',
        mode: connectionMode,
        error: 'Данные о состояниях GPIO отсутствуют',
        note: 'Модем не отвечает на AT-команды и не отправлял данные о GPIO. Настройте модем на автоматическую отправку данных (GPIO_SEND<X>=1)',
        gpios: {}
      });
    } catch (error) {
      console.error(`❌ Ошибка чтения GPIO через TCP: ${error.message}`);
    }
  }

  // Если TCP не работает, возвращаем информацию о необходимости SMS
  return res.json({
    success: false,
    method: 'sms',
    error: 'Модем не подключен через TCP. Для чтения состояния GPIO используйте SMS-команды или убедитесь, что модем подключен.',
    hint: 'Отправьте SMS на модем: <пароль> gpio<номер>? для запроса состояния'
  });
});

// API: Настройка режима работы модема (Клиент/Сервер)
app.post('/api/modems/:phoneNumber/mode', async (req, res) => {
  const { phoneNumber } = req.params;
  const { mode, port, ipAddress, modemIP, connectionNumber = 1 } = req.body;

  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  const commands = [];

  if (mode === 'server') {
    // Настройка режима "Сервер"
    if (!port) {
      return res.status(400).json({ error: 'Для режима Сервер необходимо указать порт' });
    }
    
    // Предупреждаем, если IP модема не указан
    if (!modemIP && !modem.lastKnownIP && !modem.connectionAddress) {
      console.log(`⚠️  ВНИМАНИЕ: IP модема ${phoneNumber} не указан!`);
      console.log(`   После настройки режима Сервер нужно будет указать IP модема вручную,`);
      console.log(`   или сначала настроить модем в режиме Клиент, чтобы узнать его IP.`);
    }
    
    commands.push(formatSMSCommand(modem.password, 0, `SRV_RCCNT=1`));
    commands.push(formatSMSCommand(modem.password, 1, `SRV_PORT=${port}`));
    
    console.log(`\n✅ Для режима "Сервер" отправляются 2 команды:`);
    console.log(`   1. ${commands[0]} - включает режим сервер (не применяет)`);
    console.log(`   2. ${commands[1]} - устанавливает порт ${port} (ПРИМЕНЯЕТ и перезагружает модем)`);
    console.log(`   ⚠️  ВАЖНО: После применения модем перезагрузится и запустит сервер на порту ${port}`);
    console.log(`   ⚠️  ВАЖНО: Убедитесь, что указан IP-адрес модема для подключения к нему!\n`);
  } else if (mode === 'client') {
    // Настройка режима "Клиент"
    if (ipAddress && port) {
      // ВАЖНО: Для работы AT-команд через TCP нужен протокол iRZ Collector с инкапсуляцией!
      // Настройка выполняется в 3 команды:
      // 1. CLNT_SET - включить режим клиент с инкапсуляцией (параметр 0 - не применять)
      // 2. CLNT_PRTCL - установить протокол iRZ Collector (параметр 0 - не применять)
      // 3. CLNT_IPP - указать IP и порт (параметр 1 - применить все и перезагрузить)
      
      commands.push(formatSMSCommand(modem.password, 0, `CLNT_SET${connectionNumber}=1,0,0,1`)); // Включить клиент с инкапсуляцией
      commands.push(formatSMSCommand(modem.password, 0, `CLNT_PRTCL${connectionNumber}=1`)); // Протокол iRZ Collector
      commands.push(formatSMSCommand(modem.password, 1, `CLNT_IPP${connectionNumber}=${ipAddress},${port}`)); // IP и порт (применить все)
      
      console.log(`\n✅ Для режима "Клиент" с поддержкой AT-команд отправляются 3 команды:`);
      console.log(`   1. ${commands[0]} - включает режим клиент с инкапсуляцией (не применяет)`);
      console.log(`   2. ${commands[1]} - устанавливает протокол iRZ Collector (не применяет)`);
      console.log(`   3. ${commands[2]} - указывает IP и порт (ПРИМЕНЯЕТ все настройки и перезагружает)`);
      console.log(`   Отправляйте команды ПО ПОРЯДКУ с задержкой 5-10 секунд между ними!`);
      console.log(`   После применения модем будет поддерживать AT-команды через TCP.\n`);
    }
  }

  // Сохраняем настройки в объект модема
  if (!modems[phoneNumber].settings) {
    modems[phoneNumber].settings = {};
  }
  modems[phoneNumber].settings.mode = mode;
  modems[phoneNumber].settings.port = port;
  if (mode === 'client') {
    modems[phoneNumber].settings.ipAddress = ipAddress;
    modems[phoneNumber].settings.connectionNumber = connectionNumber;
  } else if (mode === 'server') {
    // Сохраняем IP модема для подключения к нему
    if (modemIP) {
      modems[phoneNumber].lastKnownIP = modemIP;
      console.log(`💾 Сохранен IP модема ${phoneNumber} для режима Сервер: ${modemIP}`);
    }
    modems[phoneNumber].settings.modemIP = modemIP; // Сохраняем в настройках тоже
  }
  modems[phoneNumber].lastUpdate = new Date().toISOString();
  saveModems();

  // Отправляем команды
  console.log(`\n🔧 Настройка модема ${phoneNumber} (режим: ${mode})`);
  for (let i = 0; i < commands.length; i++) {
    console.log(`   Команда ${i + 1}/${commands.length}: ${commands[i]}`);
    await sendSMSCommand(phoneNumber, commands[i]);
    // Задержка между командами: 5-10 секунд для последней команды (которая применяет настройки)
    const delay = (i === commands.length - 1) ? 10000 : 5000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  console.log(`✅ Все команды отправлены для модема ${phoneNumber}\n`);
  
  // Если режим Сервер, пытаемся подключиться через 15 секунд (после перезагрузки модема)
  if (mode === 'server' && modemIP) {
    console.log(`⏳ Через 15 секунд попытаемся подключиться к модему ${phoneNumber} в режиме Сервер...`);
    setTimeout(() => {
      connectToModemServer(phoneNumber, modems[phoneNumber]).then(socket => {
        if (socket) {
          console.log(`✅ Автоматическое подключение к модему ${phoneNumber} в режиме Сервер успешно!`);
        }
      }).catch(err => {
        console.log(`⚠️  Автоматическое подключение не удалось: ${err.message}`);
        console.log(`   Попробуйте подключиться вручную через интерфейс или проверьте настройки модема`);
      });
    }, 15000);
  }

  res.json({ 
    success: true, 
    message: 'Настройки применены и сохранены', 
    commands: commands,
    note: mode === 'server' ? 
      `Модем перезагрузится после применения настроек. Убедитесь, что указан IP-адрес модема для подключения.` :
      null
  });
});

// API: Управление ждущим режимом
app.post('/api/modems/:phoneNumber/wait', async (req, res) => {
  const { phoneNumber } = req.params;
  const { action, connectionNumber } = req.body; // action: 'on' или 'off'

  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  let command;

  if (connectionNumber) {
    command = `${modem.password} wait ${action}${connectionNumber}`;
  } else {
    command = `${modem.password} wait ${action}`;
  }

  const result = await sendSMSCommand(phoneNumber, command);
  res.json(result);
});

// API: Настройка интерфейсов (RS485/RS232)
app.post('/api/modems/:phoneNumber/interface', async (req, res) => {
  const { phoneNumber } = req.params;
  const { interface, baudRate, dataBits, stopBits, parity } = req.body;

  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  
  // PORT_SET: X=0 (RS485) или 1 (RS232), параметры: скорость, биты данных, стоп-биты, четность, управление потоком
  const interfaceNum = interface === 'RS485' ? 0 : 1;
  const baudRateMap = {
    600: 1, 1200: 2, 2400: 3, 4800: 4, 9600: 5,
    14400: 6, 19200: 7, 28800: 8, 38400: 9, 56000: 10, 57600: 11, 115200: 12
  };
  const dataBitsMap = { 7: 0, 8: 1 };
  const stopBitsMap = { 1: 0, 1.5: 1, 2: 2 };
  const parityMap = { none: 0, even: 1, odd: 2 };

  const command = formatSMSCommand(
    modem.password,
    1,
    `PORT_SET${interfaceNum}=${baudRateMap[baudRate] || 5},${dataBitsMap[dataBits] || 1},${stopBitsMap[stopBits] || 0},${parityMap[parity] || 0},0`
  );

  // Сохраняем настройки интерфейса в объект модема
  if (!modems[phoneNumber].settings) {
    modems[phoneNumber].settings = {};
  }
  modems[phoneNumber].settings.interface = {
    type: interface,
    baudRate,
    dataBits,
    stopBits,
    parity
  };
  modems[phoneNumber].lastUpdate = new Date().toISOString();
  saveModems();

  const result = await sendSMSCommand(phoneNumber, command);
  // Добавляем команду в ответ, чтобы показать её в интерфейсе
  res.json({ ...result, command: command });
});

// API: Получить статус модема
app.get('/api/modems/:phoneNumber/status', (req, res) => {
  const { phoneNumber } = req.params;
  
  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  res.json({ 
    modem: modem,
    parsedData: modem.parsedData || null
  });
});

// API: Получить данные модема (извлеченные из автоматических сообщений)
app.get('/api/modems/:phoneNumber/parsed-data', (req, res) => {
  const { phoneNumber } = req.params;
  
  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  res.json({ 
    success: true,
    data: modem.parsedData || {},
    note: 'Данные извлечены из автоматических сообщений модема. Для получения данных через AT-команды нужен протокол iRZ Collector с инкапсуляцией.'
  });
});

// API: Получить настройки модема
app.get('/api/modems/:phoneNumber/settings', (req, res) => {
  const { phoneNumber } = req.params;
  
  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  res.json({ settings: modems[phoneNumber].settings || {} });
});

// API: Запросить текущие настройки модема через AT-команды
app.post('/api/modems/:phoneNumber/query-settings', async (req, res) => {
  const { phoneNumber } = req.params;
  const { connectionNumber = 1 } = req.body;
  
  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  // Ищем активное TCP соединение
  let modemSocket = null;
  for (const [address, conn] of modemConnections.entries()) {
    if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
      modemSocket = conn.socket;
      break;
    }
  }
  
  if (!modemSocket && modems[phoneNumber].status === 'online' && modemConnections.size > 0) {
    const [address, conn] = modemConnections.entries().next().value;
    if (conn.socket && !conn.socket.destroyed) {
      modemSocket = conn.socket;
      if (!conn.modem) {
        conn.modem = modems[phoneNumber];
      }
    }
  }

  if (!modemSocket) {
    return res.status(503).json({ 
      success: false, 
      error: 'Модем не подключен к серверу' 
    });
  }

  const results = {};
  
  try {
    // Запрашиваем настройки CLNT_SET
    const clntSetCommand = `AT$CLNT_SET${connectionNumber}?`;
    modemSocket.write(clntSetCommand + '\r\n');
    console.log(`📤 Запрос настроек CLNT_SET: ${clntSetCommand}`);
    
    // Ждем ответ (упрощенная версия, без полной обработки очереди)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Запрашиваем настройки CLNT_IPP
    const clntIppCommand = `AT$CLNT_IPP${connectionNumber}?`;
    modemSocket.write(clntIppCommand + '\r\n');
    console.log(`📤 Запрос настроек CLNT_IPP: ${clntIppCommand}`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    res.json({ 
      success: true, 
      message: 'Команды запроса отправлены. Проверьте логи модема для ответов.',
      note: 'Для получения ответов модем должен поддерживать режим инкапсуляции'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API: Настройка SMS-шлюза
app.post('/api/config/sms', (req, res) => {
  const { enabled, apiUrl, apiKey, useGSMModem, gsmModemPort } = req.body;
  
  SMS_CONFIG.enabled = enabled || false;
  SMS_CONFIG.apiUrl = apiUrl || '';
  SMS_CONFIG.apiKey = apiKey || '';
  SMS_CONFIG.useGSMModem = useGSMModem || false;
  SMS_CONFIG.gsmModemPort = gsmModemPort || '';
  
  saveSMSConfig();
  res.json({ success: true, config: SMS_CONFIG });
});

// API: Получить конфигурацию SMS
app.get('/api/config/sms', (req, res) => {
  res.json({ config: SMS_CONFIG });
});

// API: Настройка Telegram уведомлений
app.post('/api/config/telegram', (req, res) => {
  const { enabled, botToken, chatIds, notifications } = req.body;
  
  console.log('📝 Сохранение конфигурации Telegram:');
  console.log(`   enabled: ${enabled}`);
  console.log(`   botToken: ${botToken ? botToken.substring(0, 10) + '...' : 'не указан'}`);
  console.log(`   chatIds: ${JSON.stringify(chatIds)}`);
  
  TELEGRAM_CONFIG.enabled = enabled || false;
  if (botToken) TELEGRAM_CONFIG.botToken = botToken.trim();
  
  // Обрабатываем Chat IDs
  if (chatIds !== undefined) {
    if (Array.isArray(chatIds) && chatIds.length > 0) {
      // Убеждаемся, что Chat ID в правильном формате
      // Telegram API принимает числа для личных чатов, строки для групп/каналов
      TELEGRAM_CONFIG.chatIds = chatIds.map(id => {
        // Если это уже число - оставляем
        if (typeof id === 'number') return id;
        // Если это строка, но можно преобразовать в число - преобразуем
        if (typeof id === 'string' && !isNaN(id) && id.trim() !== '') {
          const numId = parseInt(id.trim());
          // Проверяем, что это валидное число (не NaN)
          if (!isNaN(numId)) return numId;
        }
        // Иначе оставляем как строку (для групп/каналов)
        return id;
      }).filter(id => id !== null && id !== undefined && id !== ''); // Убираем пустые значения
    } else {
      // Если передан пустой массив или не массив - очищаем
      TELEGRAM_CONFIG.chatIds = [];
    }
  }
  if (notifications) {
    TELEGRAM_CONFIG.notifications = { ...TELEGRAM_CONFIG.notifications, ...notifications };
  }
  
  console.log(`   Сохранено: enabled=${TELEGRAM_CONFIG.enabled}, chatIds=${JSON.stringify(TELEGRAM_CONFIG.chatIds)}`);
  
  saveTelegramConfig();
  res.json({ success: true, config: TELEGRAM_CONFIG });
});

// API: Получить конфигурацию Telegram
app.get('/api/config/telegram', (req, res) => {
  res.json({ config: TELEGRAM_CONFIG });
});

// API: Тестовая отправка Telegram
app.post('/api/config/telegram/test', async (req, res) => {
  // Проверяем, что Telegram настроен
  if (!TELEGRAM_CONFIG.enabled) {
    return res.status(400).json({ 
      success: false, 
      error: 'Telegram уведомления отключены. Включите их в настройках.' 
    });
  }

  // Проверяем обязательные поля
  if (!TELEGRAM_CONFIG.botToken) {
    return res.status(400).json({ 
      success: false, 
      error: 'Не указан токен бота Telegram' 
    });
  }

  // Проверяем, что есть получатели
  if (!TELEGRAM_CONFIG.chatIds || TELEGRAM_CONFIG.chatIds.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Не указаны Chat ID получателей. Добавьте хотя бы один Chat ID.' 
    });
  }

  try {
    console.log('📱 Отправка тестового сообщения в Telegram...');
    console.log(`   enabled: ${TELEGRAM_CONFIG.enabled}`);
    console.log(`   botToken: ${TELEGRAM_CONFIG.botToken ? TELEGRAM_CONFIG.botToken.substring(0, 10) + '...' : 'НЕ УСТАНОВЛЕН'}`);
    console.log(`   chatIds: ${JSON.stringify(TELEGRAM_CONFIG.chatIds)}`);
    console.log(`   chatIds.length: ${TELEGRAM_CONFIG.chatIds ? TELEGRAM_CONFIG.chatIds.length : 0}`);
    console.log(`   chatIds type: ${Array.isArray(TELEGRAM_CONFIG.chatIds) ? 'array' : typeof TELEGRAM_CONFIG.chatIds}`);
    
    const message = '<b>✅ Тестовое уведомление</b>\n\nЭто тестовое Telegram уведомление от системы управления модемами IRZ.\n\nЕсли вы получили это сообщение, значит настройки Telegram работают корректно!';
    const result = await sendTelegramNotification(message);
    
    if (result.success) {
      console.log(`✅ Тестовое сообщение успешно отправлено в ${result.sent} из ${result.total} чатов`);
      res.json(result);
    } else {
      console.error('❌ Ошибка отправки тестового сообщения:', result.error || result.message);
      if (result.results && result.results.length > 0) {
        console.error('   Детали ошибок:', JSON.stringify(result.results, null, 2));
      }
      res.status(400).json({ 
        success: false, 
        error: result.error || result.message || 'Не удалось отправить сообщение',
        results: result.results || []
      });
    }
  } catch (error) {
    console.error('❌ Критическая ошибка при отправке тестового сообщения:', error);
    console.error('   Стек ошибки:', error.stack);
    
    let errorMsg = error.message || 'Неизвестная ошибка при отправке сообщения';
    
    res.status(500).json({ 
      success: false, 
      error: errorMsg,
      code: error.code,
      details: error.response?.data || null
    });
  }
});

// API: Принудительная проверка подключения к модему в режиме Сервер
app.post('/api/modems/:phoneNumber/force-connect', async (req, res) => {
  const { phoneNumber } = req.params;
  
  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  
  if (!modem.settings || modem.settings.mode !== 'server') {
    return res.status(400).json({ error: 'Модем не в режиме Сервер' });
  }

  console.log(`🔍 Принудительная попытка подключения к модему ${phoneNumber}...`);
  
  try {
    const socket = await Promise.race([
      connectToModemServer(phoneNumber, modem),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Таймаут подключения (10 секунд)')), 10000))
    ]);
    
    if (socket) {
      return res.json({
        success: true,
        message: `Успешно подключен к модему ${phoneNumber}`,
        address: `${modem.settings.modemIP || modem.lastKnownIP}:${modem.settings.port}`
      });
    } else {
      return res.status(503).json({
        success: false,
        error: 'Не удалось подключиться к модему'
      });
    }
  } catch (err) {
    const errorCode = err.code || '';
    let errorMessage = err.message;
    let hint = '';
    
    if (errorCode === 'ECONNREFUSED') {
      errorMessage = 'Модем не принимает подключения';
      hint = 'Проверьте, что модем перезагрузился после настройки и запустил сервер на указанном порту';
    } else if (errorCode === 'ETIMEDOUT') {
      errorMessage = 'Таймаут подключения';
      hint = 'Проверьте IP-адрес модема и доступность по сети';
    } else if (errorCode === 'ENOTFOUND') {
      errorMessage = 'Не удалось найти модем по указанному IP';
      hint = 'Проверьте правильность IP-адреса';
    }
    
    return res.status(503).json({
      success: false,
      error: errorMessage,
      hint: hint,
      code: errorCode,
      diagnostic: {
        modemIP: modem.settings.modemIP || modem.lastKnownIP || 'не указан',
        port: modem.settings.port,
        lastKnownIP: modem.lastKnownIP
      }
    });
  }
});

// API: Проверить статус подключения модема
app.get('/api/modems/:phoneNumber/connection-status', async (req, res) => {
  const { phoneNumber } = req.params;
  
  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  
  // Ищем активное TCP соединение для этого модема (режим Клиент)
  let connectionInfo = null;
  for (const [address, conn] of modemConnections.entries()) {
    if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
      connectionInfo = {
        address,
        connectedAt: conn.connectedAt,
        isConnected: conn.socket && !conn.socket.destroyed,
        mode: 'client'
      };
      break;
    }
  }
  
  // Проверяем подключение в режиме Сервер
  if (!connectionInfo && modem.settings && modem.settings.mode === 'server') {
    if (serverModeConnections.has(phoneNumber)) {
      const socket = serverModeConnections.get(phoneNumber);
      if (socket && !socket.destroyed && socket.writable) {
        connectionInfo = {
          address: `${modem.settings.modemIP || modem.lastKnownIP || 'неизвестен'}:${modem.settings.port}`,
          connectedAt: 'активное',
          isConnected: true,
          mode: 'server'
        };
      } else {
        serverModeConnections.delete(phoneNumber);
      }
    }
    
    // Если нет активного подключения, пытаемся подключиться синхронно (с таймаутом)
    if (!connectionInfo) {
      try {
        console.log(`🔍 Принудительная проверка подключения к модему ${phoneNumber} в режиме Сервер...`);
        const socket = await Promise.race([
          connectToModemServer(phoneNumber, modem),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Таймаут проверки подключения')), 5000))
        ]);
        
        if (socket) {
          connectionInfo = {
            address: `${modem.settings.modemIP || modem.lastKnownIP || 'неизвестен'}:${modem.settings.port}`,
            connectedAt: new Date().toISOString(),
            isConnected: true,
            mode: 'server'
          };
          modem.status = 'online';
          modem.lastConnection = new Date().toISOString();
          saveModems();
        }
      } catch (err) {
        console.log(`⚠️  Не удалось подключиться к модему ${phoneNumber} при проверке: ${err.message}`);
        // Не возвращаем ошибку, просто connectionInfo останется null
      }
    }
  }
  
  // Если не нашли точное совпадение, но есть активные соединения и только один модем,
  // или статус модема показывает "online", считаем что подключен
  if (!connectionInfo && modem.status === 'online' && modemConnections.size > 0) {
    // Берем первое доступное соединение
    const [address, conn] = modemConnections.entries().next().value;
    connectionInfo = {
      address,
      connectedAt: conn.connectedAt,
      isConnected: conn.socket && !conn.socket.destroyed,
      note: 'Соединение найдено по статусу модема',
      mode: 'client'
    };
    
    // Связываем это соединение с модемом, если еще не связано
    if (!conn.modem) {
      conn.modem = modem;
      console.log(`🔗 Связал соединение ${address} с модемом ${phoneNumber}`);
    }
  }

  // Проверяем все активные соединения
  const allConnections = Array.from(modemConnections.entries()).map(([address, conn]) => ({
    address,
    modemPhone: conn.modem ? conn.modem.phoneNumber : 'неизвестен',
    modemName: conn.modem ? conn.modem.name : 'неизвестен',
    connectedAt: conn.connectedAt,
    isConnected: conn.socket && !conn.socket.destroyed
  }));

  // Добавляем информацию о настройках для диагностики
  const diagnosticInfo = {
    modemMode: modem.settings?.mode || 'не настроен',
    modemPort: modem.settings?.port || 'не указан',
    modemIP: modem.settings?.modemIP || modem.lastKnownIP || 'не указан',
    serverModeConnections: Array.from(serverModeConnections.keys())
  };

  res.json({
    isConnected: connectionInfo !== null,
    connectionInfo,
    allConnections,
    totalConnections: modemConnections.size,
    modemStatus: modem.status,
    modemLastConnection: modem.lastConnection,
    diagnostic: diagnosticInfo
  });
});

// Хранилище активных подключений к модемам в режиме "Сервер"
const serverModeConnections = new Map(); // phoneNumber -> socket
const serverModeReconnectTimers = new Map(); // phoneNumber -> timer (для автоматического переподключения)

// Функция подключения к модему в режиме "Сервер"
async function connectToModemServer(phoneNumber, modem) {
  // Проверяем настройки модема
  if (!modem.settings || modem.settings.mode !== 'server' || !modem.settings.port) {
    console.log(`⚠️  Модем ${phoneNumber} не настроен в режиме Сервер или порт не указан`);
    return null;
  }

  // Если уже есть подключение, возвращаем его
  if (serverModeConnections.has(phoneNumber)) {
    const existingSocket = serverModeConnections.get(phoneNumber);
    if (existingSocket && !existingSocket.destroyed && existingSocket.writable) {
      console.log(`✅ Используем существующее подключение к модему ${phoneNumber} в режиме Сервер`);
      return existingSocket;
    } else {
      serverModeConnections.delete(phoneNumber);
    }
  }

  // Получаем IP модема в следующем приоритете:
  // 1. Из настроек (пользователь указал вручную)
  // 2. Из активных подключений (если модем подключался как клиент)
  // 3. Из сохраненного адреса подключения
  // 4. Из последнего известного IP
  let modemIP = null;
  
  // Приоритет 1: IP из настроек (пользователь указал вручную)
  if (modem.settings && modem.settings.modemIP) {
    modemIP = modem.settings.modemIP;
    console.log(`📱 Используем IP модема ${phoneNumber} из настроек: ${modemIP}`);
  }
  
  // Приоритет 2: IP из активных подключений
  if (!modemIP) {
    for (const [address, conn] of modemConnections.entries()) {
      if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
        const ip = address.split(':')[0];
        modemIP = ip;
        console.log(`📱 Найден IP модема ${phoneNumber} из активного подключения: ${ip}`);
        break;
      }
    }
  }

  // Приоритет 3: Сохраненный адрес подключения
  if (!modemIP && modem.connectionAddress) {
    modemIP = modem.connectionAddress.split(':')[0];
    console.log(`📱 Используем сохраненный адрес подключения модема ${phoneNumber}: ${modemIP}`);
  }

  // Приоритет 4: Последний известный IP
  if (!modemIP && modem.lastKnownIP) {
    modemIP = modem.lastKnownIP;
    console.log(`📱 Используем последний известный IP модема ${phoneNumber}: ${modemIP}`);
  }

  if (!modemIP) {
    console.log(`⚠️  Не могу определить IP модема ${phoneNumber} для подключения в режиме Сервер`);
    console.log(`   Подсказка: Для работы в режиме Сервер нужно знать IP модема.`);
    console.log(`   Варианты решения:`);
    console.log(`   1. Укажите IP модема вручную в настройках (поле "IP-адрес модема")`);
    console.log(`   2. Настройте модем в режиме "Клиент" хотя бы раз - мы узнаем его IP автоматически`);
    console.log(`   3. Используйте режим "Клиент" - модем сам подключится к серверу`);
    return null;
  }
  
  // Проверяем, что IP валидный
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(modemIP)) {
    console.error(`❌ Неверный формат IP-адреса модема ${phoneNumber}: ${modemIP}`);
    return null;
  }

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const port = modem.settings.port;
    
    console.log(`🔌 Попытка подключения к модему ${phoneNumber} в режиме Сервер: ${modemIP}:${port}`);
    
    socket.setTimeout(10000); // Увеличил таймаут до 10 секунд
    
    // Обработка данных от модема (для ответов на AT-команды)
    let responseBuffer = '';
    socket.on('data', (data) => {
      const dataStr = data.toString();
      responseBuffer += dataStr;
      console.log(`📨 Данные от модема ${phoneNumber} (режим Сервер):`, JSON.stringify(dataStr));
      
      // Проверяем, есть ли ожидающие команды
      const pending = pendingCommands.get(socket);
      if (pending) {
        pending.responseBuffer += dataStr;
        pending.dataCount = (pending.dataCount || 0) + 1;
        
        const response = pending.responseBuffer;
        const hasOK = response.includes('OK');
        const hasERROR = response.includes('ERROR') || response.includes('ACCESS ERROR');
        const hasResponse = response.match(/\^[A-Z_]+\s*:/) || response.match(/\+[A-Z]+:/);
        
        if (hasOK || hasERROR) {
          console.log(`✅ Получен ответ от модема ${phoneNumber} (режим Сервер):`, response.substring(0, 200));
          clearTimeout(pending.timeout);
          pendingCommands.delete(socket);
          pending.resolve(response.trim());
        } else if (hasResponse && pending.dataCount >= 2) {
          setTimeout(() => {
            if (pendingCommands.has(socket)) {
              const finalResponse = pending.responseBuffer;
              console.log(`⚠️ Ответ без OK от модема ${phoneNumber}, считаем завершенным:`, finalResponse.substring(0, 200));
              clearTimeout(pending.timeout);
              pendingCommands.delete(socket);
              pending.resolve(finalResponse.trim());
            }
          }, 500);
        }
      }
    });
    
    socket.on('connect', () => {
      console.log(`✅ УСПЕШНО подключился к модему ${phoneNumber} в режиме Сервер (${modemIP}:${port})`);
      
      // Настраиваем сокет для поддержания соединения после подключения
      socket.setKeepAlive(true, 60000); // Проверка каждые 60 секунд
      // Отключаем таймаут закрытия соединения (0 = без таймаута)
      socket.setTimeout(0);
      
      // Обработка таймаута (если все же произойдет)
      socket.on('timeout', () => {
        console.log(`⚠️ Таймаут соединения с модемом ${phoneNumber}, но соединение остается открытым`);
        // Не закрываем соединение, просто сбрасываем таймаут
        socket.setTimeout(0);
      });
      
      serverModeConnections.set(phoneNumber, socket);
      // Обновляем статус модема сразу при подключении
      if (modem) {
        const previousStatus = modem.status;
        modem.status = 'online';
        modem.lastConnection = new Date().toISOString();
        saveModems();
        
        // Отправляем уведомление о подключении (режим Сервер)
        if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.modemConnected && previousStatus !== 'online') {
          const message = `<b>🔌 Модем подключен (Сервер)</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${phoneNumber}\n<b>IP:</b> ${modemIP}:${port}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
          sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления о подключении:', err));
        }
      }
      resolve(socket);
    });

    socket.on('error', (err) => {
      let errorMessage = err.message;
      let detailedMessage = `❌ Ошибка подключения к модему ${phoneNumber} (${modemIP}:${port}): ${errorMessage}`;
      
      // Детализируем ошибки
      if (err.code === 'ECONNREFUSED') {
        detailedMessage += `\n   💡 Модем не принимает подключения на порту ${port}. Проверьте:`;
        detailedMessage += `\n      - Модем настроен в режиме "Сервер" и порт ${port} указан правильно?`;
        detailedMessage += `\n      - Модем запустил сервер? (может потребоваться перезагрузка модема)`;
        detailedMessage += `\n      - Нет ли файрвола, блокирующего порт ${port}?`;
      } else if (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        detailedMessage += `\n   💡 Не удалось найти модем по адресу ${modemIP}. Проверьте:`;
        detailedMessage += `\n      - Правильно ли указан IP-адрес модема?`;
        detailedMessage += `\n      - Модем включен и подключен к интернету?`;
        detailedMessage += `\n      - IP-адрес модема не изменился? (модемы могут получать новый IP при переподключении)`;
      } else if (err.code === 'EHOSTUNREACH') {
        detailedMessage += `\n   💡 Маршрут к модему недоступен. Проверьте сетевые настройки.`;
      }
      
      console.error(detailedMessage);
      serverModeConnections.delete(phoneNumber);
      reject(new Error(errorMessage));
    });

    socket.on('timeout', () => {
      const errorMsg = `Таймаут подключения к ${modemIP}:${port} (10 секунд)`;
      console.error(`❌ ${errorMsg}`);
      console.error(`   💡 Возможные причины:`);
      console.error(`      - Модем не запустил сервер на порту ${port}`);
      console.error(`      - Файрвол блокирует подключение`);
      console.error(`      - Неверный IP-адрес модема`);
      socket.destroy();
      serverModeConnections.delete(phoneNumber);
      reject(new Error(errorMsg));
    });

    socket.on('close', (hadError) => {
      const reason = hadError ? 'из-за ошибки' : 'нормально';
      console.log(`❌ Соединение с модемом ${phoneNumber} (режим Сервер) закрыто (${reason})`);
      console.log(`   💡 Информация о соединении:`);
      console.log(`      - Destroyed: ${socket.destroyed}`);
      console.log(`      - Readable: ${socket.readable}`);
      console.log(`      - Writable: ${socket.writable}`);
      serverModeConnections.delete(phoneNumber);
      
      // Очищаем ожидающие команды
      if (pendingCommands.has(socket)) {
        const pending = pendingCommands.get(socket);
        clearTimeout(pending.timeout);
        pending.reject(new Error('Соединение закрыто'));
        pendingCommands.delete(socket);
      }
      
      // Обновляем статус и отправляем уведомление
      if (modem) {
        const previousStatus = modem.status;
        modem.status = 'offline';
        modem.lastDisconnection = new Date().toISOString();
        saveModems();
        
        // Отправляем уведомление об отключении (режим Сервер)
        if (TELEGRAM_CONFIG.enabled && TELEGRAM_CONFIG.notifications.modemDisconnected && previousStatus === 'online') {
          const message = `<b>❌ Модем отключен (Сервер)</b>\n\n<b>Модем:</b> ${modem.name}\n<b>Номер:</b> ${phoneNumber}\n<b>IP:</b> ${modemIP}:${port}\n<b>Время:</b> ${new Date().toLocaleString('ru-RU')}`;
          sendTelegramNotification(message).catch(err => console.error('Ошибка отправки уведомления об отключении:', err));
        }
      }
      
      // Планируем автоматическое переподключение через 30 секунд
      // (только если модем все еще в режиме сервера)
      if (modem.settings && modem.settings.mode === 'server') {
        // Очищаем предыдущий таймер, если есть
        if (serverModeReconnectTimers.has(phoneNumber)) {
          clearTimeout(serverModeReconnectTimers.get(phoneNumber));
        }
        
        const reconnectTimer = setTimeout(() => {
          console.log(`🔄 Попытка автоматического переподключения к модему ${phoneNumber} в режиме Сервер...`);
          serverModeReconnectTimers.delete(phoneNumber);
          connectToModemServer(phoneNumber, modem).catch(err => {
            // Ошибка уже залогирована в connectToModemServer
          });
        }, 30000); // 30 секунд
        
        serverModeReconnectTimers.set(phoneNumber, reconnectTimer);
      }
    });

    // Подключаемся к модему
    socket.connect(port, modemIP);
  });
}

// API: Отправить AT-команду модему через TCP
app.post('/api/modems/:phoneNumber/at-command', async (req, res) => {
  const { phoneNumber } = req.params;
  const { command } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'Команда не указана' });
  }

  if (!modems[phoneNumber]) {
    return res.status(404).json({ error: 'Модем не найден' });
  }

  const modem = modems[phoneNumber];
  let modemSocket = null;
  let connectionAddress = null;
  let connectionMode = 'client'; // или 'server'

  // Проверяем режим работы модема
  if (modem.settings && modem.settings.mode === 'server') {
    // Режим "Сервер" - подключаемся к модему
    try {
      modemSocket = await connectToModemServer(phoneNumber, modem);
      connectionMode = 'server';
      connectionAddress = `server-mode:${modem.settings.port}`;
    } catch (error) {
      return res.status(503).json({ 
        success: false, 
        error: `Не удалось подключиться к модему в режиме Сервер: ${error.message}`,
        hint: 'Убедитесь, что модем настроен в режиме Сервер и доступен по сети'
      });
    }
  } else {
    // Режим "Клиент" - ищем активное TCP соединение от модема
    for (const [address, conn] of modemConnections.entries()) {
      if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
        modemSocket = conn.socket;
        connectionAddress = address;
        break;
      }
    }
    
    // Если не нашли точное совпадение, но модем показывает статус "online" и есть активные соединения
    if (!modemSocket && modem.status === 'online' && modemConnections.size > 0) {
      // Берем первое доступное соединение и связываем его с модемом
      const [address, conn] = modemConnections.entries().next().value;
      if (conn.socket && !conn.socket.destroyed) {
        modemSocket = conn.socket;
        connectionAddress = address;
        
        // Связываем соединение с модемом, если еще не связано
        if (!conn.modem) {
          conn.modem = modem;
          console.log(`🔗 Связал соединение ${address} с модемом ${phoneNumber} для отправки команды`);
        }
      }
    }
  }

  if (!modemSocket) {
    // Дополнительная диагностика
    const allConnections = Array.from(modemConnections.entries()).map(([address, conn]) => ({
      address,
      modemPhone: conn.modem ? conn.modem.phoneNumber : 'неизвестен',
      isConnected: conn.socket && !conn.socket.destroyed
    }));
    
    console.log(`❌ Модем ${phoneNumber} не подключен. Статус: ${modems[phoneNumber].status}, Активные соединения:`, allConnections);
    
    return res.status(503).json({ 
      success: false, 
      error: 'Модем не подключен к серверу. Убедитесь, что модем в режиме "Клиент" и подключен.',
      diagnostic: {
        requestedPhone: phoneNumber,
        modemStatus: modems[phoneNumber].status,
        activeConnections: allConnections,
        totalConnections: modemConnections.size
      }
    });
  }

  // Проверяем, нет ли уже ожидающей команды для этого сокета
  if (pendingCommands.has(modemSocket)) {
    return res.status(429).json({ 
      success: false, 
      error: 'Другая команда уже выполняется. Подождите немного.' 
    });
  }

  // Отправляем команду через TCP
  // Для некоторых модемов может потребоваться отправка команды с паролем
  // Но обычно через TCP команды отправляются без пароля (пароль нужен только для SMS)
  const commandWithNewline = command + '\r\n';
  
  // Проверяем, что сокет еще не закрыт
  if (modemSocket.destroyed || modemSocket.writable === false) {
    console.error(`❌ Сокет модема ${phoneNumber} закрыт или недоступен для записи`);
    return res.status(503).json({ 
      success: false, 
      error: 'Соединение с модемом закрыто',
      diagnostic: {
        socketDestroyed: modemSocket.destroyed,
        socketWritable: modemSocket.writable
      }
    });
  }
  
  try {
    modemSocket.write(commandWithNewline);
    console.log(`📤 AT-команда отправлена модему ${phoneNumber} (${connectionAddress}): ${command}`);
    console.log(`   Отправлено байт: ${commandWithNewline.length}, команда: ${JSON.stringify(commandWithNewline)}`);
  } catch (writeError) {
    console.error(`❌ Ошибка отправки команды модему ${phoneNumber}:`, writeError);
    return res.status(500).json({ 
      success: false, 
      error: 'Ошибка отправки команды: ' + writeError.message
    });
  }

  // Создаем Promise для ожидания ответа
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingCommands.has(modemSocket)) {
        const pending = pendingCommands.get(modemSocket);
        const partialResponse = pending.responseBuffer;
        pendingCommands.delete(modemSocket);
        
        // Если получили хоть какие-то данные, возвращаем их
        if (partialResponse && partialResponse.trim().length > 0) {
          console.log(`⚠️ Таймаут, но есть частичный ответ от модема ${phoneNumber}:`, partialResponse.substring(0, 200));
          resolve(partialResponse.trim());
        } else {
          console.log(`❌ Таймаут ожидания ответа от модема ${phoneNumber}, данных не получено`);
          reject(new Error('Таймаут ожидания ответа от модема (10 секунд). Модем не ответил на команду.'));
        }
      } else {
        reject(new Error('Таймаут ожидания ответа от модема (10 секунд)'));
      }
    }, 10000); // Увеличил таймаут до 10 секунд

    pendingCommands.set(modemSocket, {
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
      timeout,
      responseBuffer: '',
      dataCount: 0,
      command: command,
      sentAt: new Date().toISOString()
    });
    
    console.log(`⏳ Ожидание ответа на команду: ${command.substring(0, 50)}...`);
  });

  try {
    const response = await responsePromise;
    console.log(`📥 Ответ от модема ${phoneNumber}: ${response.substring(0, 200)}`);
    
    res.json({ 
      success: !response.includes('ERROR') && !response.includes('ACCESS ERROR'), 
      response: response
    });
  } catch (error) {
    console.error(`❌ Ошибка при получении ответа от модема ${phoneNumber}:`, error.message);
    
    // Убеждаемся, что очистили pending команду
    if (pendingCommands.has(modemSocket)) {
      pendingCommands.delete(modemSocket);
    }
    
    // Всегда возвращаем JSON
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Ошибка при получении ответа от модема',
      response: null
    });
  }
});

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Обработчик для всех API маршрутов, которые не найдены
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'API endpoint не найден',
    path: req.path
  });
});

// Обработка необработанных ошибок
process.on('uncaughtException', (err) => {
  console.error('❌ Необработанная ошибка:', err);
  console.error('Стек ошибки:', err.stack);
  // Не завершаем процесс, чтобы PM2 мог перезапустить
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Необработанное отклонение промиса:', reason);
  console.error('Промис:', promise);
});

// Функция для восстановления подключений к модемам при старте
async function restoreConnections() {
  console.log('\n🔄 Восстановление подключений к модемам после перезапуска сервера...');
  
  const serverModeModems = [];
  const clientModeModems = [];
  let skippedCount = 0;
  
  // Разделяем модемы по режимам работы
  for (const [phoneNumber, modem] of Object.entries(modems)) {
    if (!modem.settings || !modem.settings.mode) {
      continue; // Модем не настроен
    }
    
    if (modem.settings.mode === 'server' && modem.settings.port) {
      // Режим "Сервер" - сервер подключается к модему
      if (serverModeConnections.has(phoneNumber)) {
        const existingSocket = serverModeConnections.get(phoneNumber);
        if (existingSocket && !existingSocket.destroyed && existingSocket.writable) {
          console.log(`   ⏭️  Модем ${phoneNumber} (Сервер) уже подключен, пропускаем`);
          skippedCount++;
          continue;
        } else {
          serverModeConnections.delete(phoneNumber);
        }
      }
      serverModeModems.push({ phoneNumber, modem });
    } else if (modem.settings.mode === 'client') {
      // Режим "Клиент" - модем подключается к серверу
      // Проверяем, есть ли уже активное подключение
      let hasActiveConnection = false;
      for (const [address, conn] of modemConnections.entries()) {
        if (conn.modem && conn.modem.phoneNumber === phoneNumber) {
          if (conn.socket && !conn.socket.destroyed) {
            hasActiveConnection = true;
            console.log(`   ⏭️  Модем ${phoneNumber} (Клиент) уже подключен, пропускаем`);
            skippedCount++;
            break;
          }
        }
      }
      
      if (!hasActiveConnection) {
        clientModeModems.push({ phoneNumber, modem });
      }
    }
  }
  
  // Восстанавливаем подключения в режиме "Сервер"
  if (serverModeModems.length > 0) {
    console.log(`\n   📡 Восстановление подключений в режиме "Сервер" (${serverModeModems.length} модемов)...`);
    let restoredCount = 0;
    
    for (let i = 0; i < serverModeModems.length; i++) {
      const { phoneNumber, modem } = serverModeModems[i];
      
      setTimeout(async () => {
        try {
          console.log(`   🔌 Восстанавливаю подключение к модему ${phoneNumber} (Сервер)...`);
          await connectToModemServer(phoneNumber, modem);
          restoredCount++;
          console.log(`   ✅ Подключение к модему ${phoneNumber} восстановлено`);
        } catch (err) {
          console.log(`   ⚠️  Не удалось восстановить подключение к модему ${phoneNumber}: ${err.message}`);
        }
        
        if (i === serverModeModems.length - 1) {
          setTimeout(() => {
            console.log(`   ✅ Режим "Сервер": восстановлено ${restoredCount} из ${serverModeModems.length}`);
          }, 1000);
        }
      }, i * 2000);
    }
  }
  
  // Для режима "Клиент" - модемы подключаются сами, но мы можем улучшить их распознавание
  if (clientModeModems.length > 0) {
    console.log(`\n   📱 Ожидание подключений модемов в режиме "Клиент" (${clientModeModems.length} модемов)...`);
    console.log(`   💡 Модемы в режиме "Клиент" подключаются сами к серверу`);
    console.log(`   💡 Если модем не подключился в течение 1-2 минут, проверьте настройки модема`);
    
    // Выводим информацию о модемах, которые должны подключиться
    for (const { phoneNumber, modem } of clientModeModems) {
      const lastIP = modem.lastKnownIP || modem.connectionAddress?.split(':')[0] || 'неизвестен';
      console.log(`      - Модем ${phoneNumber} (${modem.name}), последний IP: ${lastIP}`);
    }
  }
  
  if (serverModeModems.length === 0 && clientModeModems.length === 0 && skippedCount === 0) {
    console.log('   ℹ️  Модемы не найдены или не настроены');
  } else {
    setTimeout(() => {
      console.log(`\n✅ Восстановление подключений завершено`);
      console.log(`   Режим "Сервер": ${serverModeModems.length} модемов, Режим "Клиент": ${clientModeModems.length} модемов, Уже подключено: ${skippedCount}`);
    }, 3000);
  }
}

// Проверка существования директории public
const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
  console.warn('⚠️  Директория public не найдена, создаю...');
  fs.mkdirSync(publicPath, { recursive: true });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на http://0.0.0.0:${PORT}`);
  console.log(`🌐 Веб-интерфейс доступен по адресу http://147.45.212.205:${PORT}`);
  console.log(`📁 Рабочая директория: ${__dirname}`);
  console.log(`📁 Статические файлы: ${publicPath}`);
  
  // Восстанавливаем подключения к модемам после запуска сервера
  // Задержка 2 секунды, чтобы сервер полностью запустился
  setTimeout(() => {
    restoreConnections();
  }, 2000);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ ОШИБКА: Порт ${PORT} уже занят!\n`);
    console.log('Решения:');
    console.log('1. Найдите процесс: sudo lsof -i :' + PORT);
    console.log('2. Остановите процесс: sudo kill <PID>');
    console.log('3. Или используйте другой порт: PORT=3005 npm start\n');
    process.exit(1);
  } else {
    console.error('❌ Ошибка запуска сервера:', err);
    throw err;
  }
});
