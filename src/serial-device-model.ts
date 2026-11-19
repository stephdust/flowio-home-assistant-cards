/** Shared HA entity mappings and safe setpoint validation for RS485 cards. */
export type SerialCardKind = 'polytropic' | 'aquagem';
export type EntityState = { state: string; attributes: Record<string, unknown> };
export type EntityStates = Record<string, EntityState>;
export interface SerialDeviceCardConfig {
  type: string; title: string; entity_prefix: string; device_slot: number;
  power_entity: string; setpoint_entity: string;
  eco_rpm: number; normal_rpm: number; boost_rpm: number;
  grid_options?: Record<string, unknown>;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Configuration objet attendue');
  return input as Record<string, unknown>;
}
function label(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw Error('Champ texte invalide');
  return value.trim();
}
function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw Error('Entier attendu entre ' + min + ' et ' + max);
  return n;
}
export function normalizeSerialDeviceConfig(input: unknown, kind: SerialCardKind): SerialDeviceCardConfig {
  const raw = object(input);
  const type = 'custom:flowio-' + kind + '-card';
  if (raw.type !== undefined && raw.type !== type) throw Error('Type de carte attendu : ' + type);
  const entity_prefix = label(raw.entity_prefix, 'fio').toLowerCase().replace(/_+$/, '');
  if (entity_prefix && !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(entity_prefix)) throw Error('Préfixe invalide');
  const device_slot = int(raw.device_slot, kind === 'polytropic' ? 7 : 0, 0, 15);
  const title = label(raw.title, kind === 'polytropic' ? 'PAC Polytropic' : 'Pompe de filtration AquaGem');
  if (!title) throw Error('Titre obligatoire');
  const stem = entity_prefix ? entity_prefix + '_' : '';
  const grid_options = raw.grid_options;
  if (grid_options !== undefined &&
      (!grid_options || typeof grid_options !== 'object' || Array.isArray(grid_options)))
    throw Error('grid_options doit être un objet');
  return {
    type, title, entity_prefix, device_slot,
    power_entity: label(raw.power_entity, 'switch.' + stem + 'io_' +
      (kind === 'polytropic' ? 'wat_htr' : 'flt_pmp')),
    setpoint_entity: label(raw.setpoint_entity, 'number.' + stem + 'pd' + device_slot + '_setpoint'),
    eco_rpm: int(raw.eco_rpm, 1200, 1, 65535),
    normal_rpm: int(raw.normal_rpm, 1800, 1, 65535),
    boost_rpm: int(raw.boost_rpm, 2700, 1, 65535),
    ...(grid_options === undefined ? {} : { grid_options: grid_options as Record<string, unknown> })
  };
}
export function dataSensorId(prefix: string, id: number): string {
  return 'sensor.' + (prefix ? prefix + '_' : '') + 'data_' + id;
}
/** Flow.io legacy equipment IDs: metrics 0..31 at 176 + slot*32. */
export function deviceMetricId(prefix: string, slot: number, offset: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 15 ||
      !Number.isInteger(offset) || offset < 0 || offset > 31) throw Error('Index de métrique invalide');
  return dataSensorId(prefix, 176 + slot * 32 + offset);
}
/** Extended metric #34, compressor frequency: ID 690 + slot*8. */
export function compressorFrequencyId(prefix: string, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 15) throw Error('Index équipement invalide');
  return dataSensorId(prefix, 690 + slot * 8);
}
export function waterTemperatureId(prefix: string): string {
  return 'sensor.' + (prefix ? prefix + '_' : '') + 'io_wat_tmp';
}
export function numericValue(state: EntityState | undefined): number | undefined {
  if (!state || ['unknown', 'unavailable', 'none', ''].includes(state.state.trim().toLowerCase()))
    return undefined;
  const n = Number(state.state);
  return Number.isFinite(n) ? n : undefined;
}
export function numericMetric(states: EntityStates, prefix: string, slot: number, offset: number) {
  return numericValue(states[deviceMetricId(prefix, slot, offset)]);
}
export function reading(value: number | undefined, unit: string, decimals = 1): string {
  if (value === undefined) return 'Indisponible';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: decimals }).format(value) +
    (unit ? ' ' + unit : '');
}
export type TargetRange = { min: number; max: number; step: number };
export function targetRange(state: EntityState | undefined): TargetRange | undefined {
  if (!state || numericValue(state) === undefined) return undefined;
  const min = Number(state.attributes.min), max = Number(state.attributes.max),
    providedStep = Number(state.attributes.step);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return undefined;
  return { min, max, step: Number.isFinite(providedStep) && providedStep > 0 ? providedStep : 1 };
}
export function targetAllowed(range: TargetRange | undefined, value: number): boolean {
  return !!range && Number.isFinite(value) && value >= range.min && value <= range.max;
}
export function nextTarget(current: number, direction: -1 | 1, range: TargetRange): number {
  return Math.round(Math.max(range.min, Math.min(range.max, current + direction * range.step)) * 1000) / 1000;
}
export function powerState(states: EntityStates, entity: string): boolean | undefined {
  const value = states[entity]?.state;
  return value === 'on' ? true : value === 'off' ? false : undefined;
}
export function compressorStatus(states: EntityStates, prefix: string, slot: number): string {
  const hz = numericValue(states[compressorFrequencyId(prefix, slot)]);
  return hz === undefined ? 'Indisponible' : hz > 0 ?
    'En marche · ' + reading(hz, 'Hz') : 'À l’arrêt';
}
export function heaterStatus(states: EntityStates, c: SerialDeviceCardConfig): string {
  const on = powerState(states, c.power_entity);
  if (on === undefined) return 'État indisponible';
  if (!on) return 'À l’arrêt';
  const hz = numericValue(states[compressorFrequencyId(c.entity_prefix, c.device_slot)]);
  return hz === undefined ? 'Marche demandée' : hz > 0 ? 'En chauffe' : 'En veille';
}
export function faultStatus(states: EntityStates, prefix: string, slot: number): string {
  const fault = numericMetric(states, prefix, slot, 26);
  return fault === undefined ? 'Indisponible' : fault === 0 ? 'Aucun' : 'Code ' + fault;
}
