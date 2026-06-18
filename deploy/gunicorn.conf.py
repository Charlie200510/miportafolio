# Config de gunicorn para correr Mi Portafolio en un servidor propio (Oracle).
# Se usa con:  gunicorn app:app -c .../deploy/gunicorn.conf.py
import os

bind = "127.0.0.1:8000"          # solo local; Caddy hace de puerta al exterior (HTTPS)
# Varios workers = redundancia y CERO downtime al reciclar (a diferencia de Render free).
#   - VM ARM Ampere (4 cores/24GB): pon WEB_CONCURRENCY=3 o 4
#   - VM AMD micro (1GB RAM):       pon WEB_CONCURRENCY=1
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
threads = int(os.environ.get("GUNICORN_THREADS", "4"))
timeout = 90
preload_app = True
max_requests = 1000
max_requests_jitter = 100
accesslog = "-"
errorlog = "-"
