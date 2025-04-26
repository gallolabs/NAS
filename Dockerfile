FROM alpine:latest

RUN apk add --no-cache samba-common-tools samba tzdata

RUN apk add --no-cache nodejs

WORKDIR /app

COPY entrypoint.sh provisionning.js ./
COPY smb.conf /etc/samba/smb.conf

EXPOSE 137/udp 138/udp 139 445

HEALTHCHECK --interval=60s --timeout=15s CMD smbclient -L \\localhost -U %

CMD ["./entrypoint.sh"]
