export const DEFAULT_PROBABILITY_EPSILON = 1e-4;

export interface KLDivergenceOptions {
    epsilon?: number;
}

export interface ProbabilityPair {
    fairValueProbability: number;
    marketProbability: number;
}

export interface KLDivergenceResult extends ProbabilityPair {
    fairProbability: number;
    marketProbability: number;
    clampedFairValueProbability: number;
    clampedMarketProbability: number;
    divergence: number;
    gradientWrtMarketProbability: number;
    gradientWrtMarket: number;
    edge: number;
    linearEdge: number;
}

export interface ProbabilityVectorDivergenceResult {
    divergence: number;
    components: readonly KLDivergenceResult[];
}

function assertFiniteNumber(name: string, value: number): void {
    if (!Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number`);
    }
}

function assertProbability(name: string, value: number): void {
    assertFiniteNumber(name, value);
    if (value < 0 || value > 1) {
        throw new Error(`${name} must be between 0 and 1`);
    }
}

export class KLDivergenceCalculator {
    public readonly epsilon: number;

    constructor(options: KLDivergenceOptions = {}) {
        const epsilon = options.epsilon ?? DEFAULT_PROBABILITY_EPSILON;
        assertFiniteNumber("epsilon", epsilon);
        if (epsilon <= 0 || epsilon >= 0.5) {
            throw new Error("epsilon must be greater than 0 and less than 0.5");
        }
        this.epsilon = epsilon;
    }

    clampProbability(probability: number): number {
        assertProbability("probability", probability);
        return Math.min(1 - this.epsilon, Math.max(this.epsilon, probability));
    }

    calculateDivergence(fairValueProbability: number, marketProbability: number): number {
        const fair = this.clampProbability(fairValueProbability);
        const market = this.clampProbability(marketProbability);

        return (
            fair * Math.log(fair / market)
            + (1 - fair) * Math.log((1 - fair) / (1 - market))
        );
    }

    calculateGradientWrtMarketProbability(fairValueProbability: number, marketProbability: number): number {
        const fair = this.clampProbability(fairValueProbability);
        const market = this.clampProbability(marketProbability);

        return (market - fair) / (market * (1 - market));
    }

    gradientWrtMarket(fairValueProbability: number, marketProbability: number): number {
        return this.calculateGradientWrtMarketProbability(fairValueProbability, marketProbability);
    }

    calculate(input: ProbabilityPair): KLDivergenceResult {
        assertProbability("fairValueProbability", input.fairValueProbability);
        assertProbability("marketProbability", input.marketProbability);

        const clampedFairValueProbability = this.clampProbability(input.fairValueProbability);
        const clampedMarketProbability = this.clampProbability(input.marketProbability);
        const divergence = this.calculateDivergence(input.fairValueProbability, input.marketProbability);
        const gradientWrtMarketProbability = this.calculateGradientWrtMarketProbability(
            input.fairValueProbability,
            input.marketProbability
        );

        return {
            ...input,
            fairProbability: clampedFairValueProbability,
            marketProbability: clampedMarketProbability,
            clampedFairValueProbability,
            clampedMarketProbability,
            divergence,
            gradientWrtMarketProbability,
            gradientWrtMarket: gradientWrtMarketProbability,
            edge: clampedFairValueProbability - clampedMarketProbability,
            linearEdge: clampedFairValueProbability - clampedMarketProbability,
        };
    }

    binary(fairValueProbability: number, marketProbability: number): KLDivergenceResult {
        return this.calculate({ fairValueProbability, marketProbability });
    }

    vector(
        fairValueProbabilities: readonly number[],
        marketProbabilities: readonly number[]
    ): ProbabilityVectorDivergenceResult {
        if (fairValueProbabilities.length !== marketProbabilities.length) {
            throw new Error("fairValueProbabilities and marketProbabilities must have the same length");
        }

        const components = fairValueProbabilities.map((fairValueProbability, index) =>
            this.binary(fairValueProbability, marketProbabilities[index])
        );
        const divergence = components.reduce((sum, component) => sum + component.divergence, 0);

        return { divergence, components };
    }

    rankByDivergence(inputs: readonly ProbabilityPair[]): KLDivergenceResult[] {
        return inputs
            .map(input => this.calculate(input))
            .sort((a, b) => b.divergence - a.divergence);
    }
}
