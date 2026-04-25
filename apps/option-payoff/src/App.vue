<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import PayoffChart from "./components/PayoffChart.vue";
import { fetchInstruments, fetchMarkHistory } from "../../../lib/thalex.js";

const ui = reactive({
  indexName: "BTCUSD",
  filterExpiry: null,
  filterType: "all",
  spotRangeMin: null,
  spotRangeMax: null,
  useCustomRange: false,
  showTotalLine: false,
  loading: false,
  loadingMarks: false,
  error: "",
});

const data = reactive({
  allInstruments: [],
  selectedOptions: [],
  optionMarks: new Map(),
});

const availableOptions = computed(() => {
  const now = Math.floor(Date.now() / 1000);
  return (data.allInstruments || [])
    .filter((inst) => {
      const product = (inst.product || "").toUpperCase();
      const type = (inst.type || inst.instrument_type || "").toLowerCase();
      const underlying = (inst.underlying || "").toUpperCase();
      const idx = (ui.indexName || "").toUpperCase();
      if (type !== "option") return false;
      if (product !== "OBTCUSD" && product !== "OETHUSD") return false;
      if (underlying !== idx) return false;
      const expTs = Number(inst.expiration_timestamp);
      return expTs > now;
    })
    .sort((a, b) => {
      const expA = Number(a.expiration_timestamp);
      const expB = Number(b.expiration_timestamp);
      if (expA !== expB) return expA - expB;
      const strikeA = Number(a.strike_price) || 0;
      const strikeB = Number(b.strike_price) || 0;
      if (strikeA !== strikeB) return strikeA - strikeB;
      const typeA = (a.option_type || "").toLowerCase();
      const typeB = (b.option_type || "").toLowerCase();
      return typeA.localeCompare(typeB);
    });
});

const uniqueExpiries = computed(() => {
  const expiries = new Set();
  for (const inst of availableOptions.value) {
    expiries.add(Number(inst.expiration_timestamp));
  }
  return Array.from(expiries)
    .sort((a, b) => a - b)
    .map((ts) => ({
      expiryTs: ts,
      expiryDate: new Date(ts * 1000),
    }));
});

const filteredOptions = computed(() => {
  let filtered = availableOptions.value;
  if (ui.filterExpiry != null) {
    filtered = filtered.filter((inst) => Number(inst.expiration_timestamp) === ui.filterExpiry);
  }
  if (ui.filterType !== "all") {
    const isCallFilter = ui.filterType === "call";
    filtered = filtered.filter((inst) => isCall(inst) === isCallFilter);
  }
  return filtered;
});

const groupedByExpiry = computed(() => {
  const groups = new Map();
  for (const inst of filteredOptions.value) {
    const expTs = Number(inst.expiration_timestamp);
    if (!groups.has(expTs)) groups.set(expTs, []);
    groups.get(expTs).push(inst);
  }
  return Array.from(groups.entries())
    .map(([expTs, insts]) => ({
      expiryTs: expTs,
      expiryDate: new Date(expTs * 1000),
      instruments: insts,
    }))
    .sort((a, b) => a.expiryTs - b.expiryTs);
});

