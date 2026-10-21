#!/bin/sh
# HTTPS для WarehouseOS: nginx принимает https://<домен> (порт 443, с 80 перенаправляет на https),
# служба parts-yard слушает только 127.0.0.1 — адрес с :8090 снаружи больше не открывается.
#
#   sudo sh ssl-setup.sh <домен> <сертификат.crt> <ключ.key> [цепочка ca-bundle.crt]
#   sudo sh ssl-setup.sh sklad.jacmotors.uz ~/certificate.crt ~/private.key ~/ca-bundle.crt
#
# Продление сертификата — та же команда с новыми файлами.
# Вернуть как было (без nginx, http://IP:8090):  sudo sh ssl-setup.sh --off
set -eu

SSL_DIR=${SSL_DIR:-/etc/ssl/parts-yard}
NGINX_DIR=${NGINX_DIR:-/etc/nginx}
ENV_FILE=${ENV_FILE:-/etc/default/parts-yard}
SITE=$NGINX_DIR/sites-available/parts-yard
LINK=$NGINX_DIR/sites-enabled/parts-yard

die() { echo "Ошибка: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "запустите через sudo: sudo sh ssl-setup.sh …"
[ -f "$ENV_FILE" ] || die "нет $ENV_FILE — сначала установите WarehouseOS (sudo sh install.sh)"

# значение в /etc/default/parts-yard: заменить строку или дописать
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
reload_nginx() { if command -v systemctl >/dev/null 2>&1; then systemctl reload nginx || systemctl restart nginx; else nginx -s reload; fi; }

if [ "${1:-}" = "--off" ]; then
  rm -f "$LINK" "$SITE"
  command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1 && reload_nginx || true
  set_env WMS_BIND 0.0.0.0; set_env WMS_TRUST_PROXY 0; set_env WMS_SECURE_COOKIE 0
  systemctl restart parts-yard
  PORT=$(. "$ENV_FILE"; echo "${WMS_PORT:-8090}")
  say "HTTPS выключен. Адрес снова http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
  exit 0
fi

[ $# -ge 3 ] || die "нужно: sudo sh ssl-setup.sh <домен> <сертификат.crt> <ключ.key> [ca-bundle.crt]"
DOMAIN=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
CERT=$2; KEY=$3; CHAIN=${4:-}
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' \
  || die "«$DOMAIN» — не доменное имя. Сертификат выдан на имя, по IP он работать не будет (пример: sklad.jacmotors.uz)"
printf '%s' "$DOMAIN" | grep -Eq '^[0-9.]+$' && die "нужно доменное имя, а не IP: сертификат *.jacmotors.uz по IP не работает (пример: sklad.jacmotors.uz)"
for f in "$CERT" "$KEY" ${CHAIN:+"$CHAIN"}; do [ -r "$f" ] || die "нет файла $f"; done

# nginx и openssl
if ! command -v nginx >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  say "Ставлю nginx…"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx openssl >/dev/null
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# файлы из Windows бывают с CRLF — убираем \r
tr -d '\r' < "$CERT" > "$TMP/cert.pem"; tr -d '\r' < "$KEY" > "$TMP/key.pem"
[ -n "$CHAIN" ] && tr -d '\r' < "$CHAIN" > "$TMP/chain.pem" || : > "$TMP/chain.pem"

# проверки: ключ от этого сертификата, имя подходит, срок
openssl x509 -in "$TMP/cert.pem" -noout 2>/dev/null || die "$CERT — не сертификат в формате PEM"
openssl pkey -in "$TMP/key.pem" -noout 2>/dev/null || die "$KEY — не закрытый ключ (или он защищён паролем)"
A=$(openssl x509 -in "$TMP/cert.pem" -noout -pubkey | openssl sha256)
B=$(openssl pkey -in "$TMP/key.pem" -pubout | openssl sha256)
[ "$A" = "$B" ] || die "ключ не подходит к сертификату"
NAMES=$(openssl x509 -in "$TMP/cert.pem" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed -n 's/.*DNS:\([^ ]*\).*/\1/p' | tr 'A-Z' 'a-z')
OK=0
for n in $NAMES; do
  case "$n" in
    "$DOMAIN") OK=1 ;;
    \*.*) [ "${DOMAIN#*.}" = "${n#\*.}" ] && OK=1 ;;
  esac
done
[ $OK = 1 ] || die "сертификат выдан на: $(echo $NAMES) — для $DOMAIN он не подходит"
END=$(openssl x509 -in "$TMP/cert.pem" -noout -enddate | cut -d= -f2)
openssl x509 -in "$TMP/cert.pem" -noout -checkend 0 >/dev/null || die "сертификат истёк ($END)"
SOON=0; openssl x509 -in "$TMP/cert.pem" -noout -checkend 2592000 >/dev/null || SOON=1
if [ -s "$TMP/chain.pem" ]; then
  openssl verify -untrusted "$TMP/chain.pem" -CAfile "$TMP/chain.pem" "$TMP/cert.pem" >/dev/null 2>&1 \
    || say "Внимание: цепочка ca-bundle не подтверждает сертификат — проверьте, что это файлы от одного сертификата"
