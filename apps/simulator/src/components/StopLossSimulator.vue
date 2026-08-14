<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import CloudChart from "./CloudChart.vue";
import StyledSelectMenu from "./StyledSelectMenu.vue";
import type { AtmOptionExpiryQuote } from "../lib/atmOptionChain";
import type { GBMParams } from "../lib/gbm";
import type { PathModelParams } from "../lib/pathModel";
import type { PositionLeg } from "../lib/position";
import {
  closestExpirationTs,
  maturityOptionsForQuotes,
  selectableExpiryQuotes,
  type StopLossDirection,
} from "../lib/stopLossMaturity";
import type {
  HistogramBinHover,
  HistogramBinStats,
  SimulationStats,
} from "../lib/simulation";

const props = defineProps<{
  seed: number;
  params: GBMParams;
  pathModel: PathModelParams;
  valuationTs: number;
  samplePathLimit: number;
  colorMin: number;
  colorMax: number;
  histBinsMultiplier: number;
  expiryQuotes: AtmOptionExpiryQuote[];
}>();

const emit = defineEmits<{
  (event: "set-mu", value: number): void;
  (event: "set-vol", value: number): void;
}>();

type ComparisonHistogramMode = "payoff" | "prob";
type StopPathSummary = {
  stoppedPathCount: number;
  sampledPathCount: number;
  highlightedLoss: number;
  stopDay: number;
  finalPrice: number;
  opportunityCost: number;
};

const SECONDS_PER_DAY = 24 * 60 * 60;
const DAYS_PER_YEAR = 365.25;
const MATURITY_DAYS = [7, 14, 30, 60, 90, 180] as const;
const DAY_OPTIONS = MATURITY_DAYS.map((days) => ({
  label: `${days}d`,
  value: days,
}));
const DEFAULT_MATURITY_DAYS = 60;
const EMPTY_OPTION_PRICING = Object.freeze({});
const direction = ref<StopLossDirection>("up");
const histogramMode = ref<ComparisonHistogramMode>("prob");
const evCurveMode = ref(false);
const pathFilter = ref<"all" | "stopped">("all");
const riskBudget = ref(10_000);
const leverage = ref(10);
const leverageDraft = ref(10);
const annualFundingPercent = ref(8);
const horizonDays = ref(14);
const selectedExpirationTs = ref(0);
const optionStats = ref<SimulationStats | null>(null);
const perpStats = ref<SimulationStats | null>(null);
const hoveredBinStats = ref<HistogramBinHover | null>(null);
const stopPathSummary = ref<StopPathSummary | null>(null);

type TableStats = Pick<
  SimulationStats,
  | "meanPayoff"
  | "medianPayoff"
  | "winRate"
  | "maxLossRate"
  | "opportunityCost"
>;

const binToTableStats = (
  bin: HistogramBinStats | null | undefined,
): TableStats | null => {
  if (!bin) return null;
  return {
    meanPayoff: bin.meanPayoff,
    medianPayoff: bin.medianPayoff,
    winRate: bin.winRate,
    maxLossRate: bin.maxLossRate,
    opportunityCost: bin.opportunityCost,
  };
};


const leverageDetailsRef = ref<HTMLDetailsElement | null>(null);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const setRiskBudget = (value: number): void => {
  riskBudget.value = Number.isFinite(value)
    ? clamp(value, 1, 10_000_000)
    : 10_000;
};

const setLeverage = (value: number): void => {
  const next = Number.isFinite(value) ? clamp(value, 1, 100) : 10;
  leverage.value = next;
  leverageDraft.value = next;
};
const LEVERAGE_DEBOUNCE_MS = 180;
const LEVERAGE_AUTOCLOSE_MS = 2000;
let leverageDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let leverageAutocloseTimer: ReturnType<typeof setTimeout> | null = null;

const clearLeverageAutocloseTimer = (): void => {
  if (leverageAutocloseTimer != null) {
    clearTimeout(leverageAutocloseTimer);
    leverageAutocloseTimer = null;
  }
};

const closeLeveragePopover = (): void => {
  if (leverageDetailsRef.value) {
    leverageDetailsRef.value.open = false;
  }
  clearLeverageAutocloseTimer();
};