function formatDate(date) {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatCurrency(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function getStrike(instrument) {
  return Number(instrument.strike_price) || null;
}

function isCall(instrument) {
  const type = (instrument.option_type || "").toLowerCase();
  return type === "call";
}

function addOption(instrument) {
  if (data.selectedOptions.find((o) => o.instrument_name === instrument.instrument_name)) return;
  data.selectedOptions.push({
    instrument_name: instrument.instrument_name,
    strike: getStrike(instrument),
    expiryTs: Number(instrument.expiration_timestamp),
    isCall: isCall(instrument),
    position: "long",
    instrument,
  });
  loadMarks();
}

function togglePosition(index) {
  const opt = data.selectedOptions[index];
  if (opt) {
    opt.position = opt.position === "long" ? "short" : "long";
  }
}

function removeOption(index) {
  data.selectedOptions.splice(index, 1);
  loadMarks();
}

async function loadMarks() {
  if (!data.selectedOptions.length) {
    data.optionMarks.clear();
    return;
  }
  ui.loadingMarks = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const marks = await Promise.all(
      data.selectedOptions.map((opt) =>
        fetchMarkHistory({
          instrument_name: opt.instrument_name,
          resolution: "1d",
          from: now - 86400,
          to: now,
        }).then((rows) => {
          const latest = rows && rows.length > 0 ? rows[rows.length - 1] : null;
          return {
            instrument_name: opt.instrument_name,
            markPrice: latest ? latest.mark_price_close || latest.mark_price || 0 : 0,
          };
        })
      )
    );
    data.optionMarks.clear();
    for (const m of marks) {
      data.optionMarks.set(m.instrument_name, m.markPrice);
    }
  } catch (e) {
    ui.error = e?.message || String(e);
  } finally {
    ui.loadingMarks = false;
  }
}

async function loadInstruments() {
  ui.loading = true;
  ui.error = "";
  try {
    const instruments = await fetchInstruments();
    data.allInstruments = instruments || [];
  } catch (e) {
    ui.error = e?.message || String(e);
  } finally {
    ui.loading = false;
  }
}

onMounted(() => {
  loadInstruments();
});
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Option Profit Diagram</h1>
      </div>

      <div class="controls">
        <div class="field">
          <label for="index">Index</label>
          <select id="index" v-model="ui.indexName">
            <option value="BTCUSD">BTCUSD</option>
            <option value="ETHUSD">ETHUSD</option>
          </select>
        </div>
      </div>

      <div v-if="ui.loading" class="meta">Loading options…</div>
      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <div style="display: grid; grid-template-columns: 320px 1fr; gap: 24px; margin-top: 20px;">
      <div>
        <h2 style="margin: 0 0 12px; font-size: 16px; font-weight: 600;">Select Options</h2>
        
        <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px;">
          <div class="field">
            <label for="filterExpiry">Expiry</label>
            <select id="filterExpiry" v-model.number="ui.filterExpiry">
              <option :value="null">All expiries</option>
              <option
                v-for="exp in uniqueExpiries"
                :key="exp.expiryTs"
                :value="exp.expiryTs"
              >
                {{ formatDate(exp.expiryDate) }}
              </option>
            </select>
          </div>

          <div class="field">
            <label for="filterType">Type</label>
            <select id="filterType" v-model="ui.filterType">
              <option value="all">All</option>
              <option value="call">Calls</option>
              <option value="put">Puts</option>
            </select>
          </div>
        </div>

        <div style="margin-bottom: 12px; padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
            <input
              id="showTotalLine"
              type="checkbox"
              v-model="ui.showTotalLine"
              style="cursor: pointer;"
            />
            <label for="showTotalLine" style="font-size: 13px; font-weight: 600; cursor: pointer;">
              Show total line
            </label>
          </div>

          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
            <input
              id="useCustomRange"
              type="checkbox"
              v-model="ui.useCustomRange"
              style="cursor: pointer;"
            />
            <label for="useCustomRange" style="font-size: 13px; font-weight: 600; cursor: pointer;">
              Custom spot range
            </label>
          </div>
          <div v-if="ui.useCustomRange" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div class="field" style="margin: 0;">
              <label for="spotMin" style="font-size: 12px;">Min spot</label>
              <input
                id="spotMin"
                v-model.number="ui.spotRangeMin"
                type="number"
                min="0"
                step="100"
                placeholder="Min"
                style="width: 100%;"
              />
            </div>
            <div class="field" style="margin: 0;">
              <label for="spotMax" style="font-size: 12px;">Max spot</label>
              <input
                id="spotMax"
                v-model.number="ui.spotRangeMax"
                type="number"
                min="0"
                step="100"
                placeholder="Max"
                style="width: 100%;"
              />
            </div>
          </div>
        </div>

        <div style="max-height: 600px; overflow-y: auto; border: 1px solid var(--border); border-radius: 10px; padding: 12px;">
          <div v-if="!groupedByExpiry.length" class="meta" style="padding: 20px; text-align: center;">
            {{ ui.loading ? "Loading…" : "No tradable options found" }}
          </div>
          <div v-for="group in groupedByExpiry" :key="group.expiryTs" style="margin-bottom: 20px;">
            <div style="font-weight: 600; font-size: 13px; color: var(--text); margin-bottom: 8px;">
              {{ formatDate(group.expiryDate) }}
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <button
                v-for="inst in group.instruments"
                :key="inst.instrument_name"
                type="button"
                class="option-button"
                :class="{ active: data.selectedOptions.some((o) => o.instrument_name === inst.instrument_name) }"
                @click="addOption(inst)"
              >
                <span style="font-weight: 600;">{{ isCall(inst) ? "C" : "P" }}</span>
                <span>{{ formatCurrency(getStrike(inst)) }}</span>
              </button>
            </div>
          </div>
        </div>

        <div v-if="data.selectedOptions.length" style="margin-top: 20px;">
          <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600;">Selected Options</h3>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div
              v-for="(opt, idx) in data.selectedOptions"
              :key="opt.instrument_name"
              style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; font-size: 13px;"
            >
              <div style="display: flex; align-items: center; gap: 8px;">
                <div>
                  <span style="font-weight: 600;">{{ opt.isCall ? "Call" : "Put" }}</span>
                  {{ formatCurrency(opt.strike) }}
                  <span style="color: var(--muted); font-size: 11px;">
                    ({{ formatCurrency(data.optionMarks.get(opt.instrument_name) || 0) }})
                  </span>
                </div>
                <button
                  type="button"
                  @click="togglePosition(idx)"
                  :style="{
                    padding: '4px 8px',
                    fontSize: '11px',
                    fontWeight: '600',
                    background: opt.position === 'long' ? '#5cb85c' : 'var(--danger)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }"
                >
                  {{ opt.position === "long" ? "Long" : "Short" }}
                </button>
              </div>
              <button type="button" @click="removeOption(idx)" style="background: transparent; border: 0; color: var(--danger); cursor: pointer; padding: 4px 8px;">×</button>
            </div>
          </div>
        </div>
      </div>

      <PayoffChart
        :selected-options="data.selectedOptions"
        :option-marks="data.optionMarks"
        :index-name="ui.indexName"
        :loading="ui.loadingMarks"
        :spot-range-min="ui.useCustomRange ? ui.spotRangeMin : null"
        :spot-range-max="ui.useCustomRange ? ui.spotRangeMax : null"
        :show-total-line="ui.showTotalLine"
      />
    </div>
  </div>
</template>

<style scoped>
.option-button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.option-button:hover {
  background: color-mix(in oklab, var(--panel), #1b1f2f 35%);
  border-color: var(--accent);
}

.option-button.active {
  background: color-mix(in oklab, var(--accent), transparent 85%);
  border-color: var(--accent);
  color: var(--accent);
}
</style>
