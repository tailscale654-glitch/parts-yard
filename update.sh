#!/bin/sh
# Обновление с GitHub: забрать свежий код и переустановить службу.
#   cd ~/parts-yard && sudo sh update.sh
# База, пользователи и настройки не затрагиваются.
set -eu
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo: sudo sh update.sh" >&2; exit 1; }
OWNER=$(stat -c %U .)
BEFORE=$(git rev-parse --short HEAD)
# git выполняется от владельца папки, чтобы не портить права и ключи доступа
runuser -u "$OWNER" -- git pull --ff-only
AFTER=$(git rev-parse --short HEAD)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "Обновлений нет ($AFTER). Переустанавливаю всё равно…"
else
  echo "Обновлено: $BEFORE → $AFTER"
  runuser -u "$OWNER" -- git log --oneline "$BEFORE..$AFTER"
fi
sh ./install.sh --no-demo
