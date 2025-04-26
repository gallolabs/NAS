#!/bin/sh

set -e

CONFIG_FILE='/etc/samba/smb.conf'
HOSTNAME=`hostname`

export HOSTNAME
export CONFIG_FILE
node provisionning.js

# cat "$CONFIG_FILE"

nmbd -D
exec ionice -c 3 smbd -F --no-process-group --configfile="$CONFIG_FILE" < /dev/null
