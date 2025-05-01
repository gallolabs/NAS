#!/bin/sh

set -e

CONFIG_FILE='/etc/samba/smb.conf'
HOSTNAME=`hostname`

export HOSTNAME
export CONFIG_FILE
node provisionning.js

cat "$CONFIG_FILE"
cat /etc/vsftpd/vsftpd.conf

nmbd -D
tail -q -n +1 -F /var/log/samba/log.smbd >> /dev/stdout &
nginx -c /etc/nginx/nginx.conf -g "daemon off;" &
vsftpd /etc/vsftpd/vsftpd.conf &
tail -q -n +1 -F /var/log/sftpd.log >> /dev/stdout &
exec ionice -c 3 smbd -F --no-process-group --configfile="$CONFIG_FILE" < /dev/null
