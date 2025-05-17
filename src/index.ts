// @//ts-nocheck
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync/*, existsSync*/ } from 'fs'
import {hostname as getHostname} from 'os'
import {omit, flatten, uniq} from 'lodash-es'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { Type, Static } from '@sinclair/typebox'

const volumePath = '/var/lib/nas'

const logger = {
    info(msg: string, metadata?: any) {
        console.log(JSON.stringify({message: msg, ...metadata}))
    }
}

function exec(cmd: string, args: string[] = [], input?: any) {
    const {status, stderr} = spawnSync(cmd, args, {input})

    if (status === null || status > 0) {
        throw new Error('Cmd ' + cmd + ' error ' + stderr)
    }
}

const userConfigSchema = Type.Object({
    guestUser: Type.Optional(Type.String()),
    groups: Type.Array(Type.Object({
        name: Type.String(),
        id: Type.Number()
    })),
    users: Type.Array(Type.Object({
        name: Type.String(),
        id: Type.Number(),
        groups: Type.Optional(Type.Array(Type.String())),
        password: Type.Optional(Type.String())
    })),
    smbOpts: Type.Optional(Type.Object({
        visible: Type.Optional(Type.Boolean()),
        encryption: Type.Optional(Type.Boolean())
    })),
    workgroup: Type.Optional(Type.String()),
    encryption: Type.Optional(Type.Boolean()),
    shares: Type.Array(Type.Object({
        channels: Type.Array(Type.Union([
            Type.Literal('smb'),
            Type.Literal('webdav'),
            Type.Literal('ftp'),
            Type.Literal('sftp'),
            Type.Literal('nfs')
        ])),
        name: Type.String(),
        path: Type.String(),
        visible: Type.Optional(Type.Boolean()),
        uMasks: Type.Optional(Type.Object({
            allowedForFiles: Type.String(),
            allowedForDirs: Type.String(),
            forcedForFiles: Type.String(),
            forcedForDirs: Type.String(),
            recycleDir: Type.String(),
        })),
        permissions: Type.Array(Type.Object({
            mode: Type.String(),
            users: Type.Optional(Type.Array(Type.String())),
            groups: Type.Optional(Type.Array(Type.String())),
            guest: Type.Optional(Type.Boolean())
        })),
        smbOpts: Type.Optional(Type.Object({
            recycle: Type.Optional(Type.Union([
                Type.Boolean(),
                Type.Object({
                    path: Type.Optional(Type.String())
                })
            ]))
        }))
    }))
})

type UserConfig = Static<typeof userConfigSchema>

const config: UserConfig = JSON.parse(process.env.CONFIG || '')
const hostname = getHostname()

interface CreateGroupPlanItem {
    action: 'createGroup'
    name: string
    id: number
}

interface CreateUserPlanItem extends Omit<RegisterUserPlanItem, 'action'> {
    action: 'createUser'
}

interface RegisterUserPlanItem {
    action: 'registerUser'
    name: string
    id: number
    primaryGroup: string
    secondaryGroups: string[]
    password: string | null
}

interface DefineGuestUserPlanItem {
    action: 'defineGuestUser'
    guestUser: string
}

interface ConfigureSmbChannelPlanItem {
    action: 'configureSmbChannel'
    shares: UserConfig['shares']
}

interface StartAndMonitorSmbChannelPlanItem {
    action: 'startAndMonitorSmbChannel'
}

interface ConfigureWebdavChannelPlanItem {
    action: 'configureWebdavChannel'
    shares: UserConfig['shares']
}

interface StartAndMonitorWebdavChannelPlanItem {
    action: 'startAndMonitorWebdavChannel'
}

interface ConfigureFtpChannelPlanItem {
    action: 'configureFtpChannel'
    shares: UserConfig['shares']
}

interface ConfigureSftpChannelPlanItem {
    action: 'configureSftpChannel'
    shares: UserConfig['shares']
}

interface ConfigureNfsChannelPlanItem {
    action: 'configureNfsChannel'
    shares: UserConfig['shares']
}

type PlanItem = CreateGroupPlanItem
    | CreateUserPlanItem
    | DefineGuestUserPlanItem
    | ConfigureSmbChannelPlanItem
    | StartAndMonitorSmbChannelPlanItem
    | RegisterUserPlanItem
    | ConfigureWebdavChannelPlanItem
    | StartAndMonitorWebdavChannelPlanItem
    | ConfigureSftpChannelPlanItem
    | ConfigureFtpChannelPlanItem
    | ConfigureNfsChannelPlanItem


