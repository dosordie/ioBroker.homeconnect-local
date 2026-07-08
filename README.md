<p align="center">
  <img src="admin/homeconnect-local.svg" alt="Home Connect Local" width="140" />
</p>

# ioBroker HomeConnect Local Adapter

Local LAN adapter for Bosch, Siemens and other BSH Home Connect appliances.

The adapter talks to Home Connect appliances directly in the local network instead of using the Home Connect cloud API during runtime. It uses local appliance profiles containing the device key, feature mapping and device description.

> **Project status:** experimental but already usable for local monitoring and selected local control/write tests. The object schema can still change while the adapter is developed.

## Current project status

Implemented now:

- Local AES WebSocket transport: `ws://<ip>:80/homeconnect`.
- Experimental local TLS-PSK WebSocket transport: `wss://<ip>:443/homeconnect`.
- Home Connect local handshake including `/ei/initialValues`, `/ci/services`, optional authentication/info requests and RO reads.
- Profile folder scan for profile ZIP files and extracted profiles.
- Recursive profile loading and de-duplication by `haId`.
- Automatic device suggestions in the adapter config from scanned profiles.
- Device table with metadata such as type, brand, VIB, MAC, connection type and profile file.
- Cloud-adapter-like online indicator via `<device>.general.connected`.
- Dynamic state creation from `FeatureMapping.xml` and live `/ro/*` values.
- Enum translation from the downloaded device descriptions.
- Diagnostic states for appliance info, network info, service versions and registered apps/devices.
- Per-state metadata under `metadata.*` for availability, access, writability and raw data.
- Program list states under `programs.availableList` and `programs.availableJson`.
- Cloud-compatible root program states:
  - `program.RootSelectedProgram`
  - `program.RootActiveProgram`
- Basic write support through `/ro/values` using `POST`.
- Writable `settings.PowerState` where supported by the appliance.
- Dynamic writable settings/options/program states when the appliance reports `READWRITE`.
- `commands.StartProgram` and `commands.StartProgramWithOptions` for selected-program starts.
- Filtering of dangerous commands such as factory reset, network reset, Wi-Fi deactivation and software update/download commands.
- Offline handling for appliances that are only reachable when switched on, such as washer and dryer.

Known limitations:

- Still experimental and not published as a stable ioBroker adapter package.
- TLS-PSK compatibility depends on the Node/OpenSSL environment and still needs more real-device testing.
- No mDNS discovery yet; IP/hostname is configured manually.
- No direct ioBroker Files-tab profile import yet; profile ZIP files should currently be copied into a container/host folder.
- Write/control support is intentionally conservative and should be tested carefully per appliance type.
- The state schema is still evolving; deleting and recreating the device object tree may be useful after updates.

## Profile ZIP files

The adapter needs local Home Connect appliance profiles. These profiles include the PSK/key material and the XML files needed to map UIDs to readable feature names.

Use the Home Connect profile downloader project to create those files:

- https://github.com/bruestel/homeconnect-profile-downloader

Copy the generated ZIP files into a folder that is visible inside the ioBroker runtime/container. Example:

```bash
/opt/iobroker/iobroker-data/homeconnect-profiles
```

Then set this path in the adapter config as the profile folder. The adapter scans ZIP files and extracted profile folders recursively.

## Installation from GitHub

In the ioBroker admin UI use a custom GitHub installation from:

```text
dosordie/ioBroker.homeconnect-local
```

CLI alternative:

```bash
iobroker url dosordie/ioBroker.homeconnect-local --host iobroker --debug
iobroker upload homeconnect-local
iobroker restart homeconnect-local.0
```

## Configuration

Recommended workflow:

1. Generate/download profile ZIP files with `homeconnect-profile-downloader`.
2. Copy the ZIP files into the configured profile folder.
3. Start the adapter once.
4. The adapter adds discovered profiles to the device table as disabled suggestions.
5. Enter the appliance IP/hostname.
6. Enable the appliance row.
7. Save and restart the adapter.

Important config fields:

- `profilePath`: folder containing profile ZIPs or extracted profiles.
- `autoAddProfiles`: automatically add scanned profiles to the device table.
- `host`: appliance IP address or hostname.
- `enabled`: enables the appliance connection.
- `debugRaw`: writes raw UID states and detailed debug logs. Disable after testing if personal device/app names are visible.

