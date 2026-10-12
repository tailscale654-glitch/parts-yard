'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = process.env;

module.exports = {
  ROOT,
  bind: env.WMS_BIND || '0.0.0.0',
  port: Number(env.WMS_PORT || 8090),
  dbPath: env.WMS_DB || path.join(ROOT, 'data', 'warehouse.db'),
  layoutPath: env.WMS_LAYOUT || path.join(ROOT, 'layout.json'),
  demo: env.WMS_DEMO === '1',
  // за nginx с HTTPS: WMS_TRUST_PROXY=1 и WMS_SECURE_COOKIE=1
  trustProxy: env.WMS_TRUST_PROXY === '1',
  secureCookie: env.WMS_SECURE_COOKIE === '1',
  cookieName: env.WMS_COOKIE || 'pyard.sid',
  sessionDays: Number(env.WMS_SESSION_DAYS || 14),
  devStatic: env.WMS_DEV === '1',
  // интеграция с Carsale (только чтение); пароль хранится только здесь, в /etc/default/parts-yard
  carsale: {
    base: env.CARSALE_URL || 'https://crm.carsale.uz',
    login: env.CARSALE_LOGIN || '',
    password: env.CARSALE_PASSWORD || '',
    filial: env.CARSALE_FILIAL || '',
  },
};
