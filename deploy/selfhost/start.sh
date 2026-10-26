#!/bin/bash
# Entry point of Dockerfile.selfhost: nginx on $PORT in front of uvicorn.
set -e

# Reuse frontend/nginx.conf: listen on Heroku's $PORT, accept any host name,
# and proxy to uvicorn in this container instead of the compose service.
sed -e "s/listen 80;/listen ${PORT:-8080};/" \
    -e "s/server_name [^;]*;/server_name _;/" \
    -e "s#http://backend:8000#http://127.0.0.1:8000#g" \
    /etc/papermanager/nginx.conf > /etc/nginx/conf.d/default.conf

cd /app
# As PID 1, bash ignores SIGTERM unless trapped, so `docker stop` waited out its whole timeout
# and then killed uvicorn and nginx. Pass the signal on and exit cleanly instead.
trap 'kill -TERM $(jobs -p) 2>/dev/null; wait; exit 0' TERM INT

uvicorn main:app --host 127.0.0.1 --port 8000 &
nginx -g 'daemon off;' &

# Exit (and let Heroku restart the dyno) as soon as either process dies.
wait -n
exit 1
