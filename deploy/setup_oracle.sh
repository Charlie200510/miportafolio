#!/usr/bin/env bash
# Setup de Mi Portafolio en una VM Ubuntu de Oracle Cloud.
# Se corre UNA vez, ya con el repo clonado en ~/portafolio-app y deploy/.env lleno.
#   bash ~/portafolio-app/deploy/setup_oracle.sh
set -e

APP=/home/ubuntu/portafolio-app
cd "$APP"

echo "==> 1/6 Paquetes del sistema…"
sudo apt-get update -y
sudo apt-get install -y python3-venv python3-pip git debian-keyring debian-archive-keyring apt-transport-https curl

echo "==> 2/6 Instalando Caddy (HTTPS automático)…"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "==> 3/6 Entorno Python + dependencias…"
python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install --upgrade pip
"$APP/.venv/bin/pip" install -r "$APP/backend/requirements.txt"
"$APP/.venv/bin/pip" install gunicorn

echo "==> 4/6 Abriendo puertos 80/443 en el firewall del Ubuntu (gotcha de Oracle)…"
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
sudo netfilter-persistent save || sudo bash -c 'iptables-save > /etc/iptables/rules.v4' || true

echo "==> 5/6 Configurando Caddy…"
sudo cp "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl restart caddy

echo "==> 6/6 Configurando el servicio de la app…"
sudo cp "$APP/deploy/miportafolio.service" /etc/systemd/system/miportafolio.service
sudo systemctl daemon-reload
sudo systemctl enable miportafolio
sudo systemctl restart miportafolio

echo ""
echo "LISTO. Verifica con:"
echo "  sudo systemctl status miportafolio --no-pager"
echo "  curl -s localhost:8000/api/health"
echo "  (y desde tu navegador: https://miportafolio.uk una vez el DNS apunte aquí)"