const scheduleLeverageAutoclose = (): void => {
  clearLeverageAutocloseTimer();
  if (!leverageDetailsRef.value?.open) return;
  leverageAutocloseTimer = setTimeout(
    closeLeveragePopover,
    LEVERAGE_AUTOCLOSE_MS,
  );
};

const handleLeverageDetailsToggle = (): void => {
  if (leverageDetailsRef.value?.open) {
    scheduleLeverageAutoclose();
  } else {
    clearLeverageAutocloseTimer();
  }
};

const handleOutsidePointerDown = (event: PointerEvent): void => {
  const details = leverageDetailsRef.value;
  if (
    details?.open &&
    event.target instanceof Node &&
    !details.contains(event.target)
  ) {
    closeLeveragePopover();
  }
};

const setLeverageDraft = (value: number): void => {
  leverageDraft.value = Number.isFinite(value) ? clamp(value, 1, 100) : 10;
  scheduleLeverageAutoclose();
  if (leverageDebounceTimer != null) {
    clearTimeout(leverageDebounceTimer);
  }
  leverageDebounceTimer = setTimeout(() => {
    leverageDebounceTimer = null;
    setLeverage(leverageDraft.value);
  }, LEVERAGE_DEBOUNCE_MS);
};

onMounted(() => {
  document.addEventListener("pointerdown", handleOutsidePointerDown);
});

onUnmounted(() => {
  if (leverageDebounceTimer != null) {
    clearTimeout(leverageDebounceTimer);
  }
  clearLeverageAutocloseTimer();
  document.removeEventListener("pointerdown", handleOutsidePointerDown);
});

const setFunding = (value: number): void => {
  annualFundingPercent.value = Number.isFinite(value)
    ? clamp(value, -100, 100)
    : 8;
};

const selectableQuotes = computed(() =>
  selectableExpiryQuotes(
    props.expiryQuotes,
    props.valuationTs,
    horizonDays.value,
    direction.value,
  ),
);

const maturityOptions = computed(() =>
  maturityOptionsForQuotes(selectableQuotes.value, props.valuationTs),
);

watch(
  selectableQuotes,
  (quotes) => {
    if (
      quotes.some(
        (quote) => quote.expirationTs === selectedExpirationTs.value,
      )
    ) {
      return;
    }
    const targetExpirationTs =
      selectedExpirationTs.value ||
      props.valuationTs + DEFAULT_MATURITY_DAYS * SECONDS_PER_DAY;
    selectedExpirationTs.value =
      closestExpirationTs(quotes, targetExpirationTs) ?? 0;
  },
  { immediate: true },
);

const selectedExpiryQuote = computed(
  () =>
    selectableQuotes.value.find(
      (quote) => quote.expirationTs === selectedExpirationTs.value,
    ) ?? null,
);

const selectedOptionMark = computed(() => {
  const quote = selectedExpiryQuote.value;
  if (!quote) return null;
  return direction.value === "up" ? quote.callMark : quote.putMark;
});

const selectedInstrumentName = computed(() => {
  const quote = selectedExpiryQuote.value;
  if (!quote) return "ATM option";
  return direction.value === "up"
    ? quote.callInstrumentName
    : quote.putInstrumentName ?? quote.callInstrumentName;
});

const toggleHistogramMode = (): void => {
  histogramMode.value =
    histogramMode.value === "prob" ? "payoff" : "prob";
};

const setEvCurveMode = (enabled: boolean): void => {
  evCurveMode.value = enabled;
  pathFilter.value = "all";
  hoveredBinStats.value = null;
};

watch(
  () => [
    props.seed,
    props.params.s0,
    props.params.mu,
    props.params.vol,
    direction.value,
    riskBudget.value,
    leverage.value,
    annualFundingPercent.value,
    horizonDays.value,
    selectedExpirationTs.value,
    selectedExpiryQuote.value?.callIv,
    selectedOptionMark.value,
    evCurveMode.value,
  ],
  () => {
    optionStats.value = null;
    perpStats.value = null;
    hoveredBinStats.value = null;
    stopPathSummary.value = null;
  },
);

