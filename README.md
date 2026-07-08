# ioBroker HomeConnect Local Adapter

Read-only proof of concept for local LAN monitoring of Bosch/Siemens/BSH Home Connect appliances.

The adapter is intended to talk to appliances locally instead of using the Home Connect cloud API during runtime. The current implementation supports AES based devices on `ws://<ip>:80/homeconnect` and an experimental TLS-PSK transport for devices on `wss://<ip>:443/homeconnect`.

## Current PoC scope

Implemented:

- Load one profile ZIP or an extracted profile directory from `homeconnect-profile-downloader`.
- Parse the profile JSON, `DeviceDescription.xml`, and `FeatureMapping.xml`.
- Connect to AES based appliances through the local WebSocket endpoint.
- Experimental TLS-PSK WebSocket transport for TLS-only appliances, for example newer dishwashers.
- Perform the local Home Connect handshake.
- Request `/ro/allDescriptionChanges` and `/ro/allMandatoryValues`.
- Process live `/ro/values` and other `/ro/*` messages.
- Dynamically create ioBroker states from local UIDs.
- Translate known UIDs to names through `FeatureMapping.xml`.
- Translate enum values where the downloaded device description contains enum comments.
- Always create `raw.uid_<uid>` states when `debugRaw` is enabled.

Not implemented yet:

- Admin upload/import workflow for ZIP files.
- mDNS discovery.
- Write/control commands.
- Stable state schema migration and tests.
- TLS-PSK compatibility fallback variants if a Node/OpenSSL combination rejects the first cipher setup.

## First test path

1. Install the adapter from this repository in an ioBroker test system.
2. Create a profile ZIP with `homeconnect-profile-downloader`.
3. Copy the ZIP onto the ioBroker host, for example:

   ```bash
   /opt/iobroker/homeconnect-profiles/dishwasher.zip
   ```

4. Adapter settings:

   - `Profile ZIP or directory path`: absolute ZIP path or extracted profile directory.
   - Add a device row:
     - `enabled`: true
     - `haId`: exactly as shown in the profile JSON
     - `host`: appliance IP address or hostname

5. Start the adapter and set log level to `debug` for the first run.

The adapter chooses the transport from the profile JSON:

```json
"connectionType": "AES"
```

or:

```json
"connectionType": "TLS"
```

## State layout

Example:

```text
homeconnect-local.0.<haId>.info.*
homeconnect-local.0.<haId>.status.*
homeconnect-local.0.<haId>.program.*
homeconnect-local.0.<haId>.options.*
homeconnect-local.0.<haId>.settings.*
homeconnect-local.0.<haId>.events.*
homeconnect-local.0.<haId>.phases.ProgramPhase
homeconnect-local.0.<haId>.phases.ProcessPhase
homeconnect-local.0.<haId>.raw.uid_<uid>
```

Important target values include:

- `OperationState`
- `PowerState`
- `DoorState`
- `ActiveProgram`
- `SelectedProgram`
- `RemainingProgramTime`
- `EstimatedTotalProgramTime`
- `ProgramProgress`
- `ProgramPhase`
- `ProcessPhase`
- `RemoteControlActive`
- `RemoteControlStartAllowed`
- `ProgramFinished`
- `ProgramAborted`
- appliance specific events such as `AquaStopOccured`, `LowWaterPressure`, `DrainPumpBlocked`, `SaltLack`, `RinseAidLack`, `WaterLevelTooHigh`, `PumpError`, `FatalErrorOccured`, and maintenance/filter states.

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

The first handshake follows the known Home Connect Local flow:

1. Appliance sends `/ei/initialValues`.
2. Client responds with app identity.
3. Client requests `/ci/services`.
4. Optional `/ci/authentication` and `/ci/info` for older CI versions.
5. Optional `/iz/info`, `/ei/deviceReady`, and `/ni/info` depending on advertised services.
6. Client requests `/ro/allDescriptionChanges` and `/ro/allMandatoryValues`.
7. Live updates arrive through `/ro/values` and related `/ro/*` notifications.

## Credits / references

This adapter is MIT licensed. The first PoC implementation was built from protocol observations and the following MIT licensed reference projects:

- `chris-mc1/homeconnect_local_hass`
- `chris-mc1/homeconnect_websocket`
- `bruestel/homeconnect-profile-downloader`
- `osresearch/hcpy`
- `stakach/homeconnect_crystal`

## Development

```bash
npm install
npm run build
```

Then install/link the adapter into an ioBroker test instance.
