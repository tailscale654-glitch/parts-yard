#!/bin/sh
# Установка / обновление «Адресного склада запчастей» (Node.js + SQLite) на Debian.
#   sudo ./install.sh                 — установить с демо-данными
#   sudo ./install.sh --no-demo       — пустой склад
#   sudo ./install.sh --install-node  — заодно поставить Node.js 22 из NodeSource, если своего нет или он старше 20
# Повторный запуск обновляет программу; база, пользователи и настройки сохраняются.
set -eu
cd "$(dirname "$0")"

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root: sudo ./install.sh" >&2; exit 1; }

DEMO=1; INSTALL_NODE=0
for a in "$@"; do
  case "$a" in
    --no-demo) DEMO=0 ;;
    --install-node) INSTALL_NODE=1 ;;
    *) echo "Неизвестный параметр: $a" >&2; exit 1 ;;
  esac
done

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt 20 ]; then
  if [ "$INSTALL_NODE" = 1 ]; then
    echo "Ставлю Node.js 22 из NodeSource…"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
  else
    echo "Нужен Node.js 20 или новее (сейчас: $(node -v 2>/dev/null || echo 'не установлен'))." >&2
    echo "Debian 13: sudo apt install nodejs npm" >&2
    echo "Debian 11/12: запустите sudo ./install.sh --install-node" >&2
    exit 1
  fi
fi
command -v npm >/dev/null 2>&1 || apt-get install -y -qq npm

id partsyard >/dev/null 2>&1 || \
  useradd --system --home-dir /var/lib/parts-yard --no-create-home --shell /usr/sbin/nologin partsyard

install -d -o partsyard -g partsyard -m 750 /var/lib/parts-yard
install -d -m 755 /opt/parts-yard /etc/parts-yard
rm -rf /opt/parts-yard/src /opt/parts-yard/public
cp -r src public examples docs package.json package-lock.json cli.js /opt/parts-yard/
install -m 644 layout.json /opt/parts-yard/layout.example.json
[ -f /etc/parts-yard/layout.json ] || install -m 644 layout.json /etc/parts-yard/layout.json

echo "Ставлю зависимости (express, better-sqlite3)…"
if ! (cd /opt/parts-yard && npm ci --omit=dev --no-audit --no-fund --loglevel=error); then
  echo "Не удалось поставить зависимости. Если не скачался готовый модуль better-sqlite3," >&2
  echo "поставьте компилятор и повторите: sudo apt install build-essential python3" >&2
  exit 1
fi

if [ ! -f /etc/default/parts-yard ]; then
  sed "s/^WMS_DEMO=.*/WMS_DEMO=$DEMO/" parts-yard.env > /etc/default/parts-yard
  chmod 600 /etc/default/parts-yard
fi

cat > /usr/local/bin/parts-yard <<'EOF'
#!/bin/sh
# Команды склада: parts-yard help
[ "$(id -u)" -eq 0 ] || { echo "Запускайте через sudo: sudo parts-yard $*" >&2; exit 1; }
set -a; . /etc/default/parts-yard; set +a
rc=0
node /opt/parts-yard/cli.js "$@" || rc=$?
chown -R partsyard:partsyard "$(dirname "$WMS_DB")"
exit $rc
EOF
chmod 755 /usr/local/bin/parts-yard

DB=$(. /etc/default/parts-yard; echo "$WMS_DB")
if [ ! -f "$DB" ]; then
  if [ "$DEMO" = 1 ]; then parts-yard init --demo; else parts-yard init; fi
fi

ADMIN_MSG=""
USERS=$(cd /opt/parts-yard && set -a && . /etc/default/parts-yard && set +a && \
  node -e "const D=require('better-sqlite3');const d=new D(process.env.WMS_DB,{readonly:true});console.log(d.prepare('SELECT COUNT(*) FROM users WHERE active=1').pluck().get())")
if [ "$USERS" = 0 ]; then
  ADMIN_MSG=$(parts-yard user-add admin --role admin)
fi

install -m 644 parts-yard.service /etc/systemd/system/parts-yard.service
systemctl daemon-reload
systemctl enable parts-yard >/dev/null 2>&1
systemctl restart parts-yard
sleep 1

PORT=$(. /etc/default/parts-yard; echo "$WMS_PORT")
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if systemctl is-active --quiet parts-yard; then
  echo "Готово. Откройте в браузере: http://${IP:-localhost}:$PORT"
  [ -n "$ADMIN_MSG" ] && echo "$ADMIN_MSG  ← запишите, пароль больше не покажется"
  echo "Пользователи: sudo parts-yard user-add <логин>   Справка: sudo parts-yard help"
  echo "Журнал службы: journalctl -u parts-yard -f"
else
  echo "Служба не запустилась. Смотрите: journalctl -u parts-yard -n 50" >&2
  exit 1
fi