const comparisonParams = computed<GBMParams>(() => {
  const T = horizonDays.value / DAYS_PER_YEAR;
  return {
    ...props.params,
    T,
    dt: 1 / (DAYS_PER_YEAR * 24),
  };
});

const optionType = computed(() => (direction.value === "up" ? "call" : "put"));
const perpSide = computed(() => (direction.value === "up" ? "buy" : "sell"));
const optionLabel = computed(() =>
  direction.value === "up" ? "Long ATM call" : "Long ATM put",
);
const perpLabel = computed(() =>
  direction.value === "up" ? "Long perpetual" : "Short perpetual",
);

const optionPremium = computed(() =>
  Number.isFinite(selectedOptionMark.value)
    ? Math.max(0, Number(selectedOptionMark.value))
    : 0,
);

const optionContracts = computed(() =>
  optionPremium.value > 0 ? riskBudget.value / optionPremium.value : 0,
);

const optionLegs = computed<PositionLeg[]>(() => [
  {
    id: "stop-loss-option",
    kind: "option",
    side: "buy",
    qty: optionContracts.value,
    optionType: optionType.value,
    strike: selectedExpiryQuote.value?.strike ?? props.params.s0,
    premium: optionPremium.value,
  },
]);

const optionPricing = computed(() => ({
  "stop-loss-option": {
    iv: selectedExpiryQuote.value?.callIv ?? null,
    mark: optionPremium.value,
    expirationTs: selectedExpiryQuote.value?.expirationTs ?? null,
  },
}));

const perpContracts = computed(() => {
  const spot = Number(props.params.s0);
  if (!Number.isFinite(spot) || spot <= 0) return 0;
  return (riskBudget.value * leverage.value) / spot;
});

const stopDistance = computed(() =>
  perpContracts.value > 0 ? riskBudget.value / perpContracts.value : 0,
);
const stopPrice = computed(() =>
  direction.value === "up"
    ? Math.max(0, props.params.s0 - stopDistance.value)
    : props.params.s0 + stopDistance.value,
);
const perpLegs = computed<PositionLeg[]>(() => [
  {
    id: "stop-loss-perp",
    kind: "future",
    side: perpSide.value,
    qty: perpContracts.value,
    entry: props.params.s0,
    stopLoss: stopPrice.value,
    annualFundingRate: annualFundingPercent.value / 100,
  },
]);

const formatUsd = (value: number, digits = 0): string => {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
};