// Define a plan of execution and state
function computePlan({groups, users, guestUser, shares}: UserConfig) {

    const plan: PlanItem[] = []

    for (const group of groups) {
        plan.push({
            action: 'createGroup',
            ...group
        })
    }

    for (const user of users) {
        (user.groups || []).forEach(groupName => {
            if (!groups.some(group => group.name === groupName)) {
                throw new Error(`Unknown group ${groupName} for user ${user.name}`)
            }
        })

        plan.push({
            action: 'createUser',
            ...user,
            primaryGroup: user.groups && user.groups.length > 0 ? user.groups[0]: 'nobody',
            secondaryGroups: user.groups ? user.groups.slice(1) : [],
            password: user.password || null
        })
    }

    if (!guestUser) {
        guestUser = 'nobody'
    }

    if (guestUser !== 'nobody' && !users.some(user => user.name === guestUser)) {
        //try {
        //    exec('id', [guestUser])
        //} catch (cause) {
        throw new Error(`Invalid guest user ${guestUser}`/*, {cause}*/)
        //}
    }

    if (guestUser === 'nobody') {
        plan.push({
            action: 'registerUser',
            name: 'nobody',
            id: 65534,
            primaryGroup: 'nobody',
            secondaryGroups: [],
            password: null
        })
    }

    plan.push({
        action: 'defineGuestUser',
        guestUser: guestUser
    })

    for (const share of shares) {
        share.permissions.forEach(permission => {
            (permission.users || []).forEach(userName => {
                if (userName !== guestUser && !users.some(user => user.name === userName)) {
                    throw new Error(`Unknown user ${userName} in share ${share.name}`)
                }
            })
            ;(permission.groups || []).forEach(groupName => {
                if (!groups.some(group => group.name === groupName)) {
                    throw new Error(`Unknown group ${groupName} in share ${share.name}`)
                }
            })
        })
    }

    const channelsInfos: Record<string, {suffix: string, needHomeMount: boolean}> = {
        "smb": {
            suffix: 'Smb',
            needHomeMount: false
        },
        "webdav": {
            suffix: "Webdav",
            needHomeMount: false
        },
        "ftp": {
            suffix: 'Ftp',
            needHomeMount: true
        },
        "sftp": {
            suffix: 'Sftp',
            needHomeMount: true
        },
        "nfs": {
            suffix: 'Nfs',
            needHomeMount: false
        }
    }

    const sharesByChannels: Record<string, UserConfig['shares']> = Object.keys(channelsInfos).reduce((reduced, channelName) => {
        const sharesForChannel = shares.filter(share => (share.channels as string[]).includes(channelName))

        return {...reduced, ...sharesForChannel.length > 0 && {[channelName]: sharesForChannel}}
    }, {})

    for (const channelName in sharesByChannels) {
        const channelInfos = channelsInfos[channelName]
        const sharesForChannel = sharesByChannels[channelName]

        // if (channelInfos.needHomeMount) {
        //     sharesForChannel.forEach(share => {
        //         share.permissions.forEach(permission => {

        //         })
        //     })
        //     plan.push({
        //         action: 'mountShareForUser',

        //     })
        // }

        plan.push({
            action: `configure${channelInfos.suffix}Channel` as string,
            shares: sharesForChannel
        } as ConfigureSmbChannelPlanItem)
    }

    for (const channelName in sharesByChannels) {
        const channelInfos = channelsInfos[channelName]

        plan.push({
            action: `startAndMonitor${channelInfos.suffix}Channel` as string
        } as StartAndMonitorSmbChannelPlanItem)
    }

    return plan
}

interface State {
    groups: Omit<CreateGroupPlanItem, 'action'>[]
    users: Omit<CreateUserPlanItem, 'action'>[]
    guestUser: string | null
}

const state: State = {
    groups: [],
    users: [],
    guestUser: null
}

