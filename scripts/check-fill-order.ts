// Deterministic check for the fill/block ordering in src/trader.ts.
// Reproduces production timing: the trade-log poll resolves while the model is still thinking, so
// harvest() runs BEFORE the block event is emitted. The fill must still land on that event, and the
// fill callback must fire after the block callback (a client drops fills for blocks it has not seen).
// Run: bun run scripts/check-fill-order.ts   (no network, no wallet, no RPC)
import { Trader } from "../src/trader";
import type { Book, Fill, Quote } from "../src/market";
import type { Decision, TradeState } from "../src/model";

const log: string[] = [];
const seen: Record<number, { hasFill: boolean; size: number }> = {};

const book = (block: number, mid: number): Book => ({
  block, bid: mid - 0.000001, ask: mid + 0.000001, mid, spreadBps: 0.89, imbalance: 0,
  levels: { bids: [], asks: [] }, depthBps: {},
});

const market = {
  wallet: null, // dry run: fills are simulated from prints
  margin: { mon: 0, usdc: 0 },
  address: null,
  params: { sizePrecision: { toString: () => "10000000000" }, pricePrecision: { toString: () => "100000000" }, tickSize: { toString: () => "100" } },
  readBook: async () => book(currentBlock, 0.0225),
  send: async (block: number, side: "buy" | "sell", size: number, b: Book): Promise<Quote> => ({
    side, price: side === "buy" ? b.bid : b.ask, size, txHash: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false,
  }),
  pollPending: async () => [],
  refresh: async () => {},
};

const model = {
  name: "fake",
  decide: async (_s: TradeState): Promise<Decision> => {
    await Bun.sleep(30); // inference outlasts the poll, exactly like the mock's 80 ms
    return { action: "buy", probabilities: { buy: 0.8, sell: 0.2, hold: 0 }, upIn10: 0.8, latencyMs: 30, inputTokens: 0 };
  },
};

let currentBlock = 9;
const printsFor: Record<number, { block: number; price: number; size: number; side: "buy" | "sell" }[]> = {
  10: [{ block: 10, price: 0.022498, size: 200, side: "sell" }], // a taker sell through our resting bid
};
const feed = {
  poll: async () => {}, // resolves immediately: harvest runs while decide() is still in flight
  drainPrints: () => printsFor[currentBlock] ?? [],
  drainFills: () => [] as never[],
  summary: () => ({ count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null }),
  recent: () => [],
};

const trader = new Trader(market as never, model as never,
  (e) => { const f = e.fill as Fill | null; seen[e.block] = { hasFill: !!f, size: f?.size ?? 0 }; log.push(`block:${e.block}:fill=${f ? f.size : "null"}`); },
  (block, fill) => { log.push(`fill:${block}:${fill.size}`); },
);
(trader as never as { trades: unknown }).trades = feed;

currentBlock = 9; await trader.onBlock(9);   // places the simulated bid that will be hit at block 10
currentBlock = 10; await trader.onBlock(10); // poll resolves first, emit second

const ok = (label: string, cond: boolean) => console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
console.log("call order:", log.join(" | "));
ok("the fill is attached to its own block event", seen[10]?.hasFill === true && seen[10]?.size === 200);
ok("the fill event is broadcast after the block event", log.indexOf("block:10:fill=200") < log.indexOf("fill:10:200"));
ok("no fill leaks onto an unrelated block", seen[9]?.hasFill === false);
process.exit(log.indexOf("fill:10:200") > log.indexOf("block:10:fill=200") && seen[10]?.hasFill ? 0 : 1);

