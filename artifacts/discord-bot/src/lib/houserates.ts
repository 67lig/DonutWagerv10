import { getConfig, setConfig } from "./db.js";

export interface HouseRates {
  base: number;
  big: number;
  whale: number;
  mega: number;
}

export const DEFAULT_RATES: HouseRates = {
  base: 0.56,
  big: 0.58,
  whale: 0.62,
  mega: 0.64,
};

export const BIG_BET_THRESHOLD = 49_000_000n;
export const WHALE_BET_THRESHOLD = 74_000_000n;
export const MEGA_WHALE_BET_THRESHOLD = 99_000_000n;

let _cache: HouseRates | null = null;
let _cacheTime = 0;
const TTL = 30_000;

export async function getHouseRates(): Promise<HouseRates> {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;
  const [base, big, whale, mega] = await Promise.all([
    getConfig("house_rate_base"),
    getConfig("house_rate_big"),
    getConfig("house_rate_whale"),
    getConfig("house_rate_mega"),
  ]);
  _cache = {
    base: base !== null ? Math.min(1, Math.max(0, parseFloat(base))) : DEFAULT_RATES.base,
    big: big !== null ? Math.min(1, Math.max(0, parseFloat(big))) : DEFAULT_RATES.big,
    whale: whale !== null ? Math.min(1, Math.max(0, parseFloat(whale))) : DEFAULT_RATES.whale,
    mega: mega !== null ? Math.min(1, Math.max(0, parseFloat(mega))) : DEFAULT_RATES.mega,
  };
  _cacheTime = Date.now();
  return _cache;
}

export function invalidateHouseRatesCache(): void {
  _cache = null;
}

export async function saveHouseRates(rates: HouseRates): Promise<void> {
  await Promise.all([
    setConfig("house_rate_base", String(rates.base)),
    setConfig("house_rate_big", String(rates.big)),
    setConfig("house_rate_whale", String(rates.whale)),
    setConfig("house_rate_mega", String(rates.mega)),
  ]);
  _cache = rates;
  _cacheTime = Date.now();
}

export function rateForBet(rates: HouseRates, bet?: bigint): number {
  if (bet !== undefined) {
    if (bet > MEGA_WHALE_BET_THRESHOLD) return rates.mega;
    if (bet > WHALE_BET_THRESHOLD) return rates.whale;
    if (bet > BIG_BET_THRESHOLD) return rates.big;
  }
  return rates.base;
}

export function riggingBiasFor(rates: HouseRates, bet?: bigint): number {
  const rate = rateForBet(rates, bet);
  if (rate <= 0.5) return 0;
  return Math.min(1, (rate - 0.5) * 2);
}

export function shouldHouseWin(rates: HouseRates, bet?: bigint): boolean {
  return Math.random() < rateForBet(rates, bet);
}
