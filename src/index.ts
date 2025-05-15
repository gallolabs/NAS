// @//ts-nocheck
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync/*, existsSync*/ } from 'fs'
import {hostname as getHostname} from 'os'
import {omit, flatten, uniq} from 'lodash-es'
import { once } from 'node:events'

function exec(cmd: string, args: string[] = [], input?: any) {
    const {status, stderr} = spawnSync(cmd, args, {input})

    if (status === null || status > 0) {
        throw new Error('Cmd ' + cmd + ' error ' + stderr)
    }
}

interface UserConfig {
  groups: Array<{
      name: string
      id: number
  }>
  guestUser?: string
  users: Array<{
      name: string,
      id: number,
      groups?: string[],
      password?: string
  }>
  shares: Array<{
      channels: Array<"smb" | "webdav" | "ftp" | "sftp" | "nfs">
      name: string
      path: string
      visible?: boolean
      uMasks?: {
        allowedForFiles: string
        allowedForDirs: string
        forcedForFiles: string
        forcedForDirs: string
        recycleDir: string
      },
      recycle?: boolean | { path?: boolean }
      permissions: Array<{
          mode: string
          users?: string[]
          groups?: string[]
          guest?: boolean
      }>
  }>
  visible?: boolean
  workgroup?: string
  encryption?: boolean
}

const config: UserConfig = JSON.parse(process.env.CONFIG || '')
const hostname = getHostname()

interface CreateGroupPlanItem {
    action: 'createGroup'
    name: string
    id: number
}

interface CreateUserPlanItem {
    action: 'createUser'
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

type PlanItem = CreateGroupPlanItem
    | CreateUserPlanItem
    | DefineGuestUserPlanItem
    | ConfigureSmbChannelPlanItem
    | StartAndMonitorSmbChannelPlanItem


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

    if (guestUser && guestUser !== 'anybody' && !users.some(user => user.name === guestUser)) {
        //try {
        //    exec('id', [guestUser])
        //} catch (cause) {
        throw new Error(`Invalid guest user ${guestUser}`/*, {cause}*/)
        //}
    }

