'use strict';
// Права доступа. Роль — это набор прав; у администратора все права ("*").

const PERMS = [
  { key: 'dashboard.view', group: 'Обзор', label: 'Дашборды: просмотр и личные дашборды' },
  { key: 'dashboard.edit', group: 'Обзор', label: 'Дашборды: общие для всех, конструктор' },
  { key: 'stock.view', group: 'Склад', label: 'Карта склада, остатки, каталог (просмотр)' },
  { key: 'stock.put', group: 'Склад', label: 'Размещение товара' },
  { key: 'stock.pick', group: 'Склад', label: 'Отбор товара' },
  { key: 'stock.move', group: 'Склад', label: 'Перемещение между ячейками' },
  { key: 'stock.count', group: 'Склад', label: 'Пересчёт ячеек' },
  { key: 'stock.block', group: 'Склад', label: 'Блокировка ячеек' },
  { key: 'docs.receipts', group: 'Документы', label: 'Поставки: создание, загрузка, удаление' },
  { key: 'docs.orders', group: 'Документы', label: 'Заказы: создание, загрузка, закрытие' },
  { key: 'catalog.manage', group: 'Документы', label: 'Каталог артикулов: изменение' },
  { key: 'inventory.count', group: 'Инвентаризация', label: 'Подсчёт по заданию' },
  { key: 'inventory.manage', group: 'Инвентаризация', label: 'Создание и закрытие заданий' },
  { key: 'reports.view', group: 'Отчёты', label: 'Отчёты и выгрузка в Excel' },
  { key: 'admin.users', group: 'Администрирование', label: 'Пользователи' },
  { key: 'admin.roles', group: 'Администрирование', label: 'Роли и права' },
  { key: 'admin.layout', group: 'Администрирование', label: 'Топология склада' },
  { key: 'admin.settings', group: 'Администрирование', label: 'Настройки системы' },
  { key: 'admin.audit', group: 'Администрирование', label: 'Журнал аудита' },
];
const PERM_KEYS = new Set(PERMS.map((p) => p.key));

const BUILTIN_ROLES = [
  {
    key: 'admin', name: 'Администратор', description: 'Полный доступ, включая пользователей, роли и настройки',
    perms: ['*'],
  },
  {
    key: 'manager', name: 'Начальник склада', description: 'Все складские операции, документы, отчёты и общие дашборды',
    perms: ['dashboard.view', 'dashboard.edit', 'stock.view', 'stock.put', 'stock.pick', 'stock.move', 'stock.count',
      'stock.block', 'docs.receipts', 'docs.orders', 'catalog.manage', 'inventory.count', 'inventory.manage',
      'reports.view', 'admin.audit'],
  },
  {
    key: 'storekeeper', name: 'Кладовщик', description: 'Размещение, отбор, перемещение, пересчёт и инвентаризация',
    perms: ['dashboard.view', 'stock.view', 'stock.put', 'stock.pick', 'stock.move', 'stock.count', 'inventory.count'],
  },
  {
    key: 'viewer', name: 'Наблюдатель', description: 'Только просмотр: карта, дашборды и отчёты',
    perms: ['dashboard.view', 'stock.view', 'reports.view'],
  },
];

function permSet(json) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch (e) { list = []; }
  return new Set(list);
}
function has(set, perm) { return set.has('*') || set.has(perm); }
function expand(set) { return set.has('*') ? PERMS.map((p) => p.key) : [...set].filter((k) => PERM_KEYS.has(k)); }

module.exports = { PERMS, PERM_KEYS, BUILTIN_ROLES, permSet, has, expand };
