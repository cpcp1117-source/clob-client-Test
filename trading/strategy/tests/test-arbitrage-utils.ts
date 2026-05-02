import assert from "assert/strict";
import { VWAPCalculator, type OrderbookLevel } from "../clob-utils.ts";
import { KLDivergenceCalculator } from "../math-utils.ts";
import { ConstraintSolver } from "../solver-bridge.ts";
import { ArbEngine, CorrelationMonitor, TemporalPredictor } from "../arb-engine.ts";

const kl = new KLDivergenceCalculator();
const centerMove = kl.binary(0.6, 0.5);
const boundaryMove = kl.binary(0.15, 0.05);

assert(centerMove.divergence > 0);
assert(boundaryMove.divergence > centerMove.divergence);
assert.equal(kl.binary(0, 1).clampedFairValueProbability, 0.0001);
assert.equal(kl.binary(0, 1).clampedMarketProbability, 0.9999);

const upAsks: OrderbookLevel[] = [
    { price: 0.47, size: 10 },
    { price: 0.49, size: 10 },
];
const downAsks: OrderbookLevel[] = [
    { price: 0.45, size: 20 },
];
const vwap = new VWAPCalculator();
const check = vwap.checkBinaryBuyArbitrage(upAsks, downAsks, 10);

assert.equal(check.executable, true);
assert.equal(check.reason, "PASS");
assert.ok(Math.abs(check.expectedProfitPerShare - 0.08) < 1e-12);

const consumed = vwap.simulateConsume({ asks: upAsks }, "ask", 12);
assert.deepEqual(consumed.asks, [{ price: 0.49, size: 8 }]);

const solver = new ConstraintSolver();
const result = await solver.project({
    marketProbabilities: {
        "BTC-5M-UP": 0.53,
        "BTC-5M-DOWN": 0.51,
        "BTC-65000": 0.62,
        "BTC-65100": 0.65,
    },
    fairProbabilities: {
        "BTC-5M-UP": 0.50,
        "BTC-5M-DOWN": 0.50,
        "BTC-65000": 0.62,
        "BTC-65100": 0.62,
    },
    constraints: [{
        id: "btc-5m-unity",
        sense: "eq",
        coefficients: { "BTC-5M-UP": 1, "BTC-5M-DOWN": 1 },
        rhs: 1,
    }, solver.buildMonotonicityConstraint("BTC-65000", "BTC-65100")],
});

assert.equal(result.status, "no_adapter");
assert.equal(result.iterations, 0);
assert.equal(result.probabilities["BTC-5M-UP"], 0.53);
assert(result.divergence > 0);

const correlationMonitor = new CorrelationMonitor({
    minSamples: 3,
    fallbackSpreadSigma: 0.02,
    minSpreadThreshold: 0.02,
    sigmaMultiplier: 2,
});
correlationMonitor.observe({ timestampMs: 1, btcUpProbability: 0.51, ethUpProbability: 0.50 });
correlationMonitor.observe({ timestampMs: 2, btcUpProbability: 0.52, ethUpProbability: 0.51 });
correlationMonitor.observe({ timestampMs: 3, btcUpProbability: 0.53, ethUpProbability: 0.52 });
const spreadCheck = correlationMonitor.assess(0.68, 0.51);

assert.equal(spreadCheck.status, "violated");
assert(spreadCheck.threshold >= 0.04);

const temporalPredictor = new TemporalPredictor();
const temporalPrediction = temporalPredictor.predictNextStrike({
    currentSpot: 65125,
    currentStrike: 65000,
    secondsRemaining: 10,
    tickSize: 1,
});

assert.equal(temporalPrediction.predictedNextStrike, 65125);
assert.equal(temporalPrediction.direction, "up");
assert(temporalPrediction.convergenceWeight > 0.95);

const fairValue = temporalPredictor.estimateNextMarketFairValue({
    currentSpot: 65125,
    nextStrike: 65000,
    volatility5m: 0.003,
    secondsRemaining: 30,
}, 0.45);

assert(fairValue.upProbability > 0.5);
assert(fairValue.edgeToMarket !== undefined && fairValue.edgeToMarket > 0.05);

const engine = new ArbEngine({
    correlationMonitor,
    temporalPredictor,
    temporalEdgeThreshold: 0.04,
});
const engineResult = engine.evaluate({
    markets: [{
        id: "btc-current",
        asset: "BTC",
        upProbability: 0.68,
        downProbability: 0.36,
    }, {
        id: "eth-current",
        asset: "ETH",
        upProbability: 0.51,
        downProbability: 0.49,
    }, {
        id: "btc-next",
        asset: "BTC",
        upProbability: 0.45,
        downProbability: 0.55,
        strike: 65000,
    }],
    crossAssetPairs: [{ btcMarketId: "btc-current", ethMarketId: "eth-current" }],
    strikeGroups: [[
        { id: "btc-65000", asset: "BTC", strike: 65000, yesProbability: 0.62 },
        { id: "btc-65100", asset: "BTC", strike: 65100, yesProbability: 0.66 },
    ]],
    temporal: {
        currentSpot: 65125,
        currentStrike: 65000,
        nextMarketId: "btc-next",
        nextMarketStrike: 65000,
        secondsRemaining: 30,
        volatility5m: 0.003,
    },
});

assert.equal(engineResult.status, "watch");
assert.equal(engineResult.riskControls.liveTradingAllowed, false);
assert(engineResult.evaluations.some(evaluation => evaluation.id === "unity:btc-current" && evaluation.status === "violated"));
assert(engineResult.evaluations.some(evaluation => evaluation.id.startsWith("cross_asset:") && evaluation.status === "violated"));
assert(engineResult.evaluations.some(evaluation => evaluation.id.startsWith("monotonicity:") && evaluation.status === "violated"));
assert.equal(engineResult.temporal[0].status, "violated");

console.log("arbitrage utility tests passed");
