# homebridge-solax-local

Homebridge plugin pro střídače **Solax** přes **lokální API donglu** (Pocket WiFi 3.0 / LAN dongle) — žádný cloud, žádné TokenID, žádný starý GET. Ověřeno na **X3-Hybrid-G4 / G4 PRO**; architektura je připravená na další modely (`model` v konfiguraci).

## Jak to funguje

Plugin každých pár sekund pošle na dongle:

```
POST http://<IP-donglu>/
Content-Type: application/x-www-form-urlencoded
X-Forwarded-For: 5.8.8.8

optType=ReadRealTimeData&pwd=<SN-donglu>
```

Dongle vrátí JSON s polem `Data[]`, které plugin dekóduje (dekodér podle zvoleného `model`).

## Předpoklady

1. Dongle je **připojený k domácí Wi-Fi/LAN** (ne jen v AP režimu) a má IP na LAN. Dej mu v routeru **DHCP rezervaci** (pevnou IP).
2. **Lokální API je povolené** (novější firmware ho někdy blokuje — pak probe.js spadne na timeout).
3. `sn` = sériové číslo **Wi-Fi/LAN donglu** (nálepka, např. `SWxxxxxxxx`), ne SN střídače.

## Nejdřív otestuj (bez instalace)

```bash
node probe.js 192.168.1.50 SWXXXXXXXX
```

Když uvidíš rozumné hodnoty (PV, SOC, Load…), API funguje. Když ne, pošli celý výpis `Data[]` — doladíme indexy / přidáme dekodér.

## Instalace

Přes Homebridge Config UI X (po zveřejnění na npm), nebo lokálně:

```bash
npm install -g homebridge-solax-local
```

## Konfigurace (config.json)

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

## Co uvidíš v HomeKit

Apple Home nemá nativní „výkon ve W", takže výkonové hodnoty jsou vystavené jako **světelné senzory** (hodnota v „lux" = watty) — díky tomu jsou vidět nativně v Domácnosti. V appce **Eve** se navíc zobrazí jako skutečné Watty (custom charakteristika).

| Accessory | Zdroj (Data) | Poznámka |
|---|---|---|
| FVE výroba | PV1+PV2 (14+15) | vždy ≥ 0 |
| Zátěž domu | Load (47) | spotřeba domu |
| Odběr ze sítě | Grid (34-35), záporná část | import |
| Dodávka do sítě | Grid (34-35), kladná část | export |
| Baterie nabíjení | Battery (41), kladná část | |
| Baterie vybíjení | Battery (41), záporná část | |
| Solax Baterie | SOC (103) | nativní baterie %, stav nabíjení |

Prohozené znaménko? Přepni `invertGrid` / `invertBattery`.

## Přidání dalšího modelu

V `index.js` je mapa `DECODERS`. Přidej funkci `decodeXxx(data)` vracející stejná pole (`pvPower`, `gridPower`, `batteryPower`, `loadPower`, `soc`, `yieldToday`, `yieldTotal`, …) a zaregistruj ji v `DECODERS` pod klíčem modelu. Zbytek pluginu je generický.

## Mapování dat (X3 Hybrid G4)

| Index | Význam | Úprava |
|---|---|---|
| 6,7,8 | AC výkon fáze 1-3 | signed |
| 14,15 | PV1 / PV2 výkon (W) | — |
| 34-35 | Výkon do/ze sítě (W) | signed32, low-word first |
| 41 | Výkon baterie (W) | signed16 |
| 47 | Zátěž domu (W) | signed16 |
| 68-69 | Celková výroba (kWh) | signed32 ÷10 |
| 70 | Dnešní výroba (kWh) | ÷10 |
| 103 | SOC baterie (%) | — |
| 105 | Teplota baterie (°C) | signed16 |

Zdroj mapování: referenční knihovna [squishykid/solax](https://github.com/squishykid/solax).

## Licence

MIT
