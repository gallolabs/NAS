import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'fs'

const config = JSON.parse(process.env.CONFIG)
const writeHandler = createWriteStream(process.env.CONFIG_FILE, {flags: 'a'})

writeHandler.write(`
netbios name = ${process.env.HOSTNAME}
server string = ${process.env.HOSTNAME}
guest account = ${config.guestUser || 'nobody'}
browse list = ${config.visible || 'no'}
workgroup = ${config.workgroup || 'WORKGROUP'}

[ipc$]
path = "/dev/null"
available = no
`)

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

;(config.users || []).forEach(user => {
    console.log('Creation user ' + user.name)
    const primaryGroup = user.groups && user.groups[0] ? user.groups[0] : 'nobody'
    const secondaryGroups = user.groups ? user.groups.slice(1) : []
    exec('adduser', ['-u', user.id, '-g', user.groups ? user.groups[0] || 'nobody' : 'nobody', ...secondaryGroups && ['-G', secondaryGroups.join(',')], user.name, '-SHD'])
    if (!user.password) {
        if (user.password !== null) {
            throw new Error('Missing password for user ' + user.name + ' or explicit null one')
        }
        user.password = Array.from(new Array(2)).map(() => Math.random().toString(36)).join('')
    }
    exec('smbpasswd', ['-s', '-a', user.name], user.password + '\n' + user.password)
})

;(config.storages || []).forEach(storage => {
    console.log('Configuring storage ' + storage.name)
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
})

writeHandler.close()