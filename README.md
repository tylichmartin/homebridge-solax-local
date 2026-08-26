# homebridge-solax-local

Homebridge plugin for **Solax** inverters using the **local dongle API** (Pocket WiFi 3.0 / LAN dongle) — no cloud, no TokenID, no legacy GET. Verified on **X3-Hybrid-G4 / G4 PRO**; the architecture is ready for more models via the `model` config option.

## How it works

Every few seconds the plugin sends this to the dongle:

```
POST http://<dongle-ip>/
Content-Type: application/x-www-form-urlencoded
X-Forwarded-For: 5.8.8.8

optType=ReadRealTimeData&pwd=<dongle-SN>
```

The dongle replies with JSON containing a `Data[]` array, which the plugin decodes (decoder selected by `model`).

## Requirements

1. The dongle is **connected to your home Wi-Fi/LAN** (not just AP mode) and has a LAN IP. Give it a **DHCP reservation** (static IP) in your router.
2. **Local API is enabled.** Newer firmware sometimes blocks it — in that case `probe.js` will time out.
3. `sn` = the serial number of the **Wi-Fi/LAN dongle** (on its sticker, e.g. `SWxxxxxxxx`), *not* the inverter serial.

## Test first (before installing)

```bash
node probe.js 192.168.1.50 SWXXXXXXXX
```

If you see sensible values (PV, SOC, Load…), the API works. If not, open an issue with the full `Data[]` output so the indices / decoder can be adjusted.

## Installation

Via Homebridge Config UI X (once published to npm), or locally:

```bash
npm install -g homebridge-solax-local
```

## Configuration (config.json)

```json
{
  "platforms": [
    {
      "platform": "SolaxLocal",
      "name": "Solax",
      "model": "x3-hybrid-g4",
      "host": "192.168.1.50",
      "sn": "SWXXXXXXXX",
      "pollInterval": 15,
      "invertGrid": false,
      "invertBattery": false,
      "debug": false
    }
  ]
}
```

## What you get in HomeKit

Apple Home has no native "power in W" characteristic, so power values are exposed as **light sensors** (the "lux" value = watts) — this makes them visible natively in the Home app. In the **Eve** app they additionally show up as real Watts (a custom characteristic).

| Accessory | Source (Data) | Notes |
|---|---|---|
| Solar PV Power | PV1+PV2 (14+15) | always ≥ 0 |
| House Load | Load (47) | house consumption |
| Grid Import | Grid (34-35), negative part | import from grid |
| Grid Export | Grid (34-35), positive part | export to grid |
| Battery Charge | Battery (41), positive part | |
| Battery Discharge | Battery (41), negative part | |
| Solax Battery | SOC (103) | native battery %, charging state |

Signs swapped? Toggle `invertGrid` / `invertBattery`.

## Adding another model

`index.js` has a `DECODERS` map. Add a `decodeXxx(data)` function that returns the same fields (`pvPower`, `gridPower`, `batteryPower`, `loadPower`, `soc`, `yieldToday`, `yieldTotal`, …) and register it in `DECODERS` under the model key. The rest of the plugin is generic.

## Data mapping (X3 Hybrid G4)

| Index | Meaning | Conversion |
|---|---|---|
| 6,7,8 | AC power phase 1-3 | signed |
| 14,15 | PV1 / PV2 power (W) | — |
| 34-35 | Grid power to/from grid (W) | signed32, low word first |
| 41 | Battery power (W) | signed16 |
| 47 | House load (W) | signed16 |
| 68-69 | Total yield (kWh) | signed32 ÷10 |
| 70 | Today's yield (kWh) | ÷10 |
| 103 | Battery SOC (%) | — |
| 105 | Battery temperature (°C) | signed16 |

Mapping source: reference library [squishykid/solax](https://github.com/squishykid/solax).

## License

MIT
