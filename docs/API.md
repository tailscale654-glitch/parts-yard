# REST API склада запчастей

Документ для Android-клиента (ТСД) и интеграций. Сервер отдельный от jac-yard, но устроен так же:
JSON поверх HTTP и cookie-сессия.

## Общие правила

- Все запросы и ответы в JSON, кодировка UTF-8.
- Адрес ячейки: `Зона-Ряд-Стеллаж-Ярус-Ячейка`, например `A-02-07-3-1`. Регистр букв не важен.
- Количество всегда целое число штук.
- Ошибка возвращается как `{"ok": false, "error": "текст для человека", "code": "МАШИННЫЙ_КОД", ...}`.
  Клиент принимает решения по `code` и показывает пользователю `error`.
- Каждый ответ на изменение содержит `rev`, номер версии данных склада. Если `rev` не совпадает
  с кэшем клиента, нужно запросить `/api/state`.

## Вход

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/api/login` | `{"username","password"}` | `{"user":{"username","role"}}` + cookie `pyard.sid` |
| POST | `/api/logout` | — | `{"ok":true}` |
| GET | `/api/me` | — | `{"user":{...}}` |

Сессия живёт 14 дней и продлевается при работе. Без сессии любой `/api/*` отвечает
`401 AUTH_REQUIRED`, и клиент возвращается на экран входа. После 8 неверных паролей
с одного адреса за 10 минут сервер отвечает `429 RATE_LIMIT`.

В Android: тот же `CookieJar`, что и для `jac.sid`, только для хоста склада.

## Чтение

| Метод | Путь | Что возвращает |
|---|---|---|
| GET | `/api/layout` | зоны: ряды, стеллажи, ярусы, ячейки, координаты схемы |
| GET | `/api/rev` | `{"rev": 128}` — дешёвая проверка «изменилось ли что-то» |
| GET | `/api/state` | полный снимок: `cells`, `skus`, `receipts`, `orders`, `log`, `rev`, `user` |
| GET | `/api/cells/{addr}` | одна ячейка: `sku`, `name`, `qty`, `per` (вместимость), `blocked`, `zone`, `tier` |
| GET | `/api/skus/{art}` | артикул и все ячейки, где он лежит |
| GET | `/api/plan/putaway/{receiptId}` | предложенные адреса для строки поставки, в порядке обхода |
| GET | `/api/plan/pick/{orderId}` | лист отбора по остатку заказа, в порядке обхода, и недостача |
| GET | `/api/scan?code=` | что отсканировали: `{"kind":"cell","addr","cell","home"}`, `{"kind":"rack","rack","cells"}` или `{"kind":"sku","sku":{"art","name","zone","per","barcode","home","cells"}}`; 404 `UNKNOWN_CODE` |
| GET | `/api/tsd/dict` | словарь для работы ТСД без сети: `addrs` (все адреса) и `skus` — `[art, name, zone, per, barcode]` |
| GET | `/api/tsd/app` | последняя версия приложения для ТСД: `versionCode`, `versionName`, `size`, `url` (0 — не загружено) |

Адрес в путях и в `/api/move` принимается в любом написании: `a-8-1-2` и `A 08 01 02` — это `A-08-01-02`.

В `state.cells` хранятся только непустые или заблокированные ячейки, в виде
`"A-01-02-3-1": ["FO-15208", 12, 0]` (артикул, количество, блокировка).

## Изменения

| Метод | Путь | Тело |
|---|---|---|
| POST | `/api/cells/{addr}/put` | `{"art","qty","receiptId"?}` — положить в ячейку |
| POST | `/api/cells/{addr}/pick` | `{"art","qty","orderId"?}` — взять из ячейки |
| POST | `/api/cells/{addr}/count` | `{"qty"}` — пересчёт, 0 освобождает ячейку |
| POST | `/api/cells/{addr}/block` | `{"blocked": true\|false}` |
| POST | `/api/move` | `{"from","to","qty"}` — перемещение между ячейками одной зоны |
| POST | `/api/receipts/{id}/putaway` | провести весь план размещения (веб) |
| POST | `/api/orders/{id}/pick` | провести весь лист отбора и закрыть заказ (веб) |
| POST | `/api/orders/{id}/close` | закрыть заказ с недостачей |
| POST | `/api/skus/{art}/barcode` | `{"barcode"}` — привязать заводской штрихкод (права `stock.put` или `catalog.manage`); `BARCODE_TAKEN`, `BARCODE_IS_CELL` |
| POST | `/api/admin/tsd-app` | тело — сам APK (`Content-Type: application/vnd.android.package-archive`), права `admin.settings`. Пакет должен быть `uz.jacmotors.sklad`; старая версия — только с `?force=1` |

Без входа доступны `GET /app` (страница установки приложения) и `GET /app/sklad-jac.apk`.

Если добавить `?state=1`, ответ будет содержать полный снимок `state`.

### Идемпотентность и офлайн-очередь

Каждой операции ТСД присваивает уникальный `opId`: UUID, создаётся один раз при постановке
в очередь Room. Передаётся заголовком `X-Op-Id` или полем `opId`. Сервер выполняет операцию
с данным `opId` только один раз. При повторе он отдаёт сохранённый ответ с `"replayed": true`.
Поэтому WorkManager может спокойно переотправлять очередь после обрыва связи.

Отказ по бизнес-правилу (409) тоже сохраняется за `opId`. Повтор вернёт тот же отказ,
и операция переходит в журнал проблем синхронизации, а не крутится в очереди бесконечно.

Чем это отличается от jac-yard: там «поставить VIN на место» можно повторить безопасно.
Здесь операции считаются в штуках, поэтому очередь отправляет **операции**, а не итоговые
остатки. Если два ТСД офлайн взяли из одной ячейки больше, чем там было, второй получит
`409 INSUFFICIENT` с полем `available`. Клиент показывает это кладовщику, чтобы он пересчитал
ячейку.

Чтобы операции применялись в правильном порядке, очередь отправляется последовательно, по одной.

### Коды ошибок

| HTTP | code | Что делать клиенту |
|---|---|---|
| 400 | `BAD_QTY`, `BAD_JSON`, `SAME_CELL`, `BAD_OP_ID` | ошибка ввода, показать и не повторять |
| 401 | `AUTH_REQUIRED`, `BAD_LOGIN` | на экран входа; очередь не трогать |
| 403 | `FORBIDDEN`, `NOT_DEMO` | нет прав |
| 404 | `NO_ADDRESS`, `NO_SKU`, `NO_RECEIPT`, `NO_ORDER` | отсканирован не тот штрихкод |
| 409 | `WRONG_ITEM` | в ячейке другой артикул: проверить ячейку |
| 409 | `INSUFFICIENT` (+`available`) | товара меньше, чем пытаются взять |
| 409 | `OVER_CAPACITY` (+`free`) | ячейка переполнится |
| 409 | `CELL_OCCUPIED`, `WRONG_ZONE`, `CELL_BLOCKED`, `CELL_EMPTY` | выбрать другую ячейку |
| 409 | `OVER_RECEIPT`, `OVER_ORDER` (+`remaining`), `RECEIPT_DONE`, `ORDER_DONE` | расхождение с документом |
| 429 | `RATE_LIMIT` | подождать |
| 500 | `INTERNAL` | повторить позже, операция остаётся в очереди |

Временные ошибки (500, обрыв сети, таймаут) повторяются. Ответы 400, 404 и 409 окончательные.

## Сценарий ТСД: отбор

1. `GET /api/plan/pick/{orderId}` возвращает точки по порядку обхода.
2. На каждой точке кладовщик сканирует штрихкод ячейки, затем штрихкод детали.
   Клиент сверяет оба скана с планом.
3. `POST /api/cells/{addr}/pick` с `{"art","qty","orderId","opId"}` (офлайн — в очередь).
4. Когда все строки взяты, сервер сам закрывает заказ (`orderDone: true` в ответе).
   Если товара не хватило, вызывается `POST /api/orders/{id}/close`.

## Пример

```sh
curl -c c.txt -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' http://склад:8090/api/login
curl -b c.txt -H 'Content-Type: application/json' -H 'X-Op-Id: 6f1c…' \
  -d '{"art":"FO-15208","qty":2}' http://склад:8090/api/cells/A-01-02-3-1/pick
```

---

# WarehouseOS: права и остальные разделы API

## Права

Каждый запрос проверяется по правам роли пользователя. Без права сервер отвечает
`403 FORBIDDEN` с полем `need` (какие права подошли бы). `GET /api/me` возвращает пользователя,
список его прав (`perms`) и настройки склада: клиент по ним скрывает недоступные экраны и кнопки.

| Право | Что открывает |
|---|---|
| `dashboard.view` / `dashboard.edit` | дашборды и личные дашборды / общие дашборды |
| `stock.view` | карта, остатки, каталог, документы (чтение) |
| `stock.put`, `stock.pick`, `stock.move`, `stock.count`, `stock.block` | складские операции |
| `docs.receipts`, `docs.orders`, `catalog.manage` | создание поставок, заказов, правка каталога |
| `inventory.count`, `inventory.manage` | подсчёт по заданию / создание и закрытие заданий |
| `reports.view` | отчёты и выгрузка |
| `admin.users`, `admin.roles`, `admin.layout`, `admin.settings`, `admin.audit` | администрирование |

Для ТСД кладовщику достаточно встроенной роли `storekeeper`.

## Каталог и документы

| Метод | Путь | Право | Тело / параметры |
|---|---|---|---|
| GET | `/api/catalog?q=&zone=` | stock.view | артикулы с остатком, числом ячеек, минимумом |
| POST | `/api/catalog` | catalog.manage | `{art,name,zone,per,min_qty,isNew?}` |
| POST | `/api/catalog/import` | catalog.manage | `{rows:[{art,name,zone,per,min_qty}]}` |
| DELETE | `/api/catalog/{art}` | catalog.manage | только если нигде не используется |
| GET | `/api/receipts?state=open\|done\|all` | stock.view | поставки со строками |
| POST | `/api/receipts` | docs.receipts | `{doc,gate,lines:[{art,qty}]}` |
| DELETE | `/api/receipts/doc/{doc}` | docs.receipts | пока ничего не размещено |
| GET | `/api/orders?state=open\|done\|all` | stock.view | заказы со строками, взято, остаток на складе |
| POST | `/api/orders` | docs.orders | `{number,dealer_id?,dealer,due:"15:00",lines:[{art,qty}]}` — дилер из справочника по `dealer_id`, названию или коду; иначе `400 BAD_DEALER` (пока справочник пуст — принимается имя) |
| DELETE | `/api/orders/{id}` | docs.orders | пока ничего не взято |

## Инвентаризация

| Метод | Путь | Право | |
|---|---|---|---|
| GET | `/api/inventory` | stock.view или inventory.count | задания с прогрессом и числом расхождений |
| POST | `/api/inventory` | inventory.manage | `{name, zones:["A"], rows:["B-01"], onlyStocked}` |
| GET | `/api/inventory/{id}` | stock.view или inventory.count | задание и строки (учёт, факт) |
| POST | `/api/inventory/{id}/lines/{lineId}` | inventory.count | `{qty, art?}` — факт; поддерживает `opId` |
| POST | `/api/inventory/{id}/close` | inventory.manage | записывает факт в ячейки |
| POST | `/api/inventory/{id}/cancel` | inventory.manage | |

`art` указывается, если в ячейке найден не тот артикул, что по учёту, или ячейка числилась пустой.
Одна ячейка не может быть в двух открытых заданиях (`409 INV_OVERLAP`).

## Дашборды, метрики, отчёты

| Метод | Путь | Право | |
|---|---|---|---|
| GET | `/api/metrics` | dashboard.view | каталог метрик: форма данных, параметры, виды |
| POST | `/api/metrics/batch` | dashboard.view | `{items:[{metric, params:{days,zone,limit}}]}` |
| GET/POST | `/api/dashboards` | dashboard.view | список / создать (`shared:true` — нужно dashboard.edit) |
| PUT/DELETE | `/api/dashboards/{id}` | автор или dashboard.edit | `{name, shared, widgets:[{metric,viz,w,params,title}]}` |
| GET | `/api/reports` | reports.view | список отчётов и справочники для фильтров |
| GET | `/api/reports/{id}?from=&to=&zone=&user=&kind=&art=…` | reports.view | таблица; `&format=csv` — файл для Excel |

## Администрирование

| Метод | Путь | Право |
|---|---|---|
| GET, POST | `/api/admin/users` | admin.users |
| PATCH | `/api/admin/users/{id}` — `{full_name, role, active}` | admin.users |
| POST | `/api/admin/users/{id}/password` — без пароля сгенерирует новый | admin.users |
| POST | `/api/admin/users/{id}/logout` | admin.users |
| GET | `/api/admin/roles` | admin.users или admin.roles |
| POST, PUT, DELETE | `/api/admin/roles[/{key}]` — `{key,name,description,perms}` | admin.roles |
| GET, PUT | `/api/admin/settings` | admin.settings |
| GET | `/api/admin/backup` — файл базы | admin.settings |
| GET, PUT | `/api/admin/layout` — `{zones:[…]}` | admin.layout |
| POST | `/api/admin/layout/preview`, `/api/admin/layout/reset` | admin.layout |
| GET | `/api/admin/audit?from=&to=&q=` | admin.audit |
| POST | `/api/me/password` — `{current, password}` | любой вошедший |

`GET /api/rev` теперь возвращает ещё `layoutRev` (меняется при правке топологии — клиенту
нужно перезапросить `/api/layout`) и `badges` — счётчики открытых поставок, заказов и инвентаризаций.

## Дилеры

Справочник — копия Carsale «Запчасти → Справочники → Дилеры» (`/b/tmc_hybrid&get_tmc_dealer_list`).
Добавляет, меняет и удаляет дилеров только синхронизация.

| Метод | Путь | Право | |
|---|---|---|---|
| GET | `/api/dealers` | stock.view | дилеры (код, регион, адрес, телефон, ИНН, `active`, число заказов), регионы, состояние проверки |
| GET | `/api/dealers/{id}` | stock.view | карточка: последние 30 заказов и итоги |
| PUT | `/api/dealers/{id}` | docs.orders | `{note}` — заметка склада, в Carsale не уходит |

## Интеграция Carsale

| Метод | Путь | Право | |
|---|---|---|---|
| GET | `/api/integrations/carsale` | admin.settings или catalog.manage | состояние, настройки, история синхронизаций (без пароля) |
| PUT | `/api/integrations/carsale/settings` | admin.settings | `{enabled, dealers, intervalMin, statusIds, storeIds, zoneMap:{"TOOLS":"D"}, defaultZone, defaultPer}` |
| POST | `/api/integrations/carsale/sync` | admin.settings или catalog.manage | синхронизировать сейчас (каталог, остатки, дилеры); `partial:true` если одна часть не удалась; `502 CARSALE_FAILED` если не удалось ничего |
| GET | `/api/integrations/carsale/reconcile` | stock.view | по артикулу: в Carsale, бронь, в ячейках, в приёмке, разница, статус |
| POST | `/api/integrations/carsale/receipt` | docs.receipts | поставка `CS-ГГММДД-ЧЧММ` на неразмещённое |

У артикулов из Carsale в каталоге есть поля `source:"carsale"`, `ext_qty` (на складе по Carsale), `ext_reserved` (бронь),
`price`, `unit`, `brand`, `ext_type`, `ext_location`.