fi

# установка файлов: ключ доступен только root
mkdir -p "$SSL_DIR"; chmod 700 "$SSL_DIR"
cat "$TMP/cert.pem" > "$TMP/full.pem"; [ -s "$TMP/chain.pem" ] && { echo >> "$TMP/full.pem"; cat "$TMP/chain.pem" >> "$TMP/full.pem"; }
sed -i '/^$/d' "$TMP/full.pem"
install -m 644 "$TMP/full.pem" "$SSL_DIR/fullchain.pem"
install -m 600 "$TMP/key.pem" "$SSL_DIR/privkey.pem"

# сайт nginx
PORT=$(. "$ENV_FILE"; echo "${WMS_PORT:-8090}")
# стандартная страница nginx «Welcome» не нужна
DEFAULT_OFF=0
if [ -L "$NGINX_DIR/sites-enabled/default" ] && grep -q '/var/www/html' "$NGINX_DIR/sites-available/default" 2>/dev/null; then
  rm -f "$NGINX_DIR/sites-enabled/default"; DEFAULT_OFF=1
fi
# если на сервере уже есть другие сайты (например, jac-yard) со своим default_server — не спорим с ними
DS=" default_server"
if grep -rlsE 'default_server' "$NGINX_DIR/sites-enabled/" "$NGINX_DIR/conf.d/" 2>/dev/null | grep -qv '/parts-yard$'; then DS=""; fi
# IPv6 на сервере бывает выключен — тогда слушать [::] нельзя
V6_80=""; V6_443=""
if [ -f /proc/net/if_inet6 ]; then V6_80="
    listen [::]:80$DS;"; V6_443="
    listen [::]:443 ssl$DS;"; fi
BACKUP=""
[ -f "$SITE" ] && { BACKUP="$TMP/site.bak"; cp "$SITE" "$BACKUP"; }
cat > "$SITE" <<EOF
# WarehouseOS — создано ssl-setup.sh. Пересоздаётся при повторном запуске.
server {
    listen 80$DS;$V6_80
    server_name $DOMAIN;
    return 301 https://$DOMAIN\$request_uri;
}
server {
    listen 443 ssl$DS;$V6_443
    server_name $DOMAIN;

    ssl_certificate     $SSL_DIR/fullchain.pem;
    ssl_certificate_key $SSL_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:pyard:10m;
    ssl_session_timeout 1d;

    client_max_body_size 64m;   # логотип, фото здания, APK для ТСД

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 180s;  # ручная синхронизация с Carsale может идти долго
    }
}
EOF
ln -sf "$SITE" "$LINK"
if ! nginx -t >"$TMP/nginx.log" 2>&1; then
  cat "$TMP/nginx.log" >&2
  if [ -n "$BACKUP" ]; then cp "$BACKUP" "$SITE"; else rm -f "$LINK" "$SITE"; fi
  [ $DEFAULT_OFF = 1 ] && ln -sf "$NGINX_DIR/sites-available/default" "$NGINX_DIR/sites-enabled/default"
  die "nginx не принял настройки — ничего не поменял, WarehouseOS работает как раньше"
fi
reload_nginx

# служба — только для nginx, без внешнего порта
set_env WMS_BIND 127.0.0.1
set_env WMS_TRUST_PROXY 1
set_env WMS_SECURE_COOKIE 1
systemctl restart parts-yard

# брандмауэр
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw delete allow "$PORT/tcp" >/dev/null 2>&1 || true
fi

# проверка
sleep 2
CODE=$(curl -s --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/login" 2>/dev/null) || true
[ -n "$CODE" ] || CODE=000
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
RES=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
say ""
[ "$CODE" = 200 ] && say "Готово: https://$DOMAIN" || say "nginx настроен, но проверка вернула код $CODE — посмотрите: sudo systemctl status parts-yard nginx"
say "Сертификат: $(echo $NAMES), действует до $END"
[ $SOON = 1 ] && say "ВНИМАНИЕ: сертификат истекает меньше чем через 30 дней — закажите продление и запустите эту команду с новыми файлами"
if [ "$RES" != "$IP" ]; then
  say ""
  if [ -z "$RES" ]; then say "Имя $DOMAIN пока не находится в сети (сервер — $IP)."; else say "Имя $DOMAIN сейчас указывает на $RES, а сервер — $IP."; fi
  say "Попросите администратора сети добавить в DNS запись:  $DOMAIN  A  $IP"
  say "Для проверки с одного компьютера Windows — строка в C:\\Windows\\System32\\drivers\\etc\\hosts:  $IP  $DOMAIN"
fi
say ""
say "Удалите копии ключа, которые копировали на сервер: rm -f $KEY"
