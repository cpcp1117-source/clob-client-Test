import {
    ConstraintSolver,
    type ConstraintEvaluation,
    type LinearConstraint,
    type LegacyLinearConstraint,
    type LegacySolverVariable,
} from "./solver-bridge.ts";

export type ArbAsset = "BTC" | "ETH" | string;
export type ArbStatus = "clear" | "watch" | "blocked";

export interface ProbabilityMarketState {
    id: string;
    asset: ArbAsset;
    upProbability: number;
    downProbability?: number;
    strike?: number;
    currentSpot?: number;
    windowStartMs?: number;
    windowEndMs?: number;
}

export interface StrikeProbabilityMarket {
    id: string;
    asset: ArbAsset;
    strike: number;
    yesProbability: number;
}

export interface CorrelationSample {
    timestampMs: number;
    btcUpProbability: number;
    ethUpProbability: number;
    btcSpot?: number;
    ethSpot?: number;
}

export interface CorrelationAssessment {
    status: "in_bounds" | "violated" | "insufficient_history";
    spread: number;
    absoluteSpread: number;
    spreadSigma: number;
    tau: number;
    bound: number;
    threshold: number;
    sampleCount: number;
}

export interface CorrelationMonitorOptions {
    maxSamples?: number;
    minSamples?: number;
    sigmaMultiplier?: number;
    minSpreadThreshold?: number;
    fallbackSpreadSigma?: number;
}

export interface TemporalPredictionInput {
    currentSpot: number;
    currentStrike?: number;
    secondsRemaining: number;
    windowSeconds?: number;
    tickSize?: number;
}

export interface TemporalPrediction {
    predictedNextStrike: number;
    currentStrike?: number;
    direction: "up" | "down" | "flat" | "unknown";
    secondsRemaining: number;
    convergenceWeight: number;
}

export interface TemporalFairValueInput {
    currentSpot: number;
    nextStrike: number;
    volatility5m: number;
    secondsRemaining: number;
    windowSeconds?: number;
}

export interface TemporalFairValue {
    upProbability: number;
    downProbability: number;
    edgeToMarket?: number;
}

export interface ArbEngineOptions {
    solver?: ConstraintSolver;
    correlationMonitor?: CorrelationMonitor;
    temporalPredictor?: TemporalPredictor;
    unityTolerance?: number;
    monotonicityTolerance?: number;
    temporalEdgeThreshold?: number;
}

export interface CrossAssetConstraintInput {
    btcMarketId: string;
    ethMarketId: string;
    tau?: number;
}

export interface TemporalConstraintInput {
    currentSpot: number;
    currentStrike?: number;
    nextMarketId: string;
    nextMarketStrike?: number;
    secondsRemaining: number;
    volatility5m: number;
}

export interface ArbEngineEvaluateInput {
    markets: readonly ProbabilityMarketState[];
    crossAssetPairs?: readonly CrossAssetConstraintInput[];
    strikeGroups?: readonly (readonly StrikeProbabilityMarket[])[];
    temporal?: TemporalConstraintInput;
}

export interface TemporalEvaluation {
    id: string;
    status: "satisfied" | "violated";
    prediction: TemporalPrediction;
    fairValue: TemporalFairValue;
    marketUpProbability: number;
    residual: number;
}

export interface ArbEngineResult {
    status: ArbStatus;
    evaluations: readonly ConstraintEvaluation[];
    correlation: readonly CorrelationAssessment[];
    temporal: readonly TemporalEvaluation[];
    constraints: readonly LinearConstraint[];
    riskControls: {
        liveTradingAllowed: false;
        reason: string;
    };
}

const DEFAULT_UNITY_TOLERANCE = 0.02;
const DEFAULT_MONOTONICITY_TOLERANCE = 0.005;
const DEFAULT_TEMPORAL_EDGE_THRESHOLD = 0.04;

