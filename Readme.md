<p align="center">
    <img height="300" src="https://raw.githubusercontent.com/gallolabs/NAS/main/logo_w300.jpeg">
  <h1 align="center">Gallo NAS</h1>
</p>

## Protocols
- [X] SMB (samba)
- [x] webdav (only for guest). Others have to be implemented with dedicated nginx by user + reverse proxy, and see for recycle
- [ ] SFTP ; note that is oriented user, not share. Maybe use lns to simulate shares.
- [ ] FTP

This is a simple app for my needs, that can be improved.

## What misses (except protocols)

- schema check
- Galloapp integration to add various config inputs and metrics (on loggings for example)
- refactory
- support container restart
- ensure to deactivate all unused resources by security
- use supervisor or equiv to handle various processes

## Example of use

See docker-compose.yml. The config example :

```json
{
  "groups": [
      {
          "name": "family",
          "id": 1100
      }
  ],
  "users": [
      {
          "name": "me",
          "id": "1001",
          "groups": ["family"],
          "password": "myself"
      },
      {
          "name": "spouse",
          "id": "1002",
          "groups": ["family"],
          "password": "heshe"
      },
      {
          "name": "anybody",
          "id": "1003"
      }
  ],
  "guestUser": "anybody",
  "shares": [
      {
          "channels": ["smb", "webdav"],
          "name": "music",
          "path": "/mnt/toto",
          "uMasks": {
            "allowedForFiles": "0660",
            "allowedForDirs": "0770",
            "forcedForFiles": "0660",
            "forcedForDirs": "0770",
            "recycleDir": "0770"
          },
          "recycle": true,
          "permissions": [
              {
                  "mode": "rw",
                  "users": ["me"],
                  "groups": ["family"]
              },
              {
                  "mode": "ro",
                  "guest": true
              }
          ]
      }
  ]
}
```

No Linux ACL are changed, this is an intrusive behavior. Ensure your storages root directories have the good uid/guid/ACL and your configuration is logic.
