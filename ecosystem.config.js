module.exports = {
  apps: [{
    name: 'irz-modem-control',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    min_uptime: '10s', // Минимальное время работы перед перезапуском
    max_restarts: 10, // Максимум перезапусков за период
    restart_delay: 4000, // Задержка перед перезапуском (4 секунды)
    env: {
      NODE_ENV: 'production',
      PORT: 3004
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // Отключить автоперезапуск при ошибках (для диагностики)
    // autorestart: false
  }]
};
