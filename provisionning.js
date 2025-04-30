import { spawnSync } from 'node:child_process'
import { createWriteStream, writeFileSync } from 'fs'

const config = JSON.parse(process.env.CONFIG)
const writeHandler = createWriteStream(process.env.CONFIG_FILE)

const guestUser = config.guestUser || 'nobody'

writeHandler.write(`
; https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html

[global]
 server role = standalone server
security = user
load printers = no
printing = bsd
printcap name = /dev/null
disable spoolss = yes
map to guest = never
socket options = TCP_NODELAY IPTOS_LOWDELAY SO_RCVBUF=65536 SO_SNDBUF=65536 SO_KEEPALIVE
local master = no
dns proxy = no
deadtime = 15
log level = 1 auth_json_audit:3
max log size = 10
log file = /var/log/samba/log.smbd
min protocol = SMB3
restrict anonymous = 2

netbios name = ${process.env.HOSTNAME}
server string = ${process.env.HOSTNAME}
guest account = ${guestUser}
browse list = ${config.visible && 'yes' || 'no'}
workgroup = ${config.workgroup || 'WORKGROUP'}
smb encrypt = ${config.encryption === undefined ? 'default' : (config.encryption && 'default' || 'off') }

[ipc$]
path = "/dev/null"
available = no
`)

const nginxGuestWriteHandler = createWriteStream('/etc/nginx/nginx.conf')

function exec(cmd, args = [], input) {
    const {status, stderr} = spawnSync(cmd, args, {input})

    if (status > 0) {
        throw new Error('Cmd ' + cmd + ' error ' + stderr)
    }
}

;(config.groups || []).forEach(group => {
    console.log('Creating group ' + group.name)
    exec('addgroup', ['-g', group.id, '-S', group.name])
})

const simpleUsersMap = {}

;(config.users || []).forEach(user => {
    const primaryGroup = user.groups && user.groups[0] ? user.groups[0] : 'nobody'
    simpleUsersMap[user.name] = primaryGroup
    const secondaryGroups = user.groups ? user.groups.slice(1) : []
    console.log('Creation user ' + user.name + ' with groups', primaryGroup, secondaryGroups)
    exec('adduser', ['-u', user.id, '-g', primaryGroup, ...secondaryGroups.length > 0 ? ['-G', secondaryGroups.join(',')] : [], user.name, '-SHD'])
    if (!user.password) {
        if (user.password !== null) {
            throw new Error('Missing password for user ' + user.name + ' or explicit null one')
        }
        user.password = Array.from(new Array(2)).map(() => Math.random().toString(36)).join('')
    }
    exec('smbpasswd', ['-s', '-a', user.name], user.password + '\n' + user.password)
})

nginxGuestWriteHandler.write(`
user ${guestUser} ${simpleUsersMap[guestUser]};

worker_processes auto;
pcre_jit on;
error_log /dev/stdout warn;
include /etc/nginx/modules/*.conf;
include /etc/nginx/conf.d/*.conf;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    server_tokens off;
    client_max_body_size 1m;
    sendfile on;
    tcp_nopush on;
    ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:2m;
    ssl_session_timeout 1h;
    ssl_session_tickets off;
    gzip_vary on;
    map $http_upgrade $connection_upgrade {
            default upgrade;
            '' close;
    }
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /dev/stdout main;

    server {
        listen 80;

        access_log /dev/stdout;
        error_log /dev/stdout info;

        client_max_body_size 0;

        root /dev/null;
`)

// htpasswd -bc /etc/nginx/htpasswd $USERNAME $PASSWORD



;(config.shares || []).forEach(storage => {
    console.log('Configuring storage ' + storage.name)

    if (!storage.channels || storage.channels.length === 0) {
        return
    }
    if (storage.channels.includes('smb')) {


        let tmpl = '['+storage.name+']\n'
        tmpl += 'path = "' + storage.path + '"\n'

        let caracts = {
            'available': 'no',
            'guest ok': 'no',
            'browseable': 'no',
            'writable': 'no',
            'valid users': [], //'me'
            'write list': [], // ['me', '@family']
            'vfs objects': [],
            'create mask': '0640',
            'directory mask': '0750',
            'force create mode': null,
            'force directory mode': null
        }

        if (storage.visible) {
            caracts['browseable'] = true
        }

        ;(storage.permissions || []).forEach(permission => {
            if (permission.guest) {
                if (permission.mode === 'rw') {
                    throw new Error('Guest RW not implemented')
                }

                caracts.available = 'yes'
                caracts['guest ok'] = 'yes'
            }

            ;(permission.users || []).forEach(user => {
                caracts.available = 'yes'
                caracts['valid users'].push(user)
                if (permission.mode === 'rw') {
                    caracts['write list'].push(user)
                }
            })

            ;(permission.groups || []).forEach(group => {
                caracts.available = 'yes'
                caracts['valid users'].push('@' + group)
                if (permission.mode === 'rw') {
                    caracts['write list'].push('@' + group)
                }
            })
        })

        if (caracts['guest ok'] === 'yes' && caracts['valid users'].length === 0) {
            caracts['guest only'] = 'yes'
        }

        if (storage.uMasks) {
            if (storage.uMasks.allowedForFiles) {
                caracts['create mask'] = storage.uMasks.allowedForFiles
            }

            if (storage.uMasks.allowedForDirs) {
                caracts['directory mask'] = storage.uMasks.allowedForDirs
            }

            if (storage.uMasks.forcedForFiles) {
                caracts['force create mode'] = storage.uMasks.forcedForFiles
            }

            if (storage.uMasks.forcedForDirs) {
                caracts['force directory mode'] = storage.uMasks.forcedForDirs
            }
        }

        if (storage.recycle !== false) {
            caracts['vfs objects'].push('recycle')
            const recycleConf = storage.recycle === true ? {} : storage.recycle
            const recycleCaracts = {
                'recycle:repository': recycleConf.path || '.bin',
                'recycle:keeptree': 'yes',
                'recycle:versions': 'yes',
                'recycle:directory_mode': storage.uMasks?.recycleDir || '0750'
                //; recycle:subdir_mode = xxx
            }

            caracts = {...caracts, ...recycleCaracts}
        }

        tmpl += Object.keys(caracts)
        .filter(cName => Array.isArray(caracts[cName]) ? caracts[cName].length > 0 : caracts[cName] !== null)
        .map(cName => cName + ' = ' + (Array.isArray(caracts[cName]) ? caracts[cName].join(',') : caracts[cName])).join('\n')

        writeHandler.write('\n' + tmpl + '\n')
    }

    if (storage.channels.includes('webdav')) {
        const hasGuestPerm = storage.permissions.some(p => p.guest)

        if (hasGuestPerm) {
            nginxGuestWriteHandler.write(`

                    location /${storage.name} {
                        # create_full_put_path on;
                        autoindex on;
                        autoindex_exact_size off;
                        autoindex_localtime on;
                        charset utf-8;

                        #dav_methods PUT DELETE MKCOL COPY MOVE;
                        dav_ext_methods PROPFIND OPTIONS;
                        #dav_access user:rw group:rw all:rw;

                        # auth_basic "Restricted";
                        # auth_basic_user_file /etc/nginx/htpasswd;

                        root ${storage.path};
                        rewrite ^/${storage.name}/(.*)$ /$1 break;
                    }
            `)
        }
    }
})

writeHandler.close()
// Yes, it's shitty code ; I would like to throw stones on me
nginxGuestWriteHandler.write(`
    }
}
`)