const planRunDef = {
    registerUser(item: RegisterUserPlanItem) {
        const user = omit(item, 'action')
        logger.info('Registering user ' + user.name + ' with groups ' + user.primaryGroup + ' ; ' + user.secondaryGroups)
        state.users.push(user)
    },
    createUser(item: CreateUserPlanItem) {
        const user = omit(item, 'action')

        logger.info('Creating user ' + user.name + ' with groups ' + user.primaryGroup + ' ; ' + user.secondaryGroups)

        exec('adduser', [
            '-u', user.id.toString(),
            '-g', user.primaryGroup,
            ...user.secondaryGroups.length > 0 ? ['-G', user.secondaryGroups.join(',')] : [],
            user.name,
            '-SHD'
        ])

        mkdirSync('/home/' + user.name)

        if (!user.password) {
            exec('passwd', ['-d', user.name])
        } else {
            exec('passwd', [user.name], user.password + '\n' + user.password)
        }

        state.users.push(user)
    },
    createGroup(item: CreateGroupPlanItem) {
        const group = omit(item, 'action')

        logger.info('Creating group ' + group.name)
        exec('addgroup', ['-g', group.id.toString(), '-S', group.name])

        state.groups.push(group)
    },
    defineGuestUser(item: DefineGuestUserPlanItem) {
        state.guestUser = item.guestUser
    },
    configureSmbChannel(item: ConfigureSmbChannelPlanItem) {
        const allUsersNames = uniq(flatten(flatten(item.shares.map(share => share.permissions.map(perm => perm.users || [])))))

        allUsersNames.forEach(userName => {
            const user = state.users.find(user => user.name === userName)!
            exec('smbpasswd', ['-s', '-a', user.name], user.password + '\n' + user.password)
        })

        const writeHandler = createWriteStream('/etc/samba/smb.conf')

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
            min protocol = SMB2
            restrict anonymous = 2

            netbios name = ${hostname}
            server string = ${hostname}
            guest account = ${state.guestUser}
            browse list = ${config.smbOpts?.visible && 'yes' || 'no'}
            workgroup = ${config.workgroup || 'WORKGROUP'}
            smb encrypt = ${config.smbOpts?.encryption === undefined ? 'default' : (config.smbOpts?.encryption && 'default' || 'off') }

            [ipc$]
            path = "/dev/null"
            available = no
        `)

        for(const storage of item.shares) {
            let tmpl = '['+storage.name+']\n'
            tmpl += 'path = "' + storage.path + '"\n'

            let caracts = {
                'available': 'no',
                'guest ok': 'no',
                'browseable': 'no',
                'writable': 'no',
                'valid users': [] as string[], //'me'
                'write list': [] as string[], // ['me', '@family']
                'vfs objects': [] as string[],
                'create mask': '0640',
                'directory mask': '0750',
                'force create mode': null as null | string,
                'force directory mode': null as null | string,
                'guest only': null as null | string
            }

            if (storage.visible) {
                caracts['browseable'] = 'yes'
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

            if (storage.smbOpts?.recycle !== false) {
                caracts['vfs objects'].push('recycle')
                const recycleConf = storage.smbOpts?.recycle === true ? {} : storage.smbOpts?.recycle
                const recycleCaracts = {
                    'recycle:repository': recycleConf?.path || '.bin',
                    'recycle:keeptree': 'yes',
                    'recycle:versions': 'yes',
                    'recycle:directory_mode': storage.uMasks?.recycleDir || '0750'
                    //; recycle:subdir_mode = xxx
                }

                caracts = {...caracts, ...recycleCaracts}
            }

            tmpl += Object.keys(caracts)
            // @ts-ignore
            .filter(cName => Array.isArray(caracts[cName]) ? caracts[cName].length > 0 : caracts[cName] !== null)
            // @ts-ignore
            .map(cName => cName + ' = ' + (Array.isArray(caracts[cName]) ? caracts[cName].join(',') : caracts[cName])).join('\n')

            writeHandler.write('\n' + tmpl + '\n')
        }

        writeHandler.close()
    },
    async startAndMonitorSmbChannel(_item: StartAndMonitorSmbChannelPlanItem) {
        const nmdb = spawn('nmbd', ['-D'])

        nmdb.stdout.on('data', (data) => {
            logger.info(data.toString(), {channel: 'smb'})
        })

        nmdb.stderr.on('data', (data) => {
            logger.info(data.toString(), {channel: 'smb'})
        })
        nmdb.on('error', (code) => {
            logger.info('nmdb ended ' + code, {channel: 'smb'})
        })

        await once(nmdb, 'exit')

        const smbd = spawn('smbd', ['--debug-stdout', '-F', '--no-process-group', '--configfile=/etc/samba/smb.conf'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        smbd.stdout.on('data', (rawData) => {
            const data: string = rawData.toString().trim()
            if (data.includes('ipc$')) {
                return
            }

            logger.info(data, {channel: 'smb'})

            if (data.startsWith('{') && data.endsWith('}')) {
                const parsed = JSON.parse(data)

                if (parsed.type === 'Authentication') {
                    const success = parsed.Authentication.status === 'NT_STATUS_OK'
                    logger.info('Increment SMB auth ; success ? ' + success, {channel: 'smb'})
                }
            }
        })

        smbd.stderr.on('data', (data) => {
            logger.info(data.toString(), {channel: 'smb'})
        })
        smbd.on('error', (code) => {
            logger.info('smbd ended ' + code, {channel: 'smb'})
        })

        smbd.on('close', (code) => {
            logger.info('smbd ended ' + code, {channel: 'smb'})
        })

        logger.info('Samba started')
    },
    configureWebdavChannel(item: ConfigureWebdavChannelPlanItem) {
        const nginxGuestWriteHandler = createWriteStream('/etc/nginx/nginx.conf')

        const guestGroup = state.users.find(user => user.name === state.guestUser)!.primaryGroup

        if (!existsSync(volumePath + '/webdav/ssl')) {
            mkdirSync(volumePath + '/webdav/ssl', {recursive: true})
            exec('openssl', [
                'req', '-x509', '-nodes', '-days', '365',
                '-subj', '/C=CA/ST=QC/O=Gallonas Inc/CN=localhost',
                '-newkey', 'rsa:2048',
                '-keyout', volumePath + '/webdav/ssl/nginx.key',
                '-out', volumePath + '/webdav/ssl/nginx.crt'
            ])
            exec('chmod', ['-R', 'o-rwx,g-rwx', volumePath + '/webdav/ssl'])
        }

        nginxGuestWriteHandler.write(`
        user ${state.guestUser} ${guestGroup};
        error_log /var/log/nginx/error.log warn;
        worker_processes auto;
        pcre_jit on;
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

            # access_log /dev/stdout main;

            server {
                server_name localhost;
                listen 80;
                listen              443 ssl;

                ssl_certificate     ${volumePath}/webdav/ssl/nginx.crt;
                ssl_certificate_key ${volumePath}/webdav/ssl/nginx.key;

                client_max_body_size 0;
                charset utf-8;
                # root /dev/null;
                root /home/${state.guestUser};

                fancyindex on;
                fancyindex_show_dotfiles on;
        `)
// // htpasswd -bc /etc/nginx/htpasswd $USERNAME $PASSWORD

        for (const storage of item.shares) {
            const hasGuestPerm = storage.permissions.some(p => p.guest)

            if (hasGuestPerm) {
                nginxGuestWriteHandler.write(`

                    location /${storage.name} {
                        # create_full_put_path on;

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

        // Yes, it's shitty code ; I would like to throw stones to me
        nginxGuestWriteHandler.write(`
            }
        }
        `)
        nginxGuestWriteHandler.close()
    },
    startAndMonitorWebdavChannel(_item: StartAndMonitorWebdavChannelPlanItem) {
        exec('touch', ['/var/log/nginx/error.log', '/var/log/nginx/access.log'])
        const nginx = spawn('nginx', ['-c', '/etc/nginx/nginx.conf', '-g', 'daemon off;'],{
            stdio: ['ignore', 'pipe', 'pipe']
        })

        nginx.stdout.on('data', (data) => {
            logger.info(data.toString(), {channel: 'webdav'})
        })


        nginx.stderr.on('data', (data) => {
            logger.info(data.toString(), {channel: 'webdav'})
        })
        nginx.on('error', (code) => {
            logger.info('nginx ended ' + code, {channel: 'webdav'})
        })

        const tail = spawn('tail', ['-q', '-n', '+1', '-F', '/var/log/nginx/*.log'],{
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true
        })

        tail.stdout.on('data', (data) => {
            logger.info(data.toString(), {channel: 'webdav'})
        })


        tail.stderr.on('data', (data) => {
            logger.info(data.toString(), {channel: 'webdav'})
        })
        tail.on('error', (code) => {
            logger.info('Nginx Tail ended ' + code, {channel: 'webdav'})
        })


        tail.on('exit', (code) => {
            logger.info('Nginx Tail ended ' + code, {channel: 'webdav'})
        })

        logger.info('Nginx started')

    },
    configureFtpChannel(item: ConfigureFtpChannelPlanItem) {
        const ftpdWriteHandler = createWriteStream('/etc/vsftpd/vsftpd.conf')

        if (!existsSync(volumePath + '/ftp/ssl')) {
            mkdirSync(volumePath + '/ftp/ssl', {recursive: true})
            exec('openssl', [
                'req', '-new', '-x509', '-days', '365', '-nodes',
                                '-subj', '/C=CA/ST=QC/O=Gallonas Inc/CN=localhost',
                '-out', volumePath + '/ftp/ssl/vsftpd.crt.pem',
                '-keyout', volumePath + '/ftp/ssl/vsftpd.key.pem'
            ])
            exec('chmod', ['-R', 'o-rwx,g-rwx', volumePath + '/ftp/ssl'])
        }


        for (const storage of item.shares) {

            const hasGuestPerm = storage.permissions.some(p => p.guest)

            if (hasGuestPerm) {
                ftpdWriteHandler.write(`
                    listen=YES
                    anonymous_enable=YES
                    anon_upload_enable=NO
                    anon_mkdir_write_enable=NO
                    anon_other_write_enable=NO
                    anon_world_readable_only=YES
                    anon_root=/home/${state.guestUser}
                    setproctitle_enable=YES
                    seccomp_sandbox=NO
                    vsftpd_log_file=/var/log/sftpd.log
                    ftp_username=${state.guestUser}
                    guest_username=${state.guestUser}
                    dual_log_enable=YES
                    no_anon_password=Yes
                    log_ftp_protocol=NO
                    pasv_address=172.25.217.80
                    pasv_min_port=2042
                    pasv_max_port=2045
                    force_dot_files=YES
                    ssl_enable=YES
                    ssl_tlsv1=YES
                    ssl_sslv2=YES
                    ssl_sslv3=YES
                    allow_anon_ssl=YES
                    rsa_cert_file=${volumePath}/ftp/ssl/vsftpd.crt.pem
                    rsa_private_key_file=${volumePath}/ftp/ssl/vsftpd.key.pem
                `)
            }
            mkdirSync(`/home/${state.guestUser}/${storage.name}`)
            exec('mount', ['--bind', storage.path, `/home/${state.guestUser}/${storage.name}`])
        }
        ftpdWriteHandler.close()
    },
    startAndMonitorFtpChannel() {
        exec('touch', ['/var/log/sftpd.log'])
        const vsftpd = spawn('vsftpd', ['/etc/vsftpd/vsftpd.conf'],{
            stdio: ['ignore', 'pipe', 'pipe']
        })

        vsftpd.stdout.on('data', (data) => {
            logger.info(data.toString(), {channel: 'ftp'})
        })

        vsftpd.stderr.on('data', (data) => {
            logger.info(data.toString(), {channel: 'ftp'})
        })
        vsftpd.on('error', (code) => {
            logger.info('vsftpd ended ' + code, {channel: 'ftp'})
        })

        const tail = spawn('tail', ['-q', '-n', '+1', '-F', '/var/log/sftpd.log'],{
            stdio: ['ignore', 'pipe', 'pipe']
        })

        tail.stdout.on('data', (data) => {
            data.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'ftp'})
            })

            if (data.toString().includes('OK LOGIN')) {
                logger.info('Increment FTP auth ; success ? ' + true, {channel: 'ftp'})
            }
        })

        tail.stderr.on('data', (data) => {
            logger.info(data.toString(), {channel: 'ftp'})

            if (data.toString().includes('OK LOGIN')) {
                logger.info('Increment FTP auth ; success ? ' + true, {channel: 'ftp'})
            }
        })
        tail.on('error', (code) => {
            logger.info('Nginx Tail ended ' + code, {channel: 'ftp'})
        })

        tail.on('exit', (code) => {
            logger.info('Nginx Tail ended ' + code, {channel: 'ftp'})
        })

        logger.info('vsftpd started')
    },
    configureSftpChannel(item: ConfigureSftpChannelPlanItem) {
        const sftpWriteHandler = createWriteStream('/etc/ssh/sshd_config')
        for (const storage of item.shares) {
            const hasGuestPerm = storage.permissions.some(p => p.guest)

            if (hasGuestPerm) {

                if (!existsSync('/var/lib/nas/ssh')) {
                    mkdirSync('/var/lib/nas/ssh')
                    exec('sh', ['-c', "ssh-keygen -t ed25519 -f /var/lib/nas/ssh/ssh_host_ed25519_key -N '' && chmod 600 /var/lib/nas/ssh/ssh_host_ed25519_key"])
                    exec('sh', ['-c', "ssh-keygen -t rsa -b 4096 -f /var/lib/nas/ssh/ssh_host_rsa_key -N '' && chmod 600 /var/lib/nas/ssh/ssh_host_rsa_key"])
                }

                sftpWriteHandler.write(`
                    Protocol 2
                    HostKey /var/lib/nas/ssh/ssh_host_ed25519_key
                    HostKey /var/lib/nas/ssh/ssh_host_rsa_key
                    Port 22
                    PermitRootLogin no
                    X11Forwarding no
                    AllowTcpForwarding no
                    UseDNS no
                    AllowUsers ${state.guestUser}

                    Subsystem sftp internal-sftp
                    ForceCommand internal-sftp
                    ChrootDirectory %h
                    PermitEmptyPasswords yes
                `)
            }
        }
        sftpWriteHandler.close()
        // exec('sh', ['-c', 'echo ssh >> /etc/securetty'])
    },
    startAndMonitorSftpChannel() {
        exec('touch', ['/var/log/sshd.log'])

        const sshd = spawn('/usr/sbin/sshd', ['-D', '-E', '/var/log/sshd.log'],{
            stdio: ['ignore', 'pipe', 'pipe']
        })

        sshd.stdout.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'sftp'})
            })
        })

        sshd.stderr.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'sftp'})
            })
        })
        sshd.on('error', (code) => {
            logger.info('sshd ended ' + code, {channel: 'sftp'})
        })

        const tail = spawn('tail', ['-q', '-n', '+1', '-F', '/var/log/sshd.log'],{
            stdio: ['ignore', 'pipe', 'pipe']
        })

        tail.stdout.on('data', (data) => {
            data.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'sftp'})
            })

            if (data.toString().includes('Accepted none for')) {
                logger.info('Increment SFTP auth ; success ? ' + true, {channel: 'sftp'})
            }

        })

        tail.stderr.on('data', (data) => {
            data.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'sftp'})
            })

            if (data.toString().includes('Accepted none for')) {
                logger.info('Increment SFTP auth ; success ? ' + true, {channel: 'sftp'})
            }
        })
        tail.on('error', (code) => {
            logger.info('Nginx Tail ended ' + code, {channel: 'sftp'})
        })

        tail.on('exit', (code) => {
            logger.info('Nginx Tail ended ' + code, {channel: 'sftp'})
        })

        logger.info('sshd started')
    },
    configureNfsChannel(item: ConfigureNfsChannelPlanItem) {
        const nfsWriteHandler = createWriteStream('/etc/exports')
        for (const storage of item.shares) {
            const hasGuestPerm = storage.permissions.some(p => p.guest)

            if (hasGuestPerm) {

                nfsWriteHandler.write(`
                    ${storage.path} *(ro,no_subtree_check)
                `)

            }
        }
        nfsWriteHandler.close()
    },
    async startAndMonitorNfsChannel() {
        const rpcbind = spawn('rpcbind', ['-w'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        rpcbind.stdout.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        rpcbind.stderr.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        await once(rpcbind, 'exit')

        const rpcinfo = spawn('rpcinfo', {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        rpcinfo.stdout.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        rpcinfo.stderr.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        const rpcnfsd = spawn('rpc.nfsd', ['--debug', '8', '--no-udp', '-U'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        rpcnfsd.stdout.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        rpcnfsd.stderr.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        const exportfs = spawn('exportfs', ['-rv'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        exportfs.stdout.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        exportfs.stderr.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        const rpcmountd = spawn('rpc.mountd', ['--debug', 'all', '--no-udp', '--no-nfs-version', '2', '-F'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        rpcmountd.stdout.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        rpcmountd.stderr.on('data', (rawData) => {
            rawData.toString().trim().split('\n').forEach((data: string) => {
                logger.info(data, {channel: 'nfs'})
            })
        })

        logger.info('NFS started')
    }
}

async function runPlan(plan: PlanItem[]) {
    for(const planItem of plan) {
        // @ts-ignore
        await planRunDef[planItem.action](planItem)
    }
}

const plan = computePlan(config)
await runPlan(plan)
