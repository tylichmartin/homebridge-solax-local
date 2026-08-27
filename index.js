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
  const pv3 = d(131); // 3rd MPPT (X3-Hybrid-G4 PRO); 0 on 2-MPPT models
  const pvPower = pv1 + pv2 + pv3;

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

  const runMode = d(19); // 3 = Fault, 4 = Permanent Fault

  return {
    pvPower,
    pv1,
    pv2,
    pv3,
    gridPower,
    batteryPower,
    loadPower,
    soc,
    battTemp,
    radTemp,
    yieldToday,
    yieldTotal,
    runMode,
  };
}

// X3 Hybrid G4 run modes; 3/4 are fault states.
const FAULT_MODES = new Set([3, 4]);

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
    this.built = [];              // [{ accessory, isNew }] all accessories built this run
    this.triggers = Array.isArray(config.triggers) ? config.triggers : [];
    this.triggerEvals = [];       // [{ cfg, update(values) }]
    this.hidden = new Set(Array.isArray(config.hide) ? config.hide : []);

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
    this.built.push({ accessory, isNew });
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

    // batteryStyle:
    //   "battery"  (default) - standalone Battery service. Apple Home shows it as a
    //              main-screen tile ("Not Supported" on the face, but SOC % when opened).
    //   "humidity" - a HumiditySensor so the % shows in the Climate group instead.
    const style = (this.config.batteryStyle || 'battery').toLowerCase();
    const battery = accessory.getService(Service.Battery)
      || accessory.addService(Service.Battery, 'Solax Battery');
    let humidity = accessory.getService(Service.HumiditySensor);
    if (style === 'humidity') {
      if (!humidity) humidity = accessory.addService(Service.HumiditySensor, 'Solax Battery');
    } else if (humidity) {
      accessory.removeService(humidity); // migrate away from the humidity style
      humidity = null;
    }

    this.accessories.set('battery', {
      accessory,
      isNew,
      update: (soc, batteryPower) => {
        const level = Math.max(0, Math.min(100, soc));
        if (humidity) humidity.updateCharacteristic(Characteristic.CurrentRelativeHumidity, level);
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

  // Temperature sensor (shown natively in °C by Apple Home).
  makeTemperatureAccessory(key, displayName) {
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + this.host + ':' + key);
    const { accessory } = this.getOrCreateAccessory(uuid, displayName);
    const svc = accessory.getService(Service.TemperatureSensor)
      || accessory.addService(Service.TemperatureSensor, displayName);
    svc.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 150 });
    this.accessories.set(key, {
      accessory,
      update: (celsius) => svc.updateCharacteristic(Characteristic.CurrentTemperature, celsius),
    });
    return accessory;
  }

  // Online sensor: a ContactSensor that "opens" when the dongle stops responding.
  makeOnlineAccessory() {
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + this.host + ':online');
    const { accessory } = this.getOrCreateAccessory(uuid, 'Solax Online');
    const svc = accessory.getService(Service.ContactSensor)
      || accessory.addService(Service.ContactSensor, 'Solax Online');
    this.accessories.set('online', {
      accessory,
      update: (online) => svc.updateCharacteristic(
        Characteristic.ContactSensorState,
        online
          ? Characteristic.ContactSensorState.CONTACT_DETECTED       // closed = online/OK
          : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED   // open = offline (alert)
      ),
    });
    return accessory;
  }

  // Fault sensor: an OccupancySensor that "detects" when the inverter reports a fault.
  makeFaultAccessory() {
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + this.host + ':fault');
    const { accessory } = this.getOrCreateAccessory(uuid, 'Solax Fault');
    const svc = accessory.getService(Service.OccupancySensor)
      || accessory.addService(Service.OccupancySensor, 'Solax Fault');
    this.accessories.set('fault', {
      accessory,
      update: (fault) => svc.updateCharacteristic(
        Characteristic.OccupancyDetected,
        fault
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
      ),
    });
    return accessory;
  }

  // Build a threshold accessory: an OccupancySensor that turns "detected" when a
  // metric crosses a configured limit. HomeKit automations can then react to it.
  makeTriggerAccessory(cfg, idx) {
    const name = cfg.name || `Trigger ${idx + 1}`;
    const metric = cfg.metric;
    const above = typeof cfg.above === 'number' ? cfg.above : undefined;
    const below = typeof cfg.below === 'number' ? cfg.below : undefined;
    const hyst = typeof cfg.hysteresis === 'number' ? Math.abs(cfg.hysteresis) : 0;

    if (!metric || (above === undefined && below === undefined)) {
      this.log.warn(`Ignoring trigger "${name}": needs "metric" and "above" or "below".`);
      return;
    }

    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + this.host + ':trigger:' + name);
    const { accessory } = this.getOrCreateAccessory(uuid, name);
    const svc = accessory.getService(Service.OccupancySensor)
      || accessory.addService(Service.OccupancySensor, name);

    let active = false; // hysteresis state
    this.triggerEvals.push({
      cfg,
      update: (values) => {
        const v = values[metric];
        if (typeof v !== 'number') return;
        if (!active) {
          if (above !== undefined && v >= above) active = true;
          else if (below !== undefined && v <= below) active = true;
        } else {
          if (above !== undefined && v < above - hyst) active = false;
          else if (below !== undefined && v > below + hyst) active = false;
        }
        svc.updateCharacteristic(
          Characteristic.OccupancyDetected,
          active
            ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
            : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
        );
      },
    });
    return accessory;
  }

  setup() {
    const show = (key) => !this.hidden.has(key);
    if (show('pv')) this.makePowerAccessory('pv', 'Solar PV Power');
    if (show('load')) this.makePowerAccessory('load', 'House Load');
    if (show('gridImport')) this.makePowerAccessory('gridImport', 'Grid Import');
    if (show('gridExport')) this.makePowerAccessory('gridExport', 'Grid Export');
    if (show('battCharge')) this.makePowerAccessory('battCharge', 'Battery Charge');
    if (show('battDischarge')) this.makePowerAccessory('battDischarge', 'Battery Discharge');
    if (show('battery')) this.makeBatteryAccessory();
    if (show('tempInverter')) this.makeTemperatureAccessory('tempInverter', 'Solax Inverter Temp');
    if (show('tempBattery')) this.makeTemperatureAccessory('tempBattery', 'Solax Battery Temp');
    if (show('online')) this.makeOnlineAccessory();
    if (show('fault')) this.makeFaultAccessory();
    this.triggers.forEach((cfg, i) => this.makeTriggerAccessory(cfg, i));

    // Register only accessories new this run; reused cached ones are already live.
    const toRegister = [];
    for (const { accessory, isNew } of this.built) {
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
      `${this.built.length - toRegister.length} reused, ${stale.length} removed, ` +
      `${this.triggerEvals.length} triggers.`
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

      const values = {
        pv: m.pvPower,
        load: m.loadPower,
        gridImport: Math.max(0, -gridPower),
        gridExport: Math.max(0, gridPower),
        battCharge: Math.max(0, batteryPower),
        battDischarge: Math.max(0, -batteryPower),
        soc: m.soc,
      };

      this.upd('pv', values.pv);
      this.upd('load', values.load);
      this.upd('gridImport', values.gridImport);
      this.upd('gridExport', values.gridExport);
      this.upd('battCharge', values.battCharge);
      this.upd('battDischarge', values.battDischarge);
      this.upd('battery', m.soc, batteryPower);
      this.upd('tempInverter', m.radTemp);
      this.upd('tempBattery', m.battTemp);
      this.upd('online', true);
      this.upd('fault', FAULT_MODES.has(m.runMode));

      for (const t of this.triggerEvals) t.update(values);

      if (this.debug) {
        this.log.info(
          `PV=${m.pvPower}W Load=${m.loadPower}W Grid=${gridPower}W ` +
          `Batt=${batteryPower}W SOC=${m.soc}% Today=${m.yieldToday}kWh ` +
          `InvT=${m.radTemp}C BatT=${m.battTemp}C Mode=${m.runMode}`
        );
      }
    } catch (e) {
      this.log.warn('Solax poll failed: ' + e.message);
      this.upd('online', false); // mark offline so a HomeKit automation can alert
    }
  }

  // Update an accessory only if it exists (it may be hidden via config.hide).
  upd(key, ...args) {
    const a = this.accessories.get(key);
    if (a) a.update(...args);
  }
}