## Object layout

Example structure:

```text
homeconnect-local.0.<haId>.general.*
homeconnect-local.0.<haId>.info.*
homeconnect-local.0.<haId>.network.*
homeconnect-local.0.<haId>.services.*
homeconnect-local.0.<haId>.registeredDevices.*
homeconnect-local.0.<haId>.status.*
homeconnect-local.0.<haId>.program.*
homeconnect-local.0.<haId>.programs.*
homeconnect-local.0.<haId>.options.*
homeconnect-local.0.<haId>.settings.*
homeconnect-local.0.<haId>.events.*
homeconnect-local.0.<haId>.phases.*
homeconnect-local.0.<haId>.commands.*
homeconnect-local.0.<haId>.expertCommands.*
homeconnect-local.0.<haId>.metadata.*
homeconnect-local.0.<haId>.raw.uid_<uid>
```

Important states:

```text
general.connected
info.reconnecting
info.lastSeen
info.lastError
program.RootSelectedProgram
program.RootActiveProgram
program.startOptionsJson
programs.availableList
programs.availableJson
settings.PowerState
commands.StartProgram
commands.StartProgramWithOptions
```

`general.connected` is used as the ioBroker device online indicator, similar to the official cloud Home Connect adapter.

## Starting programs

The normal start button uses the selected program:

```text
commands.StartProgram
```

For start with options, write JSON to:

```text
program.startOptionsJson
```

Example:

```json
{
  "finish_in": 7200,
  "options": {
    "Dishcare.Dishwasher.Option.IntensivZone": false,
    "Dishcare.Dishwasher.Option.VarioSpeedPlus": true
  }
}
```

Then trigger:

```text
commands.StartProgramWithOptions
```

`start_in` and `finish_in` may be seconds or an object:

```json
{
  "start_in": {
    "hours": 1,
    "minutes": 30
  }
}
```

## Write/control safety

The adapter only writes via the local `/ro/values` endpoint. Writes are mainly enabled when the appliance reports `READWRITE` for the corresponding UID.

Dangerous commands are blocked from normal `commands.*` creation and are only listed under:

```text
expertCommands.blockedList
```

Currently blocked command markers include:

```text
FactoryReset
NetworkReset
DeactivateWiFi
AllowSoftwareUpdate
AllowSoftwareDownload
SoftwareUpdate
SoftwareDownload
```

## Offline appliances

Some appliances, especially washers and dryers, may only be reachable when switched on. This is expected.

The adapter treats failed local socket connections as offline state, not as a fatal adapter error. It reconnects periodically and updates:

```text
general.connected
info.reconnecting
info.lastError
```

## Protocol notes

Local AES mode uses:

- URL: `ws://<ip>:80/homeconnect`
- WebSocket binary frames
- AES-256-CBC stream encryption
- HMAC-SHA256 authentication truncated to 16 bytes
- PSK and IV from the downloaded device profile

Local TLS mode uses:

- URL: `wss://<ip>:443/homeconnect`
- TLS 1.2 with PSK from the downloaded device profile
- Plain Home Connect JSON messages inside the protected WebSocket

Typical local handshake:

1. Appliance sends `/ei/initialValues`.
2. Client responds with app identity.
3. Client requests `/ci/services`.
4. Optional `/ci/authentication` and `/ci/info` depending on CI version.
5. Optional `/iz/info`, `/ei/deviceReady`, `/ni/info` and `/ci/registeredDevices` depending on advertised services.
6. Client requests `/ro/allDescriptionChanges` and `/ro/allMandatoryValues`.
7. Live updates arrive through `/ro/values` and related `/ro/*` notifications.

## Credits / references

This adapter is MIT licensed. It was built from local protocol observations and the following reference projects:

- https://github.com/bruestel/homeconnect-profile-downloader
- https://github.com/chris-mc1/homeconnect_local_hass
- https://github.com/chris-mc1/homeconnect_websocket
- https://github.com/osresearch/hcpy
- https://github.com/stakach/homeconnect_crystal

## Development

```bash
npm install
npm run build
```

Then install/link the adapter into an ioBroker test instance.