    plan.push({
        action: 'defineGuestUser',
        guestUser: guestUser || 'anybody'
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

        if (channelName !== 'smb') {
            continue
        }

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
        if (channelName !== 'smb') {
            continue
        }
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
    createUser(item: CreateUserPlanItem) {
        const user = omit(item, 'action')

        console.log('Creating user ' + user.name + ' with groups', user.primaryGroup, user.secondaryGroups)

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

        console.log('Creating group ' + group.name)
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
min protocol = SMB3
restrict anonymous = 2

netbios name = ${hostname}
server string = ${hostname}
guest account = ${state.guestUser}
browse list = ${config.visible && 'yes' || 'no'}
workgroup = ${config.workgroup || 'WORKGROUP'}
smb encrypt = ${config.encryption === undefined ? 'default' : (config.encryption && 'default' || 'off') }

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

            if (storage.recycle !== false) {
                caracts['vfs objects'].push('recycle')
                const recycleConf = storage.recycle === true ? {} : storage.recycle
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
            console.log('data from nmdb', data.toString())
        })


        nmdb.stderr.on('data', (data) => {
            console.log('data from nmdb', data.toString())
        })
        nmdb.on('error', (code) => {
            console.log('nmdb ended ' + code)
        })

        await once(nmdb, 'exit')

        const smbd = spawn('smbd', ['--debug-stdout', '-F', '--no-process-group', '--configfile=/etc/samba/smb.conf'], {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        smbd.stdout.on('data', (rawData) => {
            const data: string = rawData.toString().trim()
            console.log('data stdout from smbd', data)

            if (data.startsWith('{') && data.endsWith('}')) {
                const parsed = JSON.parse(data)

                if (parsed.type === 'Authentication') {
                    const success = parsed.Authentication.status === 'NT_STATUS_OK'
                    console.log('Increment SMB auth ; success ?', success)
                }
            }
        })


        smbd.stderr.on('data', (data) => {
            console.log('data err from smbd', data.toString())
        })
        smbd.on('error', (code) => {
            console.log('smbd ended ' + code)
        })


        smbd.on('close', (code) => {
            console.log('smbd ended ' + code)
        })


        // await setTimeout(10000)


        // const tail = spawn('tail', ['-q', '-n', '+1', '-F', '/var/log/samba/log.smbd'])

        // tail.stdout.on('data', (data) => {
        //     console.log('data from tail', data.toString())
        // })


        // tail.stderr.on('data', (data) => {
        //     console.log('data from tail', data.toString())
        // })
        // tail.on('error', (code) => {
        //     console.log('Tail ended ' + code)
        // })


        // tail.on('exit', (code) => {
        //     console.log('Tail ended ' + code)
        // })

        console.log('started')
    }
}

async function runPlan(plan: PlanItem[]) {
    for(const planItem of plan) {
        // @ts-ignore
        await planRunDef[planItem.action](planItem)
    }
}

const plan = computePlan(config)
console.log(plan)
await runPlan(plan)
console.log(state)






















// const nginxGuestWriteHandler = createWriteStream('/etc/nginx/nginx.conf')
// const ftpdWriteHandler = createWriteStream('/etc/vsftpd/vsftpd.conf')
// const sftpWriteHandler = createWriteStream('/etc/ssh/sshd_config')
// const nfsWriteHandler = createWriteStream('/etc/exports')


// nginxGuestWriteHandler.write(`
// user ${guestUser} ${simpleUsersMap[guestUser]};
// error_log /var/log/nginx/error.log warn;
// worker_processes auto;
// pcre_jit on;
// include /etc/nginx/modules/*.conf;
// include /etc/nginx/conf.d/*.conf;

// events {
//     worker_connections 1024;
// }

// http {
//     include /etc/nginx/mime.types;
//     default_type application/octet-stream;
//     server_tokens off;
//     client_max_body_size 1m;
//     sendfile on;
//     tcp_nopush on;
//     ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;
//     ssl_prefer_server_ciphers on;
//     ssl_session_cache shared:SSL:2m;
//     ssl_session_timeout 1h;
//     ssl_session_tickets off;
//     gzip_vary on;
//     map $http_upgrade $connection_upgrade {
//             default upgrade;
//             '' close;
//     }
//     log_format main '$remote_addr - $remote_user [$time_local] "$request" '
//                     '$status $body_bytes_sent "$http_referer" '
//                     '"$http_user_agent" "$http_x_forwarded_for"';

//     # access_log /dev/stdout main;

//     server {
//         listen 80;
//         client_max_body_size 0;
//         charset utf-8;
//         # root /dev/null;
//         root /home/${guestUser};

//         fancyindex on;
//         fancyindex_show_dotfiles on;
// `)

// // htpasswd -bc /etc/nginx/htpasswd $USERNAME $PASSWORD

// ;(config.shares || []).forEach(storage => {
//     console.log('Configuring storage ' + storage.name)

//     if (!storage.channels || storage.channels.length === 0) {
//         return
//     }


//     if (storage.channels.includes('webdav')) {
//         const hasGuestPerm = storage.permissions.some(p => p.guest)

//         if (hasGuestPerm) {
//             nginxGuestWriteHandler.write(`

//                     location /${storage.name} {
//                         # create_full_put_path on;

//                         #dav_methods PUT DELETE MKCOL COPY MOVE;
//                         dav_ext_methods PROPFIND OPTIONS;
//                         #dav_access user:rw group:rw all:rw;

//                         # auth_basic "Restricted";
//                         # auth_basic_user_file /etc/nginx/htpasswd;

//                         root ${storage.path};
//                         rewrite ^/${storage.name}/(.*)$ /$1 break;
//                     }
//             `)
//         }
//     }

//     if (storage.channels.includes('ftp')) {
//         const hasGuestPerm = storage.permissions.some(p => p.guest)

//         if (hasGuestPerm) {
//             ftpdWriteHandler.write(`
//                 listen=YES
//                 anonymous_enable=YES
//                 anon_upload_enable=NO
//                 anon_mkdir_write_enable=NO
//                 anon_other_write_enable=NO
//                 anon_world_readable_only=YES
//                 anon_root=/home/${guestUser}
//                 setproctitle_enable=YES
//                 seccomp_sandbox=NO
//                 vsftpd_log_file=/var/log/sftpd.log
//                 ftp_username=${guestUser}
//                 guest_username=${guestUser}
//                 dual_log_enable=YES
//                 no_anon_password=Yes
//                 log_ftp_protocol=NO
//                 pasv_address=172.25.217.80
//                 pasv_min_port=2042
//                 pasv_max_port=2045
//                 force_dot_files=YES
//             `)
//         }

//         mkdirSync(`/home/${guestUser}/${storage.name}`)
//         exec('mount', ['--bind', storage.path, `/home/${guestUser}/${storage.name}`])
//     }

//     if (storage.channels.includes('sftp')) {

//         const hasGuestPerm = storage.permissions.some(p => p.guest)

//         if (hasGuestPerm) {

//             if (!existsSync('/var/lib/nas/ssh')) {
//                 mkdirSync('/var/lib/nas/ssh')
//                 exec('sh', ['-c', "ssh-keygen -t ed25519 -f /var/lib/nas/ssh/ssh_host_ed25519_key -N '' && chmod 600 /var/lib/nas/ssh/ssh_host_ed25519_key"])
//                 exec('sh', ['-c', "ssh-keygen -t rsa -b 4096 -f /var/lib/nas/ssh/ssh_host_rsa_key -N '' && chmod 600 /var/lib/nas/ssh/ssh_host_rsa_key"])
//             }

//             sftpWriteHandler.write(`
//                 Protocol 2
//                 HostKey /var/lib/nas/ssh/ssh_host_ed25519_key
//                 HostKey /var/lib/nas/ssh/ssh_host_rsa_key
//                 Port 22
//                 PermitRootLogin no
//                 X11Forwarding no
//                 AllowTcpForwarding no
//                 UseDNS no
//                 AllowUsers ${guestUser}

//                 Subsystem sftp internal-sftp
//                 ForceCommand internal-sftp
//                 ChrootDirectory %h
//                 PermitEmptyPasswords yes
//             `)
//         }
//         // exec('sh', ['-c', 'echo ssh >> /etc/securetty'])
//     }

//     if (storage.channels.includes('nfs')) {

//         const hasGuestPerm = storage.permissions.some(p => p.guest)

//         if (hasGuestPerm) {

//             nfsWriteHandler.write(`
//                 ${storage.path} *(ro,no_subtree_check)
//             `)

//         }
//     }

// })


// // Yes, it's shitty code ; I would like to throw stones on me
// nginxGuestWriteHandler.write(`
//     }
// }
// `)
// nginxGuestWriteHandler.close()
// ftpdWriteHandler.close()
// nfsWriteHandler.close()