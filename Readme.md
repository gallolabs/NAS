<p align="center">
    <img height="300" src="https://raw.githubusercontent.com/gallolabs/NAS/main/logo_w300.jpeg">
  <h1 align="center">Gallo NAS</h1>
</p>

Only SMBD has been implemented. Webdav and others protocols can be added.

This is a simple app for my needs, that can be improved.

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
  "storages": [
      {
          "name": "music",
          "path": "/toto",
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

No Linux ACL are set. Ensure your storages root directories have the good uid/guid/ACL and your configuration is logic.

## Next steps

- Integrate Gallolabs app to accepts various formats
- Also by this integration emits metrics, particulary about auth
- 
