import { Buffer } from "buffer";

// Типы прямо тут — всё самодостаточно
export interface RouteArgs {
  swapCount: number;
  swaps: Swap[];
}

export interface Swap {
  programId: string;
  swapType: number;
  routePlanStep: RoutePlanStep;
  extra?: Record<string, any>;
}

export interface RoutePlanStep {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  feeAmount: string;
  feeMint: string;
  percent: number;
}

// Декодирует swap (заглушка, допиши логику при необходимости)
function decodeSwap(data: Buffer, offset: number): Swap {
  return {
    programId: '',
    swapType: 0,
    routePlanStep: decodeRoutePlanStep(data, offset),
    extra: {}
  };
}

// Декодирует дополнительные поля swap (можно кастомизировать)
function decodeExtraFields(
  _data: Buffer,
  _swap: Swap,
  _offset: number
): Record<string, any> {
  return {}; // пока пусто, можно расширить
}

// Декодирует шаг маршрута
function decodeRoutePlanStep(data: Buffer, offset: number): RoutePlanStep {
  const inputMint = data.slice(offset, offset + 32).toString("hex");
  const outputMint = data.slice(offset + 32, offset + 64).toString("hex");
  const inAmount = data.readBigUInt64LE(offset + 64).toString();
  const outAmount = data.readBigUInt64LE(offset + 72).toString();
  const feeAmount = data.readBigUInt64LE(offset + 80).toString();
  const feeMint = data.slice(offset + 88, offset + 120).toString("hex");
  const percent = data.readUInt8(offset + 120);

  return {
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    feeAmount,
    feeMint,
    percent
  };
}

// Основная функция для декодинга route args
export function decodeRouteArgs(data: Buffer): RouteArgs {
  const swapCount = data.readUInt8(0);
  const swaps: Swap[] = [];

  let offset = 1;

  for (let i = 0; i < swapCount; i++) {
    const swap = decodeSwap(data, offset);
    swaps.push(swap);
    offset += 128; // длина одного RoutePlanStep (пока условно, адаптируй если надо)
  }

  return {
    swapCount,
    swaps
  };
}