FROM alpine:latest

RUN apk add --no-cache \
	samba-common-tools samba \
	tzdata nodejs \
	nginx nginx-mod-http-fancyindex nginx-mod-http-dav-ext apache2-utils \
	vsftpd \
	openssh-sftp-server openssh-server

RUN rm /etc/nginx/http.d/* /etc/nginx/nginx.conf /etc/vsftpd/vsftpd.conf /etc/ssh/sshd_config

WORKDIR /app

COPY entrypoint.sh provisionning.js ./

EXPOSE 137/udp 138/udp 139 445 80 20 21 22

HEALTHCHECK --interval=60s --timeout=15s CMD smbclient -L \\localhost -U %

VOLUME /var/lib/nas

CMD ["./entrypoint.sh"]
