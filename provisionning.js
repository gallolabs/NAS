import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'fs'

const config = JSON.parse(process.env.CONFIG)
const writeHandler = createWriteStream(process.env.CONFIG_FILE, {flags: 'a'})

writeHandler.write(`
netbios name = ${process.env.HOSTNAME}
server string = ${process.env.HOSTNAME}
browse list = no

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
	exec('adduser', ['-u', user.id, '-G', user.groups[0], user.name, '-SHD'])
	exec('smbpasswd', ['-s', '-a', user.name], user.password + '\n' + user.password)
})

;(config.storages || []).forEach(storage => {
	console.log('Configuring storage ' + storage.name)
	let tmpl = '['+storage.name+']\n'
	tmpl += 'path = "' + storage.path + '"\n'

	const caracts = {
		'available': 'no',
		'guest ok': 'no',
		'browseable': 'no',
		'writable': 'no',
		'valid users': [], //'me'
		'write list': [] // ['me', '@family']
	}

	;(storage.permissions || []).forEach(permission => {
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

	tmpl += Object.keys(caracts)
	.filter(cName => Array.isArray(caracts[cName]) ? caracts[cName].length > 0 : caracts[cName] !== null)
	.map(cName => cName + ' = ' + (Array.isArray(caracts[cName]) ? caracts[cName].join(',') : caracts[cName])).join('\n')

	writeHandler.write('\n' + tmpl + '\n')
})

writeHandler.close()