const formatSignedUsd = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
  })}`;
};

const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";

const formatSignedPercentagePoints = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const points = value * 100;
  const sign = points > 0 ? "+" : points < 0 ? "−" : "";
  return `${sign}${Math.abs(points).toFixed(1)} pp`;
};

const optionMarketReady = computed(
  () =>
    Number.isFinite(selectedExpiryQuote.value?.callIv) &&
    Number(selectedExpiryQuote.value?.callIv) > 0 &&
    Number.isFinite(selectedOptionMark.value) &&
    Number(selectedOptionMark.value) > 0,
);

const optionResultStats = computed(() =>
  optionMarketReady.value ? optionStats.value : null,
);

const optionDisplayStats = computed<TableStats | null>(() => {
  if (!optionMarketReady.value) return null;
  if (hoveredBinStats.value) {
    return binToTableStats(hoveredBinStats.value.primary);
  }
  return optionResultStats.value;
});

const perpDisplayStats = computed<TableStats | null>(() => {
  if (hoveredBinStats.value) {
    return binToTableStats(hoveredBinStats.value.comparison);
  }
  return perpStats.value;
});

const hoveredPriceRangeLabel = computed(() => {
  const primary = hoveredBinStats.value?.primary;
  const comparison = hoveredBinStats.value?.comparison;
  const bin = primary ?? comparison;
  if (!bin) return null;
  return `${formatUsd(bin.priceMin)} – ${formatUsd(bin.priceMax)}`;
});
</script>

<template>
  <section class="stop-loss-simulator">
    <div class="comparison-bar">
      <div class="direction-toggle" role="group" aria-label="Market direction">
        <button
          type="button"
          :class="{ 'is-active': direction === 'up' }"
          :aria-pressed="direction === 'up'"
          @click="direction = 'up'"
        >
          Long
        </button>
        <button
          type="button"
          :class="{ 'is-active': direction === 'down' }"
          :aria-pressed="direction === 'down'"
          @click="direction = 'down'"
        >
          Short
        </button>
      </div>

      <label class="control-pill control-pill--risk">
        <span class="pill-label">Risk</span>
        <span class="pill-value">
          $
          <input
            type="number"
            min="1"
            max="10000000"
            step="100"
            :value="riskBudget"
            @change="
              setRiskBudget(Number(($event.target as HTMLInputElement).value))
            "
            @blur="
              setRiskBudget(Number(($event.target as HTMLInputElement).value))
            "
          />
        </span>
      </label>
      <details
        ref="leverageDetailsRef"
        class="control-pill leverage-control"
        @toggle="handleLeverageDetailsToggle"
      >
        <summary>
          <span class="pill-label">Leverage</span>
          <span class="pill-value">{{ leverageDraft }}×</span>
        </summary>
        <div class="leverage-popover">
          <div class="leverage-popover-head">
            <span>Leverage</span>
            <strong>{{ leverageDraft }}×</strong>
          </div>
          <input
            class="leverage-slider"
            type="range"
            min="1"
            max="100"
            step="1"
            :value="leverageDraft"
            aria-label="Perpetual leverage"
            @input="
              setLeverageDraft(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
          <div class="leverage-scale">
            <span>1×</span>
            <span>100×</span>
          </div>
        </div>
      </details>
      <label class="control-pill control-pill--funding">
        <span class="pill-label">Funding</span>
        <span class="pill-value">
          <input
            type="number"
            min="-100"
            max="100"
            step="0.5"
            :value="annualFundingPercent"
            @change="
              setFunding(Number(($event.target as HTMLInputElement).value))
            "
            @blur="
              setFunding(Number(($event.target as HTMLInputElement).value))
            "
          />
          % / yr
        </span>
      </label>
      <div class="control-pill select-pill">
        <span class="pill-label">Horizon</span>
        <span class="pill-value">
          <StyledSelectMenu
            v-model="horizonDays"
            label="Horizon"
            :options="DAY_OPTIONS"
            embedded
          />
        </span>
      </div>
      <div class="control-pill select-pill">
        <span class="pill-label">Maturity</span>
        <span class="pill-value">
          <StyledSelectMenu
            v-if="maturityOptions.length"
            v-model="selectedExpirationTs"
            label="Maturity"
            :options="maturityOptions"
            embedded
          />
          <span v-else>—</span>
        </span>
      </div>
      <button
        v-if="!evCurveMode"
        type="button"
        class="histogram-mode-button"
        :aria-label="`Histogram mode: ${
          histogramMode === 'prob' ? 'probability times PnL' : 'PnL'
        }`"
        @click="toggleHistogramMode"
      >
        {{ histogramMode === "prob" ? "Prob × PnL" : "PnL" }}
      </button>
      <div class="path-mode-toggle" role="group" aria-label="Path display mode">
        <button
          type="button"
          :class="{ 'is-active': !evCurveMode }"
          :aria-pressed="!evCurveMode"
          @click="setEvCurveMode(false)"
        >
          Cloud
        </button>
        <button
          type="button"
          :class="{ 'is-active': evCurveMode }"
          :aria-pressed="evCurveMode"
          @click="setEvCurveMode(true)"
        >
          Cumul
        </button>
      </div>
    </div>

    <article class="comparison-row">
      <header>
        <div class="comparison-chart-title">
          <div class="instrument-meta">
            <span>{{ selectedInstrumentName }}</span>
            <small>
              IV
              {{
                Number.isFinite(selectedExpiryQuote?.callIv)
                  ? `${(Number(selectedExpiryQuote?.callIv) * 100).toFixed(1)}%`
                  : "—"
              }}
            </small>
            <small>
              RV
              {{
                Number.isFinite(params.vol)
                  ? `${(params.vol * 100).toFixed(1)}%`
                  : "—"
              }}
            </small>
          </div>
          <button
            v-if="!evCurveMode"
            type="button"
            class="stopped-path-filter"
            role="checkbox"
            :class="{ 'is-active': pathFilter === 'stopped' }"
            :aria-checked="pathFilter === 'stopped'"
            @click="pathFilter = pathFilter === 'stopped' ? 'all' : 'stopped'"
          >
            <i aria-hidden="true"></i>
            Stopped-out paths
          </button>
          <small
            v-if="pathFilter === 'stopped'"
            class="stop-summary-inline"
          >
            <template v-if="stopPathSummary">
              {{ stopPathSummary.stoppedPathCount }} stopped · high
              {{ formatUsd(stopPathSummary.finalPrice) }} · worst
              {{ formatSignedUsd(stopPathSummary.highlightedLoss) }}
            </template>
            <template v-else>No displayed stops</template>
          </small>
        </div>
      </header>
      <div class="comparison-chart">
        <CloudChart
          v-if="optionMarketReady"
          :seed="seed"
          :params="comparisonParams"
          :pathModel="pathModel"
          :valuationTs="valuationTs"
          :samplePathLimit="samplePathLimit"
          :muMin="-5"
          :muMax="5"
          :volMin="0.1"
          :volMax="1.2"
          :histMode="histogramMode"
          :histogramOpacity="0.45"
          :colorMin="colorMin"
          :colorMax="colorMax"
          :histBinsMultiplier="histBinsMultiplier"
          :legs="optionLegs"
          :optionPricingByLegId="optionPricing"
          :comparisonLegs="perpLegs"
          :comparisonOptionPricingByLegId="EMPTY_OPTION_PRICING"
          :primarySeriesLabel="optionLabel"
          :comparisonSeriesLabel="perpLabel"
          :comparisonReferencePrice="stopPrice"
          :pathFilter="pathFilter"
          :evCurveMode="evCurveMode"
          @set-mu="emit('set-mu', $event)"
          @set-vol="emit('set-vol', $event)"
          @stats-update="optionStats = $event"
          @comparison-stats-update="perpStats = $event"
          @stop-path-update="stopPathSummary = $event"
          @histogram-bin-hover="hoveredBinStats = $event"
        />
        <div v-else class="comparison-chart-loading">
          Loading selected option quote…
        </div>
      </div>
      <div
        v-if="!evCurveMode"
        class="comparison-table-wrap"
        :class="{ 'is-bin-filtered': hoveredBinStats != null }"
        aria-live="polite"
      >
        <table class="comparison-table">
          <thead>
            <tr>
              <th scope="col">
                Metric
                <small v-if="hoveredPriceRangeLabel" class="bin-filter-label">
                  {{ hoveredPriceRangeLabel }}
                </small>
              </th>
              <th scope="col"><i class="option-swatch"></i>Option</th>
              <th scope="col"><i class="perp-swatch"></i>Perp</th>
              <th scope="col">Option − perp</th>
            </tr>
          </thead>
          <tbody>
            <tr class="pnl-row">
              <th scope="row">Average PnL</th>
              <td>
                {{ formatSignedUsd(optionDisplayStats?.meanPayoff ?? NaN) }}
              </td>
              <td>{{ formatSignedUsd(perpDisplayStats?.meanPayoff ?? NaN) }}</td>
              <td>
                {{
                  formatSignedUsd(
                    (optionDisplayStats?.meanPayoff ?? NaN) -
                      (perpDisplayStats?.meanPayoff ?? NaN),
                  )
                }}
              </td>
            </tr>
            <tr class="pnl-row">
              <th scope="row">Median PnL</th>
              <td>
                {{ formatSignedUsd(optionDisplayStats?.medianPayoff ?? NaN) }}
              </td>
              <td>{{ formatSignedUsd(perpDisplayStats?.medianPayoff ?? NaN) }}</td>
              <td>
                {{
                  formatSignedUsd(
                    (optionDisplayStats?.medianPayoff ?? NaN) -
                      (perpDisplayStats?.medianPayoff ?? NaN),
                  )
                }}
              </td>
            </tr>
            <tr>
              <th scope="row">Win probability</th>
              <td>{{ formatPercent(optionDisplayStats?.winRate ?? NaN) }}</td>
              <td>{{ formatPercent(perpDisplayStats?.winRate ?? NaN) }}</td>
              <td>
                {{
                  formatSignedPercentagePoints(
                    (optionDisplayStats?.winRate ?? NaN) -
                      (perpDisplayStats?.winRate ?? NaN),
                  )
                }}
              </td>
            </tr>
            <tr class="max-loss-row">
              <th scope="row">Max loss probability</th>
              <td>{{ formatPercent(optionDisplayStats?.maxLossRate ?? NaN) }}</td>
              <td>{{ formatPercent(perpDisplayStats?.maxLossRate ?? NaN) }}</td>
              <td>
                {{
                  formatSignedPercentagePoints(
                    (optionDisplayStats?.maxLossRate ?? NaN) -
                      (perpDisplayStats?.maxLossRate ?? NaN),
                  )
                }}
              </td>
            </tr>
            <tr>
              <th scope="row">Opportunity cost</th>
              <td>{{ formatSignedUsd(0) }}</td>
              <td>
                {{ formatSignedUsd(perpDisplayStats?.opportunityCost ?? NaN) }}
              </td>
              <td>
                {{
                  formatSignedUsd(
                    0 - (perpDisplayStats?.opportunityCost ?? NaN),
                  )
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

  </section>
</template>

<style scoped>
.stop-loss-simulator {
  padding: 6px 0 56px;
  color: var(--color-text);
}

.direction-toggle {
  display: flex;
  box-sizing: border-box;
  height: 36px;
  gap: 2px;
  padding: 3px;
  border: 0;
  border-radius: 7px;
  background: #111216;
}

.direction-toggle button {
  min-width: 58px;
  height: 30px;
  padding: 0 13px;
  border-radius: 5px;
  color: #8b929a;
  font-size: 11px;
  font-weight: 500;
  text-align: center;
}

.direction-toggle button.is-active {
  background: #1a1c21;
  color: #f1f3f5;
}

.comparison-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px;
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  background: #0b0c0f;
  font-family: "Helvetica Neue", Helvetica, -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
}

.comparison-bar .direction-toggle {
  flex: 0 0 auto;
}

.comparison-bar .direction-toggle button {
  min-width: 58px;
  padding: 0 13px;
}

.control-pill {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  box-sizing: border-box;
  height: 36px;
  gap: 10px;
  min-width: 0;
  padding: 0 11px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  white-space: nowrap;
}

.control-pill:hover,
.control-pill:focus-within {
  border-color: rgba(255, 255, 255, 0.22);
}

.pill-label {
  color: #70767d;
  font-size: 10px;
  font-family: inherit;
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1;
}

.pill-value {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  color: #e8eaed;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.pill-value input {
  min-width: 0;
  outline: 0;
  color: inherit;
  font: inherit;
  font-variant-numeric: inherit;
}

.pill-value input {
  width: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
}

.control-pill--risk .pill-value,
.control-pill--funding .pill-value {
  gap: 3px;
}

.control-pill--risk .pill-value input {
  width: 38px;
}

.control-pill--funding .pill-value input {
  width: 25px;
}

.pill-value input::-webkit-inner-spin-button,
.pill-value input::-webkit-outer-spin-button {
  appearance: none;
}

.select-pill {
  flex: 0 0 auto;
}

.leverage-control {
  position: relative;
  padding: 0;
}

.leverage-control summary {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  height: 34px;
  gap: 10px;
  padding: 0 11px;
  cursor: pointer;
  list-style: none;
}

.leverage-control summary::-webkit-details-marker {
  display: none;
}

.leverage-popover {
  position: absolute;
  z-index: 20;
  top: calc(100% + 8px);
  left: 50%;
  width: 220px;
  padding: 11px 12px 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(9, 13, 20, 0.97);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  transform: translateX(-50%);
}

.leverage-popover-head,
.leverage-scale {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.leverage-popover-head {
  margin-bottom: 8px;
  color: #7c848d;
  font-size: 9px;
  font-family: inherit;
  text-transform: uppercase;
}

.leverage-popover-head strong {
  color: #f1f5f9;
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.leverage-slider {
  width: 100%;
  height: 16px;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

.leverage-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.leverage-slider::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border: 1px solid rgba(2, 6, 23, 0.9);
  border-radius: 50%;
  appearance: none;
  background: #f8fafc;
}

.leverage-slider::-moz-range-track {
  height: 4px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.leverage-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 1px solid rgba(2, 6, 23, 0.9);
  border-radius: 50%;
  background: #f8fafc;
}

.leverage-scale {
  margin-top: 2px;
  color: rgba(148, 163, 184, 0.9);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.select-pill :deep(.styled-select) {
  width: 28px;
}

.comparison-controls {
  display: grid;
  grid-template-columns:
    repeat(4, minmax(116px, 1fr))
    minmax(330px, 2.3fr)
    minmax(154px, auto);
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #0e0f12;
}

.comparison-controls label {
  display: grid;
  gap: 7px;
  min-width: 0;
  color: #777f88;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.input-shell {
  display: flex;
  align-items: center;
  height: 34px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 7px;
  background: #15161a;
  color: #818992;
  font-size: 11px;
  text-transform: none;
}

.input-shell:focus-within {
  border-color: rgba(255, 255, 255, 0.28);
}

.input-shell input {
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 0 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: #eef0f2;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  appearance: textfield;
}

.input-shell select {
  min-width: 0;
  width: 100%;
  height: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: #eef0f2;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.input-shell--select {
  padding-right: 6px;
}

.input-shell input::-webkit-inner-spin-button,
.input-shell input::-webkit-outer-spin-button {
  appearance: none;
}

.input-shell--suffix input {
  text-align: right;
}

.market-source {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  padding: 0 15px;
  border-right: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  border-left: 1px solid var(--color-border);
  border-radius: 0 0 9px 9px;
  color: #646c74;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.market-source strong {
  color: #899098;
  font-size: 9px;
  font-weight: 600;
}

.market-source-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6c737a;
}

.market-source.is-live .market-source-dot {
  background: #8bc2a5;
}

.market-source span + span::before {
  margin-right: 10px;
  color: #3f454b;
  content: "·";
}

.comparison-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;
}

.summary-card {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #0d0e11;
}

.summary-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.summary-card-head strong {
  color: #e9ebed;
  font-size: 12px;
  font-weight: 600;
}

.product-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.summary-card--option .product-dot,
.option-swatch {
  background: #8fc5ed;
}

.summary-card--perp .product-dot,
.perp-swatch {
  background: #f8b36f;
}

.product-tag {
  margin-left: auto;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: #89919a;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.summary-card dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin: 0;
}

.summary-card dl div {
  min-width: 0;
}

.summary-card dt {
  margin-bottom: 5px;
  color: #626a72;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.summary-card dd {
  overflow: hidden;
  margin: 0;
  color: #cbd0d5;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comparison-row {
  overflow: hidden;
  margin-top: 2px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #0b0c0f;
}

.comparison-row > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  height: 30px;
  min-height: 0;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.comparison-chart-title {
  display: flex;
  align-items: center;
  height: 100%;
  gap: 20px;
  min-width: 0;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.instrument-meta {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: 0;
  gap: 12px;
  line-height: 1;
}

.instrument-meta span {
  overflow: hidden;
  color: #a9afb5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instrument-meta small {
  flex: 0 0 auto;
  color: #666e76;
  font-size: inherit;
}

.comparison-chart-title .stop-summary-inline {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: #7e868e;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-number {
  color: #4f565e;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.row-stats span {
  color: #606870;
}

.row-stats strong {
  margin-left: 3px;
  color: #aeb4ba;
  font-variant-numeric: tabular-nums;
}

.stopped-path-filter {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  padding: 0;
  color: #6f7780;
  font-size: 9px;
  font-weight: 400;
  line-height: 1;
  text-align: left;
}

.stopped-path-filter i {
  box-sizing: border-box;
  width: 10px;
  height: 10px;
  border: 1px solid rgba(242, 245, 247, 0.82);
  border-radius: 1px;
  background: transparent;
}

.stopped-path-filter:hover,
.stopped-path-filter.is-active {
  color: #d8dcdf;
}

.stopped-path-filter.is-active i {
  border-color: #f2f5f7;
  background: #f2f5f7;
  box-shadow: none;
}

.stopped-path-filter span {
  color: #8f969d;
}

.histogram-mode-button {
  box-sizing: border-box;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.025);
  color: #d4d8dc;
  font-family: inherit;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}

.histogram-mode-button:hover,
.histogram-mode-button:focus-visible {
  border-color: rgba(255, 255, 255, 0.22);
}

.path-mode-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  box-sizing: border-box;
  height: 36px;
  margin-left: auto;
  padding: 3px;
  border-radius: 7px;
  background: #111216;
}

.path-mode-toggle button {
  min-width: 48px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #7b828a;
  font-family: inherit;
  font-size: 10px;
  font-weight: 550;
  white-space: nowrap;
}

.path-mode-toggle button:hover {
  color: #d4d8dc;
}

.path-mode-toggle button.is-active {
  background: #1a1c21;
  color: #f1f3f5;
}

.comparison-chart {
  position: relative;
  width: 100%;
  aspect-ratio: 2.15 / 1;
  --chart-header-height: 0px;
  --chart-legend-height: 0px;
}

.comparison-chart-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #626971;
  font-size: 10px;
}

.comparison-table-wrap {
  position: relative;
  z-index: 3;
  overflow-x: auto;
  margin-top: -68px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  background: #0b0c0f;
}

.comparison-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  color: #cbd0d5;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.comparison-table th,
.comparison-table td {
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
  text-align: right;
}

.comparison-table th:first-child,
.comparison-table td:first-child {
  text-align: left;
}

.comparison-table thead th {
  color: #6f7780;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-family: "Helvetica Neue", Helvetica, -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
}

.comparison-table thead th .bin-filter-label {
  display: block;
  margin-top: 3px;
  color: #9aa3ab;
  font-size: 8px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: none;
}

.comparison-table-wrap.is-bin-filtered .comparison-table tbody td {
  transition: color 80ms ease;
}

.comparison-table thead th:last-child {
  font-weight: 400;
}

.comparison-table tbody th {
  color: #8e969e;
  font-weight: 500;
}

.comparison-table tbody td:last-child {
  color: #e1e4e7;
  font-weight: 400;
}

.comparison-table .pnl-row th,
.comparison-table .pnl-row td {
  background: rgba(255, 255, 255, 0.025);
}

.comparison-table .pnl-row td:nth-child(2) {
  color: #9fcdf0;
  background: rgba(102, 174, 232, 0.08);
}

.comparison-table .pnl-row td:nth-child(3) {
  color: #efaa63;
  background: rgba(223, 127, 36, 0.08);
}

.comparison-table i {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 2px;
  opacity: 0.75;
}

.comparison-table tbody tr:last-child th,
.comparison-table tbody tr:last-child td {
  border-bottom: 0;
}

@media (max-width: 1050px) {
  .comparison-bar {
    flex-wrap: wrap;
  }

  .comparison-controls {
    grid-template-columns: repeat(4, minmax(120px, 1fr));
  }

  .expiry-field {
    grid-column: span 3;
  }
}

@media (max-width: 760px) {
  .direction-toggle {
    width: 100%;
  }

  .direction-toggle button {
    flex: 1;
    min-width: 0;
  }

  .comparison-bar .direction-toggle {
    width: 100%;
  }

  .control-pill {
    flex: 1 1 calc(50% - 6px);
  }

  .comparison-controls {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }

  .expiry-field {
    grid-column: 1 / -1;
  }

  .comparison-summary {
    grid-template-columns: 1fr;
  }

  .market-source {
    align-items: flex-start;
    flex-wrap: wrap;
    height: auto;
    padding-top: 8px;
    padding-bottom: 8px;
  }

  .summary-card dl {
    grid-template-columns: 1fr 1fr;
  }

  .comparison-row > header {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding-top: 12px;
    padding-bottom: 12px;
  }

  .comparison-chart {
    aspect-ratio: 1.5 / 1;
  }

  .comparison-table-wrap {
    margin-top: -40px;
  }
}
</style>