function assertFiniteNumber(name: string, value: number): void {
    if (!Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number`);
    }
}

function assertPositiveFinite(name: string, value: number): void {
    assertFiniteNumber(name, value);
    if (value <= 0) throw new Error(`${name} must be positive`);
}

function assertProbability(name: string, value: number): void {
    assertFiniteNumber(name, value);
    if (value < 0 || value > 1) {
        throw new Error(`${name} must be between 0 and 1`);
    }
}

function clampProbability(value: number): number {
    return Math.min(0.999, Math.max(0.001, value));
}

function stddev(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

function normalCdf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * absX);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
    return 0.5 * (1 + erf);
}

function roundToTick(value: number, tickSize?: number): number {
    if (tickSize === undefined) return value;
    assertPositiveFinite("tickSize", tickSize);
    return Math.round(value / tickSize) * tickSize;
}

export class CorrelationMonitor {
    private readonly maxSamples: number;
    private readonly minSamples: number;
    private readonly sigmaMultiplier: number;
    private readonly minSpreadThreshold: number;
    private readonly fallbackSpreadSigma: number;
    private readonly samples: CorrelationSample[] = [];

    public constructor(options: CorrelationMonitorOptions = {}) {
        this.maxSamples = Math.max(2, Math.floor(options.maxSamples ?? 240));
        this.minSamples = Math.max(2, Math.floor(options.minSamples ?? 20));
        this.sigmaMultiplier = options.sigmaMultiplier ?? 2;
        this.minSpreadThreshold = options.minSpreadThreshold ?? 0.05;
        this.fallbackSpreadSigma = options.fallbackSpreadSigma ?? 0.025;

        assertPositiveFinite("sigmaMultiplier", this.sigmaMultiplier);
        assertPositiveFinite("minSpreadThreshold", this.minSpreadThreshold);
        assertPositiveFinite("fallbackSpreadSigma", this.fallbackSpreadSigma);
    }

    public observe(sample: CorrelationSample): CorrelationAssessment {
        this.validateSample(sample);
        this.samples.push(sample);
        while (this.samples.length > this.maxSamples) this.samples.shift();
        return this.assess(sample.btcUpProbability, sample.ethUpProbability);
    }

    public assess(btcUpProbability: number, ethUpProbability: number, tau = 1): CorrelationAssessment {
        assertProbability("btcUpProbability", btcUpProbability);
        assertProbability("ethUpProbability", ethUpProbability);
        assertPositiveFinite("tau", tau);

        const spread = btcUpProbability - ethUpProbability;
        const absoluteSpread = Math.abs(spread);
        const spreadSigma = this.estimateSpreadSigma();
        const bound = Math.max(this.minSpreadThreshold, spreadSigma * Math.sqrt(tau));
        const threshold = this.sigmaMultiplier * bound;
        const hasHistory = this.samples.length >= this.minSamples;

        return {
            status: !hasHistory ? "insufficient_history" : absoluteSpread > threshold ? "violated" : "in_bounds",
            spread,
            absoluteSpread,
            spreadSigma,
            tau,
            bound,
            threshold,
            sampleCount: this.samples.length,
        };
    }

    public buildSpreadConstraints(btcUpId: string, ethUpId: string, assessment: CorrelationAssessment): LinearConstraint[] {
        const rhs = assessment.threshold;
        return [{
            id: `cross_asset:${btcUpId}-${ethUpId}:upper`,
            coefficients: { [btcUpId]: 1, [ethUpId]: -1 },
            sense: "lte",
            rhs,
        }, {
            id: `cross_asset:${btcUpId}-${ethUpId}:lower`,
            coefficients: { [btcUpId]: -1, [ethUpId]: 1 },
            sense: "lte",
            rhs,
        }];
    }

    private estimateSpreadSigma(): number {
        if (this.samples.length < this.minSamples) return this.fallbackSpreadSigma;

        const ratioReturns = this.samples
            .slice(1)
            .map((sample, index) => {
                const previous = this.samples[index];
                if (!sample.btcSpot || !sample.ethSpot || !previous.btcSpot || !previous.ethSpot) return null;
                const ratio = sample.btcSpot / sample.ethSpot;
                const previousRatio = previous.btcSpot / previous.ethSpot;
                return Math.log(ratio / previousRatio);
            })
            .filter((value): value is number => value !== null && Number.isFinite(value));

        const source = ratioReturns.length >= this.minSamples - 1
            ? ratioReturns
            : this.samples.map(sample => sample.btcUpProbability - sample.ethUpProbability);
        const sigma = stddev(source);
        return sigma > 0 ? sigma : this.fallbackSpreadSigma;
    }

    private validateSample(sample: CorrelationSample): void {
        assertFiniteNumber("timestampMs", sample.timestampMs);
        assertProbability("btcUpProbability", sample.btcUpProbability);
        assertProbability("ethUpProbability", sample.ethUpProbability);
        if (sample.btcSpot !== undefined) assertPositiveFinite("btcSpot", sample.btcSpot);
        if (sample.ethSpot !== undefined) assertPositiveFinite("ethSpot", sample.ethSpot);
    }
}

export class TemporalPredictor {
    public predictNextStrike(input: TemporalPredictionInput): TemporalPrediction {
        assertPositiveFinite("currentSpot", input.currentSpot);
        assertFiniteNumber("secondsRemaining", input.secondsRemaining);
        if (input.currentStrike !== undefined) assertPositiveFinite("currentStrike", input.currentStrike);

        const windowSeconds = input.windowSeconds ?? 300;
        assertPositiveFinite("windowSeconds", windowSeconds);

        const predictedNextStrike = roundToTick(input.currentSpot, input.tickSize);
        const convergenceWeight = Math.max(0, Math.min(1, 1 - (input.secondsRemaining / windowSeconds)));
        const direction = input.currentStrike === undefined
            ? "unknown"
            : predictedNextStrike > input.currentStrike
                ? "up"
                : predictedNextStrike < input.currentStrike
                    ? "down"
                    : "flat";

        return {
            predictedNextStrike,
            currentStrike: input.currentStrike,
            direction,
            secondsRemaining: input.secondsRemaining,
            convergenceWeight,
        };
    }

    public estimateNextMarketFairValue(input: TemporalFairValueInput, marketUpProbability?: number): TemporalFairValue {
        assertPositiveFinite("currentSpot", input.currentSpot);
        assertPositiveFinite("nextStrike", input.nextStrike);
        assertPositiveFinite("volatility5m", input.volatility5m);
        assertFiniteNumber("secondsRemaining", input.secondsRemaining);

        const windowSeconds = input.windowSeconds ?? 300;
        assertPositiveFinite("windowSeconds", windowSeconds);
        const timeFraction = Math.max(0.02, Math.min(1, input.secondsRemaining / windowSeconds));
        const z = Math.log(input.currentSpot / input.nextStrike) / (input.volatility5m * Math.sqrt(timeFraction));
        const upProbability = clampProbability(normalCdf(z));
        const result: TemporalFairValue = {
            upProbability,
            downProbability: 1 - upProbability,
        };
        if (marketUpProbability !== undefined) {
            assertProbability("marketUpProbability", marketUpProbability);
            return { ...result, edgeToMarket: upProbability - marketUpProbability };
        }
        return result;
    }
}

export class ArbEngine {
    private readonly solver: ConstraintSolver;
    private readonly correlationMonitor: CorrelationMonitor;
    private readonly temporalPredictor: TemporalPredictor;
    private readonly unityTolerance: number;
    private readonly monotonicityTolerance: number;
    private readonly temporalEdgeThreshold: number;

    public constructor(options: ArbEngineOptions = {}) {
        this.solver = options.solver ?? new ConstraintSolver();
        this.correlationMonitor = options.correlationMonitor ?? new CorrelationMonitor();
        this.temporalPredictor = options.temporalPredictor ?? new TemporalPredictor();
        this.unityTolerance = options.unityTolerance ?? DEFAULT_UNITY_TOLERANCE;
        this.monotonicityTolerance = options.monotonicityTolerance ?? DEFAULT_MONOTONICITY_TOLERANCE;
        this.temporalEdgeThreshold = options.temporalEdgeThreshold ?? DEFAULT_TEMPORAL_EDGE_THRESHOLD;
    }

    public evaluate(input: ArbEngineEvaluateInput): ArbEngineResult {
        if (input.markets.length === 0) throw new Error("markets must not be empty");

        const variables: LegacySolverVariable[] = [];
        const constraints: LegacyLinearConstraint[] = [];
        const marketById = new Map(input.markets.map(market => [market.id, market]));

        for (const market of input.markets) {
            this.validateMarket(market);
            const upId = this.upVariableId(market.id);
            variables.push({ id: upId, probability: market.upProbability, marketId: market.id, outcome: "UP" });

            if (market.downProbability !== undefined) {
                const downId = this.downVariableId(market.id);
                variables.push({ id: downId, probability: market.downProbability, marketId: market.id, outcome: "DOWN" });
                constraints.push(...this.solver.buildUnityConstraints(upId, downId).map(constraint => ({
                    ...constraint,
                    id: `unity:${market.id}`,
                    tolerance: this.unityTolerance,
                })));
            }
        }

        const correlation = this.buildCrossAssetConstraints(input, constraints, marketById);
        this.buildMonotonicityConstraints(input, constraints, variables);
        const temporal = this.evaluateTemporal(input, marketById);

        const solverResult = this.solver.solve({ variables, linearConstraints: constraints });
        const hasViolation = solverResult.evaluations.some(evaluation => evaluation.status === "violated")
            || correlation.some(evaluation => evaluation.status === "violated")
            || temporal.some(evaluation => evaluation.status === "violated");

        return {
            status: hasViolation ? "watch" : "clear",
            evaluations: solverResult.evaluations,
            correlation,
            temporal,
            constraints,
            riskControls: {
                liveTradingAllowed: false,
                reason: "ArbEngine is a deterministic validation layer; live execution requires separate conservative gates.",
            },
        };
    }

    private buildCrossAssetConstraints(
        input: ArbEngineEvaluateInput,
        constraints: LegacyLinearConstraint[],
        marketById: ReadonlyMap<string, ProbabilityMarketState>
    ): CorrelationAssessment[] {
        const assessments: CorrelationAssessment[] = [];
        for (const pair of input.crossAssetPairs ?? []) {
            const btc = marketById.get(pair.btcMarketId);
            const eth = marketById.get(pair.ethMarketId);
            if (!btc) throw new Error(`unknown BTC market ${pair.btcMarketId}`);
            if (!eth) throw new Error(`unknown ETH market ${pair.ethMarketId}`);

            const assessment = this.correlationMonitor.assess(btc.upProbability, eth.upProbability, pair.tau ?? 1);
            constraints.push(...this.correlationMonitor.buildSpreadConstraints(
                this.upVariableId(btc.id),
                this.upVariableId(eth.id),
                assessment
            ));
            assessments.push(assessment);
        }
        return assessments;
    }

    private buildMonotonicityConstraints(
        input: ArbEngineEvaluateInput,
        constraints: LegacyLinearConstraint[],
        variables: LegacySolverVariable[]
    ): void {
        for (const group of input.strikeGroups ?? []) {
            const ordered = [...group].sort((a, b) => a.strike - b.strike);
            for (const market of ordered) {
                assertPositiveFinite(`${market.id}.strike`, market.strike);
                assertProbability(`${market.id}.yesProbability`, market.yesProbability);
                variables.push({
                    id: this.strikeVariableId(market.id),
                    probability: market.yesProbability,
                    marketId: market.id,
                    outcome: "YES",
                });
            }

            for (let index = 0; index < ordered.length - 1; index++) {
                const lower = ordered[index];
                const higher = ordered[index + 1];
                constraints.push({
                    ...this.solver.buildMonotonicityConstraint(
                        this.strikeVariableId(lower.id),
                        this.strikeVariableId(higher.id)
                    ),
                    id: `monotonicity:${higher.id}<=${lower.id}`,
                    tolerance: this.monotonicityTolerance,
                });
            }
        }
    }

    private evaluateTemporal(
        input: ArbEngineEvaluateInput,
        marketById: ReadonlyMap<string, ProbabilityMarketState>
    ): TemporalEvaluation[] {
        if (!input.temporal) return [];

        const nextMarket = marketById.get(input.temporal.nextMarketId);
        if (!nextMarket) throw new Error(`unknown next market ${input.temporal.nextMarketId}`);
        const prediction = this.temporalPredictor.predictNextStrike({
            currentSpot: input.temporal.currentSpot,
            currentStrike: input.temporal.currentStrike,
            secondsRemaining: input.temporal.secondsRemaining,
        });
        const fairValue = this.temporalPredictor.estimateNextMarketFairValue({
            currentSpot: input.temporal.currentSpot,
            nextStrike: input.temporal.nextMarketStrike ?? nextMarket.strike ?? prediction.predictedNextStrike,
            volatility5m: input.temporal.volatility5m,
            secondsRemaining: input.temporal.secondsRemaining,
        }, nextMarket.upProbability);
        const residual = Math.abs(fairValue.edgeToMarket ?? 0);

        return [{
            id: `temporal:${nextMarket.id}`,
            status: residual > this.temporalEdgeThreshold ? "violated" : "satisfied",
            prediction,
            fairValue,
            marketUpProbability: nextMarket.upProbability,
            residual,
        }];
    }

    private validateMarket(market: ProbabilityMarketState): void {
        if (market.id.trim() === "") throw new Error("market id must not be empty");
        if (String(market.asset).trim() === "") throw new Error(`${market.id}.asset must not be empty`);
        assertProbability(`${market.id}.upProbability`, market.upProbability);
        if (market.downProbability !== undefined) assertProbability(`${market.id}.downProbability`, market.downProbability);
        if (market.strike !== undefined) assertPositiveFinite(`${market.id}.strike`, market.strike);
        if (market.currentSpot !== undefined) assertPositiveFinite(`${market.id}.currentSpot`, market.currentSpot);
    }

    private upVariableId(marketId: string): string {
        return `${marketId}:UP`;
    }

    private downVariableId(marketId: string): string {
        return `${marketId}:DOWN`;
    }

    private strikeVariableId(marketId: string): string {
        return `${marketId}:YES`;
    }
}
