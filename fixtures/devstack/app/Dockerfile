FROM docker.io/library/alpine:latest
# postgresql-client gives pg_isready/psql so the app can prove it reaches "db" by
# DNS name; python3 serves the status page (stdlib http.server — always present,
# unlike the optional busybox httpd applet).
RUN apk add --no-cache postgresql-client python3
COPY serve.sh /serve.sh
RUN chmod +x /serve.sh
EXPOSE 80
CMD ["/serve.sh"]
