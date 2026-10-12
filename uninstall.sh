#!/bin/sh
# Удаление программы. База (/var/lib/parts-yard) и настройки (/etc/parts-yard, /etc/default/parts-yard)
# остаются; удалите их вручную, если они больше не нужны.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Запустите от root: sudo ./uninstall.sh" >&2; exit 1; }
systemctl disable --now parts-yard 2>/dev/null || true
rm -f /etc/systemd/system/parts-yard.service /usr/local/bin/parts-yard
rm -rf /opt/parts-yard
systemctl daemon-reload
echo "Программа удалена. Данные сохранены в /var/lib/parts-yard"
