FROM alpine:latest

RUN apk add --no-cache samba-common-tools samba tzdata

RUN apk add --no-cache nodejs

RUN apk add --no-cache nginx nginx-mod-http-dav-ext apache2-utils

RUN apk add --no-cache vsftpd

RUN rm /etc/nginx/http.d/* /etc/nginx/nginx.conf /etc/vsftpd/vsftpd.conf

WORKDIR /app

COPY entrypoint.sh provisionning.js ./

EXPOSE 137/udp 138/udp 139 445 80 20 21

HEALTHCHECK --interval=60s --timeout=15s CMD smbclient -L \\localhost -U %

CMD ["./entrypoint.sh"]
