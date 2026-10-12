# Адресный склад запчастей

Отдельный сервис адресного хранения для центрального склада. Стек тот же, что у jac-yard:
Node.js + Express, SQLite (better-sqlite3), вход по cookie-сессиям. База своя, релизы независимые.

Возможности:

- план склада с зонами и заполненностью стеллажей;
- фасады стеллажей по ярусам;
- приёмка с подбором адресов;
- отбор заказов дилеров по маршруту;
- пересчёт, блокировка и перемещение ячеек;
- журнал операций с именем сотрудника.

REST API рассчитан на Android-клиент с офлайн-очередью, описание в [docs/API.md](docs/API.md).

## Требования

- Debian 11, 12 или 13
- Node.js 20 или новее:
  - Debian 13 — пакет из репозитория (`apt install nodejs npm`);
  - Debian 11/12 — установщик поставит Node.js 22 из NodeSource с ключом `--install-node`.
- Доступ к npm при установке (express и better-sqlite3).

## Установка через GitHub

На сервере Debian:

```sh
sudo apt install -y git
git clone https://github.com/<аккаунт>/parts-yard.git ~/parts-yard
cd ~/parts-yard
sudo sh install.sh                 # с демо-данными
```

Обновление после `git push` с рабочего компьютера:

```sh
cd ~/parts-yard && sudo sh update.sh
```

`update.sh` забирает код (`git pull`) и переустанавливает службу. База, пользователи
и настройки остаются. Демо-данные при обновлении не загружаются.

Для приватного репозитория нужен доступ с сервера: deploy key (SSH-ключ только на чтение,
GitHub → Settings → Deploy keys) и адрес вида `git@github.com:<аккаунт>/parts-yard.git`.

## Установка из архива

```sh
tar xzf parts-yard-node.tar.gz
cd parts-yard
sudo ./install.sh                  # с демо-данными
sudo ./install.sh --no-demo        # пустой склад
sudo ./install.sh --install-node   # если Node.js нет или он старше 20
```

Установщик выполнит следующее:

- создаст пользователя системы `partsyard`;
- поставит зависимости в `/opt/parts-yard`;
- запустит службу `parts-yard` на порту **8090**;
- создаст администратора `admin` и **один раз** покажет его пароль.

Обновление: распакуйте новую версию и снова запустите `sudo ./install.sh`.
База, пользователи и настройки сохраняются.

Если `npm ci` не может скачать готовый модуль better-sqlite3, поставьте компилятор
(`sudo apt install build-essential python3`) и повторите установку.

## Пользователи

```sh
sudo parts-yard user-add petrova                 # оператор, пароль сгенерируется
sudo parts-yard user-add ivanov --role admin --password 'Склад2026'
sudo parts-yard user-del petrova                 # отключить и выкинуть из всех сессий
sudo parts-yard user-list
```

Оператор работает со складом. Администратор вдобавок может сбросить демо-данные.
Повторный `user-add` для существующего логина меняет пароль и завершает его сессии.

## Где что лежит

| Путь | Что это |
|---|---|
| `/etc/default/parts-yard` | порт, демо-режим, параметры сессий и прокси |
| `/etc/parts-yard/layout.json` | топология: зоны, ряды, стеллажи, ярусы, ячейки |
| `/var/lib/parts-yard/warehouse.db` | база SQLite (WAL) |
| `/opt/parts-yard/` | программа, примеры CSV, docs/API.md |

После изменения настроек или топологии: `sudo systemctl restart parts-yard`.
Новые ячейки из layout.json добавятся сами. Журнал службы: `journalctl -u parts-yard -f`.

## Данные

CSV в UTF-8 (из Excel — «CSV UTF-8»), разделитель `;`, `,` или табуляция, заголовок необязателен.
Образцы лежат в `/opt/parts-yard/examples/`.

```sh
sudo parts-yard import-skus catalog.csv                          # артикул;наименование;зона;вместимость_ячейки
sudo parts-yard import-receipt receipt.csv --doc ПТ-10413 --gate 2   # артикул;количество
sudo parts-yard import-order order.csv --number ЗК-24130 --dealer "Дилерский центр «Юг»" --due 16:00
sudo parts-yard export-stock /root/остатки.csv
sudo parts-yard backup /root/warehouse-$(date +%F).db             # копия на ходу, без остановки
```

### Переход с демо на реальные данные

```sh
sudo sed -i 's/^WMS_DEMO=.*/WMS_DEMO=0/' /etc/default/parts-yard
sudo nano /etc/parts-yard/layout.json          # свой склад
sudo systemctl stop parts-yard
sudo cp /var/lib/parts-yard/warehouse.db /root/warehouse-demo.db
sudo rm /var/lib/parts-yard/warehouse.db*
sudo parts-yard init
sudo parts-yard user-add admin --role admin
sudo parts-yard import-skus catalog.csv
sudo systemctl start parts-yard
```

## HTTPS через nginx

Пароли и cookie нельзя пускать по сети без шифрования за пределами склада. Пример конфига:

```nginx
server {
    listen 443 ssl;
    server_name sklad.example.uz;
    ssl_certificate     /etc/letsencrypt/live/sklad.example.uz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sklad.example.uz/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

В `/etc/default/parts-yard` при этом нужно задать:
- `WMS_BIND=127.0.0.1`;
- `WMS_TRUST_PROXY=1`;
- `WMS_SECURE_COOKIE=1`.

## Как подбираются адреса

- **Размещение.** Сначала дозаполняются ячейки с тем же артикулом в его зоне, затем занимаются
  свободные: ближе к центральному проезду и воротам. В зонах с `"prefer": "middle"` первыми идут
  средние ярусы, в остальных нижние. Если места не хватает, остаток остаётся в строке поставки.
- **Отбор.** Минимум точек: строка заказа по возможности берётся из одной ячейки, а из подходящих
  выбирается наименее полная, чтобы освобождать место. Точки упорядочены по проходам, маршрут
  начинается и заканчивается в зоне отгрузки.

## Разработка

```sh
npm install
WMS_DEMO=1 node cli.js init --demo
node cli.js user-add admin --role admin --password admin123
WMS_DEMO=1 npm start            # http://localhost:8090
npm test                        # тесты API: вход, остатки, opId, конфликты офлайн-ТСД
```

## Удаление

```sh
sudo ./uninstall.sh
```

База и настройки остаются на диске.
