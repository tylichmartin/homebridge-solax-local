'use strict';

const http = require('http');

const PLUGIN_NAME = 'homebridge-solax-local';
const PLATFORM_NAME = 'SolaxLocal';

// Eve custom characteristic UUIDs (shown in the Eve app; ignored by Apple Home)
const EVE_CURRENT_CONSUMPTION = 'E863F10D-079E-48FF-8F27-9C2605A29F52'; // Watt
const EVE_TOTAL_CONSUMPTION = 'E863F10C-079E-48FF-8F27-9C2605A29F52';   // kWh

let Service, Characteristic, EveWatt, EveKWh;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;

  // --- Eve custom characteristics -------------------------------------------
  class CurrentConsumption extends Characteristic {
    constructor() {
      super('Consumption', EVE_CURRENT_CONSUMPTION, {
        format: Characteristic.Formats.FLOAT,
        unit: 'W',
        minValue: -100000,
        maxValue: 100000,
        minStep: 0.1,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }
  CurrentConsumption.UUID = EVE_CURRENT_CONSUMPTION;
  EveWatt = CurrentConsumption;

  class TotalConsumption extends Characteristic {
    constructor() {
      super('Total Consumption', EVE_TOTAL_CONSUMPTION, {
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        minValue: 0,
        maxValue: 1000000,
        minStep: 0.001,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }
  TotalConsumption.UUID = EVE_TOTAL_CONSUMPTION;
  EveKWh = TotalConsumption;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SolaxPlatform);
};

// ----------------------------------------------------------------------------
// Data decode helpers (X3 Hybrid G4 real-time "Data" array)
// ----------------------------------------------------------------------------
function toSigned16(v) {
  return v > 0x7fff ? v - 0x10000 : v;
}
function packU32(low, high) {
  let v = (high << 16 >>> 0) + low; // low word first, unsigned
  if (v >= 0x80000000) v -= 0x100000000; // signed 32-bit
  return v;
}

// ----------------------------------------------------------------------------
// Model decoders. Each maps the raw Data[] array to named metrics
// (Watts / % / kWh). Add new models here — the rest of the plugin is generic.
// ----------------------------------------------------------------------------
const DECODERS = {
  'x3-hybrid-g4': decodeX3HybridG4,
  'x1-hybrid-g4': decodeX3HybridG4, // same real-time layout on this dongle firmware
};

function decodeX3HybridG4(data) {
  const d = (i) => (typeof data[i] === 'number' ? data[i] : 0);

  const pv1 = d(14);
  const pv2 = d(15);
  const pvPower = pv1 + pv2;

  // Grid (feed-in) power: + = export to grid, - = import from grid
  const gridPower = packU32(d(34), d(35));

  // Battery power: + = charging, - = discharging (flip with config.invertBattery)
  const batteryPower = toSigned16(d(41));

  // House load / consumption
  const loadPower = toSigned16(d(47));

  const soc = d(103); // %
  const battTemp = toSigned16(d(105)); // °C
  const radTemp = toSigned16(d(54)); // °C

  const yieldToday = d(70) / 10;               // kWh
  const yieldTotal = packU32(d(68), d(69)) / 10; // kWh

  return {
    pvPower,
    pv1,
    pv2,
    gridPower,
    batteryPower,
    loadPower,
    soc,
    battTemp,
    radTemp,
    yieldToday,
    yieldTotal,
  };
}

// ----------------------------------------------------------------------------
// Local dongle query
// ----------------------------------------------------------------------------
function queryInverter(host, sn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = 'optType=ReadRealTimeData' + (sn ? '&pwd=' + sn : '');
    const req = http.request(
      {
        host,
        port: 80,
        path: '/',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'X-Forwarded-For': '5.8.8.8',
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (!json || !Array.isArray(json.Data)) {
              return reject(new Error('Unexpected response: ' + raw.slice(0, 200)));
            }
            resolve(json);
          } catch (e) {
            reject(new Error('Invalid JSON from dongle: ' + raw.slice(0, 200)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ----------------------------------------------------------------------------
// Platform
// ----------------------------------------------------------------------------
class SolaxPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.name = config.name || 'Solax';
    this.host = config.host;
    this.sn = config.sn || config.pwd || '';
    this.pollInterval = Math.max(5, config.pollInterval || 15) * 1000;
    this.timeout = (config.timeout || 8) * 1000;
    this.invertBattery = !!config.invertBattery;
    this.invertGrid = !!config.invertGrid;
    this.debug = !!config.debug;
    this.model = (config.model || 'x3-hybrid-g4').toLowerCase();
    this.decoder = DECODERS[this.model] || DECODERS['x3-hybrid-g4'];
    if (!DECODERS[this.model]) {
      this.log.warn(`Unknown model "${this.model}", falling back to x3-hybrid-g4 decoder.`);
    }

    this.accessories = new Map(); // key -> { accessory, update }
    this.cached = new Map();      // uuid -> cached PlatformAccessory (restored on restart)
    this.registered = [];         // uuids we actually use this run

    if (!this.host) {
      this.log.error('Missing "host" (dongle IP) in config — plugin will not start.');
      return;
    }

    api.on('didFinishLaunching', () => {
      this.setup();
      this.poll();
      setInterval(() => this.poll(), this.pollInterval);
    });
  }

  // Homebridge restores cached accessories here (dynamic platform), before launch.
  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  // Return an accessory for this uuid, reusing the cached one after a restart.
  getOrCreateAccessory(uuid, displayName) {
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory(displayName, uuid);
    } else {
      accessory.displayName = displayName;
    }
    this.registered.push(uuid);
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Solax')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, (this.sn || 'dongle') + ':' + uuid.slice(-6));
    return { accessory, isNew };
  }

  // Build one power sensor accessory: native LightSensor (W shown as lux) + Eve Watt.
  makePowerAccessory(key, displayName) {
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + this.host + ':' + key);
    const { accessory, isNew } = this.getOrCreateAccessory(uuid, displayName);

    const svc = accessory.getService(Service.LightSensor)
      || accessory.addService(Service.LightSensor, displayName);
    svc.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ minValue: 0.0001, maxValue: 100000 });
    if (!svc.testCharacteristic(EveWatt)) svc.addCharacteristic(EveWatt);

    this.accessories.set(key, {
      accessory,
      isNew,
      update: (watts) => {
        const lux = Math.max(0.0001, Math.abs(watts));
        svc.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, lux);
        svc.getCharacteristic(EveWatt).updateValue(watts);
      },
    });
    return accessory;
  }

  makeBatteryAccessory() {
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + this.host + ':battery');
    const { accessory, isNew } = this.getOrCreateAccessory(uuid, 'Solax Battery');

    // Apple Home cannot display a standalone Battery service ("Not Supported"),
    // so SOC is exposed as a HumiditySensor (shows the % natively). The Battery
    // service is kept as a supporting service for the charging state / Eve.
    const humidity = accessory.getService(Service.HumiditySensor)
      || accessory.addService(Service.HumiditySensor, 'Solax Battery');
    const battery = accessory.getService(Service.Battery)
      || accessory.addService(Service.Battery, 'Battery');

    this.accessories.set('battery', {
      accessory,
      isNew,
      update: (soc, batteryPower) => {
        const level = Math.max(0, Math.min(100, soc));
        humidity.updateCharacteristic(Characteristic.CurrentRelativeHumidity, level);
        battery.updateCharacteristic(Characteristic.BatteryLevel, level);
        battery.updateCharacteristic(
          Characteristic.StatusLowBattery,
          soc <= (this.config.lowBattery || 15)
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        );
        const charging = this.invertBattery ? batteryPower < -10 : batteryPower > 10;
        battery.updateCharacteristic(
          Characteristic.ChargingState,
          charging ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING
        );
      },
    });
    return accessory;
  }

  setup() {
    this.makePowerAccessory('pv', 'Solar PV Power');
    this.makePowerAccessory('load', 'House Load');
    this.makePowerAccessory('gridImport', 'Grid Import');
    this.makePowerAccessory('gridExport', 'Grid Export');
    this.makePowerAccessory('battCharge', 'Battery Charge');
    this.makePowerAccessory('battDischarge', 'Battery Discharge');
    this.makeBatteryAccessory();

    // Register only accessories new this run; reused cached ones are already live.
    const toRegister = [];
    for (const { accessory, isNew } of this.accessories.values()) {
      if (isNew) toRegister.push(accessory);
    }
    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
    }

    // Remove stale cached accessories no longer produced by this config.
    const stale = [];
    for (const [uuid, accessory] of this.cached) {
      if (!this.registered.includes(uuid)) stale.push(accessory);
    }
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    this.log.info(
      `Solax ready (host ${this.host}): ${toRegister.length} new, ` +
      `${this.accessories.size - toRegister.length} reused, ${stale.length} removed.`
    );
  }

  async poll() {
    try {
      const json = await queryInverter(this.host, this.sn, this.timeout);
      if (this.debug) this.log.info('Raw Data[]: ' + JSON.stringify(json.Data));
      const m = this.decoder(json.Data);

      let gridPower = m.gridPower;
      let batteryPower = m.batteryPower;
      if (this.invertGrid) gridPower = -gridPower;
      if (this.invertBattery) batteryPower = -batteryPower;

      this.accessories.get('pv').update(m.pvPower);
      this.accessories.get('load').update(m.loadPower);
      this.accessories.get('gridImport').update(Math.max(0, -gridPower));
      this.accessories.get('gridExport').update(Math.max(0, gridPower));
      this.accessories.get('battCharge').update(Math.max(0, batteryPower));
      this.accessories.get('battDischarge').update(Math.max(0, -batteryPower));
      this.accessories.get('battery').update(m.soc, batteryPower);

      if (this.debug) {
        this.log.info(
          `PV=${m.pvPower}W Load=${m.loadPower}W Grid=${gridPower}W ` +
          `Batt=${batteryPower}W SOC=${m.soc}% Today=${m.yieldToday}kWh`
        );
      }
    } catch (e) {
      this.log.warn('Solax poll failed: ' + e.message);
    }
  }
}
