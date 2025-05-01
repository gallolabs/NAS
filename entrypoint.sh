#!/bin/sh

set -e

CONFIG_FILE='/etc/samba/smb.conf'
HOSTNAME=`hostname`

export HOSTNAME
export CONFIG_FILE
node provisionning.js | sed 's/^/[INIT ] /'

nmbd -D
nginx -c /etc/nginx/nginx.conf -g "daemon off;" &
vsftpd /etc/vsftpd/vsftpd.conf &
/usr/sbin/sshd -D -E /var/log/sshd.log &
touch /var/log/sftpd.log /var/log/sshd.log /var/log/nginx/{error,access}.log
tail -q -n +1 -F /var/log/samba/log.smbd  | sed 's/^/[SMBD ] /'  >> /dev/stdout &
tail -q -n +1 -F /var/log/sftpd.log       | sed 's/^/[FTPD ] /'  >> /dev/stdout &
tail -q -n +1 -F /var/log/sshd.log        | sed 's/^/[SSHD ] /'  >> /dev/stdout &
tail -q -n +1 -F /var/log/nginx/*.log     | sed 's/^/[HTTPD] /'  >> /dev/stdout &
exec ionice -c 3 smbd -F --no-process-group --configfile="$CONFIG_FILE" < /dev/null
