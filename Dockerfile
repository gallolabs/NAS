FROM alpine:latest

RUN apk add --no-cache \
	samba-common-tools samba \
	tzdata nodejs \
	nginx nginx-mod-http-fancyindex nginx-mod-http-dav-ext apache2-utils \
	vsftpd \
	openssh-sftp-server openssh-server
RUN apk add --no-cache nfs-utils
RUN apk add --no-cache npm

RUN rm /etc/nginx/http.d/* /etc/nginx/nginx.conf /etc/vsftpd/vsftpd.conf /etc/ssh/sshd_config /etc/exports

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm i

RUN apk add --no-cache openssl

COPY src ./src
COPY tsconfig.json ./

RUN npm run build

EXPOSE 137/udp 138/udp 139 445 80 20 21 22 111 2049 443 989 990

HEALTHCHECK --interval=60s --timeout=15s CMD smbclient -L \\localhost -U %

VOLUME /var/lib/nas

CMD ["node", "."]
