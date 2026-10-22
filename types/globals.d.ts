// Globals shared by the ordered page scripts, as the type-checked modules see
// them (tsconfig.json lists those modules). Nothing here is emitted or loaded
// by a page.
//
// Each OptionCombo* namespace is attached to globalThis by its own IIFE. A
// namespace that a checked module consumes is described by exactly the members
// it uses, so the checker holds the consumer to that contract; when the
// provider opts in too, its own assignment is checked against the same shape.
// A namespace no checked module consumes yet stays loosely typed.

// ---------------------------------------------------------------------------
// Language-level facts this codebase relies on
// ---------------------------------------------------------------------------

interface NumberConstructor {
    // `Number.isFinite(x) && x > 0` is the house idiom for untrusted values.
    // A true result proves x is a number; a false one proves nothing, so code
    // must not rely on the narrowing in the false branch.
    isFinite(value: unknown): value is number;
}

// The modules coerce untrusted input with parseFloat/parseInt. Both apply
// ToString first, so any argument is defined behaviour (null -> NaN).
declare function parseFloat(value: unknown): number;
declare function parseInt(value: unknown, radix?: number): number;

// The IIFE footers fall back to `window`, and cost_basis_fop_core.js also
// exports through CommonJS for Node tests; the checked modules use no DOM API.
declare var window: typeof globalThis;
declare var module: { exports: unknown } | undefined;

// ---------------------------------------------------------------------------
// js/date_utils.js (consumed by pricing_core.js)
// ---------------------------------------------------------------------------

/** A scalar lambda or {default, byDate} per-date weights, before normalization. */
type OptionComboWeekendWeight = number | string | null | undefined | OptionComboWeekendWeightSpec | {
    default?: unknown;
    byDate?: Record<string, unknown> | null;
    strictByDate?: boolean;
    coverageStart?: string | null;
    coverageEnd?: string | null;
};

interface OptionComboWeekendWeightSpec {
    default: number;
    byDate: Record<string, number> | null;
    minWeight: number;
    differsFromCalendar: boolean;
    strictByDate: boolean;
    coverageStart: string | null;
    coverageEnd: string | null;
}

/** Observed trading dates (historical replay) as a list or a prepared set. */
type OptionComboObservedTradingDates = string[] | Set<string> | null;

interface OptionComboExpiryCutoff {
    cutoffMs: number;
    cutoffAsOf: string;
    source: 'contract' | 'product-profile';
    timeZone: string;
}

/** resolveWeightedTime(): an exact interval on the weighted variance clock. */
interface OptionComboWeightedTime {
    available: boolean;
    status: string;
    calendarEstimated?: boolean;
    calendarKey: string;
    timeZone: string;
    calendarDays: number | null;
    effectiveDays: number | null;
    tradingDays: number | null;
    nonTradingDays: number | null;
    nonTradingDates: string[];
    missingWeightDates?: string[];
    segments: unknown[];
}

interface OptionComboDateUtilsApi {
    normalizeDateInput(dateStr: unknown): string;
    isTradingDay(dateStr: string, calendarKey?: string,
        observedTradingDates?: OptionComboObservedTradingDates): boolean | null;
    diffDays(d1Str: string, d2Str: string): number;
    calendarToTradingDays(startDateStr: string, endDateStr: string, calendarKey?: string,
        observedTradingDates?: OptionComboObservedTradingDates): number | null;
    countWeightedDays(startDateStr: string, endDateStr: string, weekendWeight: OptionComboWeekendWeight,
        calendarKey?: string, observedTradingDates?: OptionComboObservedTradingDates): number | null;
    normalizeWeekendWeightSpec(value: OptionComboWeekendWeight): OptionComboWeekendWeightSpec;
    resolveExpiryCutoffAsOf(contract: object | null | undefined, profile: OptionComboUnderlyingProfile | null,
        dateOverride?: string | null): OptionComboExpiryCutoff | null;
    resolveWeightedTime(startAsOf: number | string, endAsOf: number | string,
        weekendWeight: OptionComboWeekendWeight, calendarKey?: string,
        observedTradingDates?: OptionComboObservedTradingDates, timeZone?: string,
        tradeDateRolloverHour?: number | null,
        options?: { allowEstimatedCalendar?: boolean } | null): OptionComboWeightedTime;
}

declare var OptionComboDateUtils: OptionComboDateUtilsApi | undefined;

// ---------------------------------------------------------------------------
// js/market_holidays.js (a top-level function, consumed by pricing_core.js)
// ---------------------------------------------------------------------------

declare var isOfficialExchangeCalendarAvailable:
    ((calendarKey: string, startDate: string, endDate?: string) => boolean) | undefined;

// ---------------------------------------------------------------------------
// js/product_registry.js (consumed by pricing_core.js)
// ---------------------------------------------------------------------------

/** The product-family fields pricing reads; the registry's profile carries more. */
interface OptionComboUnderlyingProfile {
    calendarId?: string;
    pricingModel?: string;
    optionSecType?: string;
    optionMultiplier?: number;
    underlyingLegMultiplier?: number;
    settlementUnitsPerContract?: number;
    optionExpiryTimeZone?: string;
    optionExpiryHour?: number;
    optionExpiryMinute?: number;
}

interface OptionComboProductRegistryApi {
    resolveUnderlyingProfile(symbol: unknown): OptionComboUnderlyingProfile;
    isUnderlyingLeg(legOrType: unknown): boolean;
}

declare var OptionComboProductRegistry: OptionComboProductRegistryApi | undefined;

// ---------------------------------------------------------------------------
// js/american_binomial.js (consumed by pricing_core.js)
// ---------------------------------------------------------------------------

interface OptionComboAmericanBinomialApi {
    DEFAULT_STEPS: number;
    normalizeSteps(value: unknown): number;
    calculateAmericanOptionPrice(options: {
        type: string;
        spot: number;
        strike: number;
        varianceTime: number;
        rateTime: number;
        riskFreeRate: number;
        volatility: number;
        dividendYield: number;
        steps: number;
    }): number;
}

declare var OptionComboAmericanBinomial: OptionComboAmericanBinomialApi | undefined;

// ---------------------------------------------------------------------------
// Namespaces the checked modules provide. No checked module consumes them yet,
// so they are recorded loosely; type them when a consumer opts in.
// ---------------------------------------------------------------------------

declare var OptionComboPricingCore: Readonly<Record<string, unknown>> | undefined;
declare var OptionComboCostBasisFopCore: Readonly<Record<string, unknown>> | undefined;
