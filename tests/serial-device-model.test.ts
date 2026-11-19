import { describe, expect, it } from 'vitest';
import {
  compressorFrequencyId, compressorStatus, dataSensorId, deviceMetricId,
  faultStatus, heaterStatus, nextTarget, normalizeSerialDeviceConfig,
  numericMetric, numericValue, powerState, reading, targetAllowed,
  targetRange, waterTemperatureId, type EntityStates
} from '../src/serial-device-model';

describe('Flow.io Polytropic / AquaGem cards', () => {
  it('configures separate default slots, switches and writable number entities', () => {
    const heater = normalizeSerialDeviceConfig({}, 'polytropic');
    const pump = normalizeSerialDeviceConfig({}, 'aquagem');
    expect(heater.device_slot).toBe(7);
    expect(heater.power_entity).toBe('switch.fio_io_wat_htr');
    expect(heater.setpoint_entity).toBe('number.fio_pd7_setpoint');
    expect(pump.device_slot).toBe(0);
    expect(pump.power_entity).toBe('switch.fio_io_flt_pmp');
    expect(pump.setpoint_entity).toBe('number.fio_pd0_setpoint');
    expect(normalizeSerialDeviceConfig({entity_prefix:'pool_',device_slot:5},'aquagem').setpoint_entity)
      .toBe('number.pool_pd5_setpoint');
  });
  it('uses the firmware metric IDs for Fan1 RPM, ambient, and readbacks', () => {
    expect(deviceMetricId('fio',7,29)).toBe('sensor.fio_data_429');
    expect(deviceMetricId('fio',7,22)).toBe('sensor.fio_data_422');
    expect(deviceMetricId('fio',7,19)).toBe('sensor.fio_data_419');
    expect(deviceMetricId('fio',7,20)).toBe('sensor.fio_data_420');
    expect(deviceMetricId('fio',0,1)).toBe('sensor.fio_data_177');
    expect(compressorFrequencyId('fio',7)).toBe('sensor.fio_data_746');
    expect(waterTemperatureId('fio')).toBe('sensor.fio_io_wat_tmp');
    expect(dataSensorId('',429)).toBe('sensor.data_429');
  });
  it('never invents readings for missing or unavailable values', () => {
    const states: EntityStates = {
      'sensor.fio_data_429': { state:'780', attributes:{} },
      'sensor.fio_data_422': { state:'unavailable', attributes:{} },
      'sensor.fio_data_177': { state:'0', attributes:{} }
    };
    expect(numericMetric(states,'fio',7,29)).toBe(780);
    expect(numericMetric(states,'fio',7,22)).toBeUndefined();
    expect(numericMetric(states,'fio',0,1)).toBe(0);
    expect(numericValue({state:'unknown',attributes:{}})).toBeUndefined();
    expect(reading(undefined,'tr/min')).toBe('Indisponible');
    expect(reading(780,'tr/min',0)).toContain('tr/min');
  });
  it('validates HA number bounds for setpoint changes', () => {
    const state={state:'1800',attributes:{min:600,max:3000,step:50}};
    const bounds=targetRange(state);
    expect(bounds).toEqual({min:600,max:3000,step:50});
    expect(targetAllowed(bounds,1800)).toBe(true);
    expect(targetAllowed(bounds,3500)).toBe(false);
    expect(nextTarget(1800,1,bounds!)).toBe(1850);
    expect(nextTarget(600,-1,bounds!)).toBe(600);
    expect(targetRange({state:'1800',attributes:{}})).toBeUndefined();
    expect(targetRange({state:'unavailable',attributes:{min:600,max:3000}})).toBeUndefined();
  });
  it('distinguishes requested ON from compressor telemetry', () => {
    const c=normalizeSerialDeviceConfig({},'polytropic');
    const states: EntityStates={
      [c.power_entity]: {state:'on',attributes:{}},
      [compressorFrequencyId('fio',7)]: {state:'0',attributes:{}},
      [deviceMetricId('fio',7,26)]: {state:'0',attributes:{}}
    };
    expect(heaterStatus(states,c)).toBe('En veille');
    expect(compressorStatus(states,'fio',7)).toBe('À l’arrêt');
    expect(faultStatus(states,'fio',7)).toBe('Aucun');
    states[compressorFrequencyId('fio',7)].state='32';
    expect(heaterStatus(states,c)).toBe('En chauffe');
    expect(compressorStatus(states,'fio',7)).toContain('Hz');
    states[c.power_entity].state='off';
    expect(heaterStatus(states,c)).toBe('À l’arrêt');
    expect(powerState(states,c.power_entity)).toBe(false);
  });
  it('refuses malformed slots, ranges and card types', () => {
    expect(() => normalizeSerialDeviceConfig({device_slot:16},'polytropic')).toThrow();
    expect(() => normalizeSerialDeviceConfig({boost_rpm:-1},'aquagem')).toThrow();
    expect(() => normalizeSerialDeviceConfig({type:'custom:flowio-aquagem-card'},'polytropic')).toThrow();
    expect(() => deviceMetricId('fio',-1,29)).toThrow();
  });
});
