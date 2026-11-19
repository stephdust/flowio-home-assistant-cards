import { LitElement, html, css, nothing } from 'lit';
import { ensureHaElements } from './ha-controls';
import type { Hass } from './model';
import {
  compressorFrequencyId, compressorStatus, deviceMetricId, faultStatus,
  heaterStatus, nextTarget, normalizeSerialDeviceConfig, numericMetric,
  numericValue, powerState, reading, targetAllowed, targetRange,
  waterTemperatureId, type SerialCardKind, type SerialDeviceCardConfig,
  type TargetRange
} from './serial-device-model';

/** Pure HA frontend controls; Flow.io keeps all RS485 sequencing and safety. */
abstract class FlowioSerialDeviceCard extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { state: true },
    busy: { state: true }, error: { state: true },
    notice: { state: true }, sliderDraft: { state: true }
  };
  declare hass?: Hass;
  protected abstract readonly kind: SerialCardKind;
  private config?: SerialDeviceCardConfig;
  private busy = false;
  private error = '';
  private notice = '';
  private sliderDraft?: number;

  setConfig(input: unknown) {
    this.config = normalizeSerialDeviceConfig(input, this.kind);
    this.error = ''; this.notice = ''; this.sliderDraft = undefined;
  }
  getCardSize() { return this.kind === 'polytropic' ? 5 : 4; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  connectedCallback() {
    super.connectedCallback();
    void ensureHaElements(['ha-icon', 'ha-button', 'ha-switch']).catch(error => {
      console.error('[flowio] Contrôles Home Assistant indisponibles', error);
      this.error = 'Contrôles Home Assistant indisponibles. Actualiser le tableau de bord.';
    });
  }

  private more(entityId: string) {
    if (!this.hass?.states[entityId]) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      detail: { entityId }, bubbles: true, composed: true
    }));
  }

  private async togglePower(event: Event) {
    const config = this.config, hass = this.hass;
    if (!config || !hass || this.busy) return;
    const wasOn = powerState(hass.states, config.power_entity);
    // No optimistic ON indication: wait for actual HA/Flow.io feedback.
    (event.target as HTMLInputElement).checked = wasOn === true;
    if (wasOn === undefined) return;
    const verb = wasOn ? 'Arrêter' : 'Démarrer';
    if (!window.confirm(verb + ' ' + config.title +
        ' ? Flow.io conserve ses interverrouillages et sécurités.')) return;
    this.busy = true; this.error = ''; this.notice = '';
    try {
      await hass.callService('switch', wasOn ? 'turn_off' : 'turn_on', {
        entity_id: config.power_entity
      });
      this.notice = 'Commande transmise ; attendre le retour d’état de Flow.io.';
    } catch {
      this.error = 'Commande refusée ou impossible. Vérifier la connexion.';
    } finally {
      this.busy = false;
    }
  }

  private async changeTarget(value: number) {
    const config = this.config, hass = this.hass;
    if (!config || !hass || this.busy) return;
    const bounds = targetRange(hass.states[config.setpoint_entity]);
    if (!targetAllowed(bounds, value)) {
      this.error = 'Consigne hors limites ou entité Home Assistant indisponible.';
      this.sliderDraft = undefined;
      return;
    }
    const unit = this.kind === 'polytropic' ? '°C' : 'tr/min';
    if (!window.confirm('Demander ' + reading(value, unit) + ' à ' + config.title + ' ?')) {
      this.sliderDraft = undefined;
      return;
    }
    this.busy = true; this.error = ''; this.notice = '';
    try {
      await hass.callService('number', 'set_value', {
        entity_id: config.setpoint_entity, value
      });
      this.notice = 'Consigne envoyée ; la valeur réellement mesurée peut évoluer progressivement.';
    } catch {
      this.error = 'Consigne refusée ou indisponible. Vérifier Flow.io.';
    } finally {
      this.busy = false; this.sliderDraft = undefined;
    }
  }

  private adjust(direction: -1 | 1, bounds: TargetRange | undefined, value: number | undefined) {
    if (!bounds || value === undefined) return;
    const next = nextTarget(value, direction, bounds);
    if (next !== value) void this.changeTarget(next);
  }

  private readingTile(label: string, value: string, icon: string, entityId: string) {
    return html`<button type="button" class="reading-tile" ?disabled=${!this.hass?.states[entityId]}
      @click=${() => this.more(entityId)}>
      <ha-icon .icon=${icon} aria-hidden="true"></ha-icon>
      <span class="tile-text"><span class="tile-label">${label}</span><strong>${value}</strong></span>
    </button>`;
  }
  private infoRow(label: string, value: string, entityId: string) {
    return html`<button type="button" class="info-row" ?disabled=${!this.hass?.states[entityId]}
      @click=${() => this.more(entityId)}>
      <span>${label}</span><strong>${value}</strong>
    </button>`;
  }

  private heater(config: SerialDeviceCardConfig, hass: Hass) {
    const prefix = config.entity_prefix, slot = config.device_slot;
    const target = numericValue(hass.states[config.setpoint_entity]);
    const bounds = targetRange(hass.states[config.setpoint_entity]);
    const water = waterTemperatureId(prefix);
    const fan = deviceMetricId(prefix, slot, 29);
    const ambient = deviceMetricId(prefix, slot, 22);
    const inlet = deviceMetricId(prefix, slot, 19);
    const outlet = deviceMetricId(prefix, slot, 20);
    const compressor = compressorFrequencyId(prefix, slot);
    const fault = deviceMetricId(prefix, slot, 26);
    const status = heaterStatus(hass.states, config);
    return html`
      <div class="status-line"><span class="status" data-active=${status === 'En chauffe'}>${status}</span></div>
      <div class="readings">
        ${this.readingTile('Température du bassin', reading(numericValue(hass.states[water]), '°C'), 'mdi:waves', water)}
        <div class="target-box"><div class="target-label">Consigne</div>
          <div class="target-controls">
            <ha-button appearance="outlined" .disabled=${this.busy || !bounds || target === undefined || target <= bounds.min}
              .accessibleLabel=${'Diminuer la consigne'} @click=${() => this.adjust(-1, bounds, target)}>−</ha-button>
            <button type="button" class="target-value" ?disabled=${!hass.states[config.setpoint_entity]}
              @click=${() => this.more(config.setpoint_entity)}>${reading(target, '°C')}</button>
            <ha-button appearance="outlined" .disabled=${this.busy || !bounds || target === undefined || target >= bounds.max}
              .accessibleLabel=${'Augmenter la consigne'} @click=${() => this.adjust(1, bounds, target)}>+</ha-button>
          </div>
        </div>
        ${this.readingTile('Fan1 · vitesse brute', reading(numericMetric(hass.states, prefix, slot, 29), 'tr/min', 0), 'mdi:fan', fan)}
        ${this.readingTile('Température extérieure', reading(numericMetric(hass.states, prefix, slot, 22), '°C'), 'mdi:thermometer', ambient)}
      </div>
      <div class="details">
        ${this.infoRow('Entrée eau', reading(numericMetric(hass.states, prefix, slot, 19), '°C'), inlet)}
        ${this.infoRow('Sortie eau', reading(numericMetric(hass.states, prefix, slot, 20), '°C'), outlet)}
        ${this.infoRow('Compresseur', compressorStatus(hass.states, prefix, slot), compressor)}
        ${this.infoRow('Défaut compresseur', faultStatus(hass.states, prefix, slot), fault)}
      </div>
    `;
  }

  private pump(config: SerialDeviceCardConfig, hass: Hass) {
    const prefix = config.entity_prefix, slot = config.device_slot;
    const observed = deviceMetricId(prefix, slot, 1);
    const target = numericValue(hass.states[config.setpoint_entity]);
    const bounds = targetRange(hass.states[config.setpoint_entity]);
    const slider = this.sliderDraft ?? target;
    const canChange = !!bounds && target !== undefined && !this.busy;
    const presets = [
      { label: 'Éco', speed: config.eco_rpm, icon: 'mdi:leaf' },
      { label: 'Normal', speed: config.normal_rpm, icon: 'mdi:waves' },
      { label: 'Boost', speed: config.boost_rpm, icon: 'mdi:rocket-launch-outline' }
    ];
    return html`
      <div class="readings">
        ${this.readingTile('Vitesse réelle', reading(numericMetric(hass.states, prefix, slot, 1), 'tr/min', 0), 'mdi:speedometer', observed)}
        ${this.readingTile('Vitesse demandée', reading(target, 'tr/min', 0), 'mdi:target', config.setpoint_entity)}
      </div>
      <div class="speed-panel">
        <div class="speed-heading"><span>Vitesse</span><strong>${reading(slider, 'tr/min', 0)}</strong></div>
        <div class="speed-input">
          <ha-button appearance="outlined" .disabled=${!canChange || target! <= bounds!.min}
            .accessibleLabel=${'Diminuer la vitesse'} @click=${() => this.adjust(-1, bounds, target)}>−</ha-button>
          <input type="range" aria-label="Vitesse AquaGem (consigne)"
            min=${bounds?.min ?? 0} max=${bounds?.max ?? 1} step=${bounds?.step ?? 1}
            .value=${String(slider ?? bounds?.min ?? 0)} ?disabled=${!canChange}
            @input=${(event: Event) => { this.sliderDraft = Number((event.target as HTMLInputElement).value); }}
            @change=${(event: Event) => { void this.changeTarget(Number((event.target as HTMLInputElement).value)); }}/>
          <ha-button appearance="outlined" .disabled=${!canChange || target! >= bounds!.max}
            .accessibleLabel=${'Augmenter la vitesse'} @click=${() => this.adjust(1, bounds, target)}>+</ha-button>
        </div>
        <div class="speed-limits">
          <span>${bounds ? reading(bounds.min, 'tr/min', 0) : '—'}</span>
          <span>${bounds ? reading(bounds.max, 'tr/min', 0) : '—'}</span>
        </div>
      </div>
      <div class="presets" aria-label="Vitesses prédéfinies">
        ${presets.map(preset => html`<button type="button" class="preset"
          aria-pressed=${target === preset.speed ? 'true' : 'false'}
          ?disabled=${this.busy || !targetAllowed(bounds, preset.speed)}
          @click=${() => { void this.changeTarget(preset.speed); }}>
          <ha-icon .icon=${preset.icon} aria-hidden="true"></ha-icon>
          <strong>${preset.label}</strong><span>${reading(preset.speed, 'tr/min', 0)}</span>
        </button>`)}
      </div>
    `;
  }

  render() {
    const config = this.config, hass = this.hass;
    if (!config || !hass) return html`<ha-card><div class="body">En attente de Home Assistant…</div></ha-card>`;
    const on = powerState(hass.states, config.power_entity);
    const heat = this.kind === 'polytropic';
    return html`<ha-card>
      <div class="header">
        <span class="icon-plate"><ha-icon .icon=${heat ? 'mdi:heat-pump' : 'mdi:pump'} aria-hidden="true"></ha-icon></span>
        <div class="heading"><h3>${config.title}</h3><p>${heat ? 'Pompe à chaleur' : 'Pompe de filtration à vitesse variable'}</p></div>
        <ha-switch .checked=${on === true} .disabled=${this.busy || on === undefined}
          aria-label="Marche / arrêt" @change=${this.togglePower}></ha-switch>
      </div>
      <div class="body">
        ${heat ? this.heater(config, hass) : this.pump(config, hass)}
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        ${this.notice ? html`<p class="notice" role="status">${this.notice}</p>` : nothing}
      </div>
    </ha-card>`;
  }

  static styles = css`
    :host{display:block;container-type:inline-size;color:var(--primary-text-color);font-family:var(--ha-font-family-body,inherit)}
    ha-card{overflow:hidden;border-radius:var(--ha-card-border-radius,18px)}
    .header{display:flex;align-items:center;gap:12px;padding:15px 16px;border-bottom:1px solid var(--divider-color);background:linear-gradient(125deg,color-mix(in srgb,var(--primary-color) 10%,var(--ha-card-background,var(--card-background-color))),var(--ha-card-background,var(--card-background-color)))}
    .icon-plate{display:grid;place-items:center;flex:0 0 46px;width:46px;height:46px;border-radius:13px;background:color-mix(in srgb,var(--primary-color) 12%,transparent);color:var(--primary-color)}
    .icon-plate ha-icon{--mdc-icon-size:28px}
    .heading{min-width:0;flex:1}
    .heading h3{margin:0;font-size:calc(1.03rem * var(--fio-font-scale,1.32));line-height:1.28;overflow-wrap:anywhere}
    .heading p{margin:4px 0 0;color:var(--secondary-text-color);font-size:calc(.72rem * var(--fio-font-scale,1.32));line-height:1.3}
    .body{padding:16px;display:flex;flex-direction:column;gap:16px}
    .status-line{display:flex}
    .status{border-radius:999px;padding:5px 12px;background:var(--secondary-background-color);color:var(--secondary-text-color);font-weight:650;font-size:calc(.72rem * var(--fio-font-scale,1.32))}
    .status[data-active=true]{color:var(--success-color,#2e7d32);background:color-mix(in srgb,var(--success-color,#2e7d32) 13%,transparent)}
    .readings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--divider-color);border-radius:10px;overflow:hidden}
    .reading-tile,.target-box{min-width:0;display:flex;align-items:center;gap:11px;padding:12px;background:var(--ha-card-background,var(--card-background-color));font:inherit;color:inherit;text-align:left;border:0}
    .reading-tile:not(:disabled){cursor:pointer}
    .reading-tile:not(:disabled):hover,.info-row:not(:disabled):hover{color:var(--primary-color)}
    .reading-tile ha-icon{flex-shrink:0;color:var(--primary-color);--mdc-icon-size:21px}
    .tile-text{min-width:0;display:flex;flex-direction:column;gap:5px}
    .tile-label,.target-label{color:var(--secondary-text-color);font-size:calc(.7rem * var(--fio-font-scale,1.32));line-height:1.3}
    .tile-text strong{font-size:calc(.98rem * var(--fio-font-scale,1.32));font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .target-box{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
    .target-controls{display:flex;gap:6px;align-items:center;max-width:100%}
    .target-value{font:inherit;color:inherit;white-space:nowrap;padding:4px;border:0;background:transparent;font-size:calc(.9rem * var(--fio-font-scale,1.32));font-weight:700;cursor:pointer}
    ha-button{--ha-button-border-radius:10px}
    .details{border:1px solid var(--divider-color);border-radius:12px;padding:2px 12px}
    .info-row{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 0;width:100%;border:0;border-bottom:1px solid var(--divider-color);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
    .info-row:last-child{border:0}
    .info-row strong{font-size:calc(.82rem * var(--fio-font-scale,1.32));font-variant-numeric:tabular-nums;text-align:right}
    .info-row span{color:var(--secondary-text-color);font-size:calc(.8rem * var(--fio-font-scale,1.32))}
    .speed-panel{padding:14px;border:1px solid var(--divider-color);border-radius:13px}
    .speed-heading,.speed-limits{display:flex;justify-content:space-between;gap:10px;align-items:center}
    .speed-heading strong{font-variant-numeric:tabular-nums}
    .speed-input{display:flex;align-items:center;gap:10px;margin-top:18px}
    .speed-input input{width:100%;flex:1;accent-color:var(--primary-color);cursor:pointer;min-width:0}
    .speed-input input:disabled{cursor:default;opacity:.5}
    .speed-limits{font-size:calc(.7rem * var(--fio-font-scale,1.32));color:var(--secondary-text-color);margin:8px 43px 0}
    .presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .preset{display:flex;flex-direction:column;align-items:center;gap:4px;border:1px solid var(--divider-color);border-radius:12px;padding:10px 5px;background:transparent;color:inherit;font:inherit;cursor:pointer;overflow-wrap:anywhere}
    .preset ha-icon{color:var(--primary-color)}
    .preset span{font-size:calc(.67rem * var(--fio-font-scale,1.32));font-variant-numeric:tabular-nums}
    .preset[aria-pressed=true]{border-color:var(--primary-color);background:color-mix(in srgb,var(--primary-color) 10%,transparent)}
    .preset:disabled{opacity:.45;cursor:default}
    .error,.notice{margin:0;font-size:calc(.76rem * var(--fio-font-scale,1.32));line-height:1.4}
    .error{color:var(--error-color)}.notice{color:var(--secondary-text-color)}
    @container(max-width:370px){.readings{grid-template-columns:minmax(0,1fr)}.presets{gap:4px}.body{padding:12px}.header{padding:12px}}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  `;
}
abstract class FlowioSerialCardEditor extends LitElement {
  static properties = { hass: { attribute: false }, config: { state: true }, error: { state: true } };
  declare hass?: Hass;
  protected abstract readonly kind: SerialCardKind;
  private config?: SerialDeviceCardConfig;
  private error = '';
  setConfig(input: unknown) {
    this.config = normalizeSerialDeviceConfig(input, this.kind); this.error = '';
  }
  private changed(event: CustomEvent) {
    event.stopPropagation();
    try {
      this.config = normalizeSerialDeviceConfig(event.detail.value, this.kind);
      this.error = '';
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: this.config }, bubbles: true, composed: true
      }));
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Configuration invalide';
    }
  }
  render() {
    if (!this.config || !this.hass) return nothing;
    const numberSelector = (min: number, max: number) =>
      ({ number: { min, max, mode: 'box', step: 1 } });
    const schema = [
      { name: 'title', selector: { text: {} } },
      { name: 'entity_prefix', selector: { text: {} } },
      { name: 'device_slot', selector: numberSelector(0, 15) },
      { name: 'power_entity', selector: { text: {} } },
      { name: 'setpoint_entity', selector: { text: {} } },
      ...(this.kind === 'aquagem' ? [
        { name: 'eco_rpm', selector: numberSelector(1, 65535) },
        { name: 'normal_rpm', selector: numberSelector(1, 65535) },
        { name: 'boost_rpm', selector: numberSelector(1, 65535) }
      ] : [])
    ];
    const labels: Record<string, string> = {
      title: 'Titre', entity_prefix: 'Préfixe firmware',
      device_slot: 'Slot PoolDevice (0 à 15)',
      power_entity: 'Entité switch marche/arrêt',
      setpoint_entity: 'Entité number consigne',
      eco_rpm: 'Vitesse Éco (tr/min)',
      normal_rpm: 'Vitesse Normal (tr/min)',
      boost_rpm: 'Vitesse Boost (tr/min)'
    };
    return html`<p>Les commandes passent par Home Assistant. Les sécurités et les limites restent dans Flow.io.</p>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      <ha-form .hass=${this.hass} .data=${this.config} .schema=${schema}
        .computeLabel=${(field: { name: string }) => labels[field.name] ?? field.name}
        @value-changed=${this.changed}></ha-form>`;
  }
  static styles = css`:host{display:block}p{line-height:1.4;color:var(--secondary-text-color)}p[role=alert]{color:var(--error-color)}`;
}
class FlowioPolytropicCard extends FlowioSerialDeviceCard {
  protected readonly kind: SerialCardKind = 'polytropic';
  static getConfigElement() { return document.createElement('flowio-polytropic-card-editor'); }
  static getStubConfig() { return normalizeSerialDeviceConfig({}, 'polytropic'); }
}
class FlowioAquagemCard extends FlowioSerialDeviceCard {
  protected readonly kind: SerialCardKind = 'aquagem';
  static getConfigElement() { return document.createElement('flowio-aquagem-card-editor'); }
  static getStubConfig() { return normalizeSerialDeviceConfig({}, 'aquagem'); }
}
class FlowioPolytropicCardEditor extends FlowioSerialCardEditor {
  protected readonly kind: SerialCardKind = 'polytropic';
}
class FlowioAquagemCardEditor extends FlowioSerialCardEditor {
  protected readonly kind: SerialCardKind = 'aquagem';
}
if (!customElements.get('flowio-polytropic-card'))
  customElements.define('flowio-polytropic-card', FlowioPolytropicCard);
if (!customElements.get('flowio-aquagem-card'))
  customElements.define('flowio-aquagem-card', FlowioAquagemCard);
if (!customElements.get('flowio-polytropic-card-editor'))
  customElements.define('flowio-polytropic-card-editor', FlowioPolytropicCardEditor);
if (!customElements.get('flowio-aquagem-card-editor'))
  customElements.define('flowio-aquagem-card-editor', FlowioAquagemCardEditor);
const registry = window as Window & { customCards?: Array<Record<string, unknown>> };
registry.customCards ??= [];
for (const entry of [
  { type: 'flowio-polytropic-card', name: 'Flow.io PAC Polytropic', description: 'PAC, consigne et télémétrie RS485.', preview: true },
  { type: 'flowio-aquagem-card', name: 'Flow.io AquaGem', description: 'Vitesse de filtration demandée et mesurée.', preview: true }
]) if (!registry.customCards.some(card => card.type === entry.type)) registry.customCards.push(entry);
