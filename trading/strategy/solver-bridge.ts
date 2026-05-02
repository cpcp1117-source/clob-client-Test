import { KLDivergenceCalculator } from "./math-utils.ts";

export type ConstraintSense = "eq" | "lte" | "gte";

export interface SolverVariable {
    id: string;
    lowerBound?: number;
    upperBound?: number;
}

export interface LinearConstraint {
    id: string;
    coefficients: Readonly<Record<string, number>>;
    sense: ConstraintSense;
    rhs: number;
}

export interface SolverProblem {
    variables: readonly SolverVariable[];
    constraints: readonly LinearConstraint[];
    objective: Readonly<Record<string, number>>;
}

export interface SolverAdapter {
    solveLinear(problem: SolverProblem): Promise<Record<string, number>>;
}

export interface ConstraintSolverOptions {
    adapter?: SolverAdapter;
    epsilon?: number;
    maxIterations?: number;
    tolerance?: number;
    stepSize?: number;
}

export interface ProjectionRequest {
    marketProbabilities: Readonly<Record<string, number>>;
    fairProbabilities: Readonly<Record<string, number>>;
    constraints: readonly LinearConstraint[];
}

export interface ProjectionResult {
    status: "projected" | "no_adapter" | "converged";
    probabilities: Readonly<Record<string, number>>;
    iterations: number;
    divergence: number;
    maxLinearEdge: number;
}

export interface ConstraintEvaluation {
    id: string;
    status: "satisfied" | "violated";
    residual: number;
}

export interface LegacySolverVariable {
    id: string;
    probability: number;
    marketId?: string;
    outcome?: string;
}

export interface LegacyLinearConstraint extends LinearConstraint {
    tolerance?: number;
}

export interface MonotonicityConstraint {
    id: string;
    lowerStrikeVariableId: string;
    higherStrikeVariableId: string;
    tolerance?: number;
}

export interface LegacySolveRequest {
    variables: readonly LegacySolverVariable[];
    linearConstraints?: readonly LegacyLinearConstraint[];
    monotonicityConstraints?: readonly MonotonicityConstraint[];
}

export interface LegacySolveResult {
    status: "not_implemented";
    arbitrageVector: Readonly<Record<string, number>>;
    evaluations: readonly ConstraintEvaluation[];
}

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_STEP_SIZE = 0.25;
const DEFAULT_PROBABILITY_EPSILON = 1e-4;

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

function uniqueIds(request: ProjectionRequest): string[] {
    return [...new Set([
        ...Object.keys(request.marketProbabilities),
        ...Object.keys(request.fairProbabilities),
    ])].sort();
}

function validateRequest(request: ProjectionRequest): string[] {
    const ids = uniqueIds(request);
    if (ids.length === 0) throw new Error("projection request must include probabilities");

    for (const id of ids) {
        const market = request.marketProbabilities[id];
        const fair = request.fairProbabilities[id];
        assertProbability(`marketProbabilities.${id}`, market);
        assertProbability(`fairProbabilities.${id}`, fair);
    }

    for (const constraint of request.constraints) {
        assertFiniteNumber(`${constraint.id}.rhs`, constraint.rhs);
        for (const [id, coefficient] of Object.entries(constraint.coefficients)) {
            if (!ids.includes(id)) throw new Error(`constraint ${constraint.id} references unknown variable ${id}`);
            assertFiniteNumber(`${constraint.id}.${id}`, coefficient);
        }
    }

    return ids;
}

export class ConstraintSolver {
    private readonly adapter?: SolverAdapter;
    private readonly kl: KLDivergenceCalculator;
    private readonly epsilon: number;
    private readonly maxIterations: number;
    private readonly tolerance: number;
    private readonly stepSize: number;

    public constructor(options: ConstraintSolverOptions = {}) {
        this.epsilon = options.epsilon ?? DEFAULT_PROBABILITY_EPSILON;
        this.adapter = options.adapter;
        this.kl = new KLDivergenceCalculator({ epsilon: this.epsilon });
        this.maxIterations = Math.max(1, Math.floor(options.maxIterations ?? DEFAULT_MAX_ITERATIONS));
        this.tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
        this.stepSize = options.stepSize ?? DEFAULT_STEP_SIZE;

        if (!Number.isFinite(this.tolerance) || this.tolerance < 0) {
            throw new Error("tolerance must be non-negative");
        }
        if (!Number.isFinite(this.stepSize) || this.stepSize <= 0 || this.stepSize > 1) {
            throw new Error("stepSize must be in (0, 1]");
        }
    }

    public buildUnityConstraints(upId: string, downId: string): LinearConstraint[] {
        return [{
            id: `unity:${upId}:${downId}`,
            coefficients: { [upId]: 1, [downId]: 1 },
            sense: "eq",
            rhs: 1,
        }];
    }

    public buildMonotonicityConstraint(lowerStrikeId: string, higherStrikeId: string): LinearConstraint {
        return {
            id: `monotonicity:${higherStrikeId}<=${lowerStrikeId}`,
            coefficients: { [higherStrikeId]: 1, [lowerStrikeId]: -1 },
            sense: "lte",
            rhs: 0,
        };
    }

    public solve(request: LegacySolveRequest): LegacySolveResult {
        const probabilities = new Map<string, number>();
        for (const variable of request.variables) {
            assertProbability(`variables.${variable.id}.probability`, variable.probability);
            probabilities.set(variable.id, variable.probability);
        }

        const evaluations: ConstraintEvaluation[] = [];
        for (const constraint of request.linearConstraints ?? []) {
            const lhs = Object.entries(constraint.coefficients).reduce((sum, [id, coefficient]) => {
                const probability = probabilities.get(id);
                if (probability === undefined) throw new Error(`constraint ${constraint.id} references unknown variable ${id}`);
                return sum + (coefficient * probability);
            }, 0);
            evaluations.push(this.evaluateLinearConstraint(constraint, lhs, constraint.tolerance ?? this.tolerance));
        }

        for (const constraint of request.monotonicityConstraints ?? []) {
            const lower = probabilities.get(constraint.lowerStrikeVariableId);
            const higher = probabilities.get(constraint.higherStrikeVariableId);
            if (lower === undefined) {
                throw new Error(`constraint ${constraint.id} references unknown variable ${constraint.lowerStrikeVariableId}`);
            }
            if (higher === undefined) {
                throw new Error(`constraint ${constraint.id} references unknown variable ${constraint.higherStrikeVariableId}`);
            }

            const residual = higher - lower;
            const tolerance = constraint.tolerance ?? this.tolerance;
            evaluations.push({
                id: constraint.id,
                status: residual <= tolerance ? "satisfied" : "violated",
                residual,
            });
        }

        return {
            status: "not_implemented",
            arbitrageVector: {},
            evaluations,
        };
    }

    public async project(request: ProjectionRequest): Promise<ProjectionResult> {
        const ids = validateRequest(request);
        const current = Object.fromEntries(ids.map(id => [
            id,
            this.kl.clampProbability(request.marketProbabilities[id]),
        ]));

        if (!this.adapter) {
            return this.buildResult("no_adapter", request, current, 0);
        }

        let iterations = 0;
        for (; iterations < this.maxIterations; iterations++) {
            const objective = Object.fromEntries(ids.map(id => [
                id,
                this.kl.calculateGradientWrtMarketProbability(request.fairProbabilities[id], current[id]),
            ]));
            const vertex = await this.adapter.solveLinear({
                variables: ids.map(id => ({
                    id,
                    lowerBound: this.epsilon,
                    upperBound: 1 - this.epsilon,
                })),
                constraints: request.constraints,
                objective,
            });

            let maxMove = 0;
            for (const id of ids) {
                const next = this.kl.clampProbability(vertex[id]);
                const updated = ((1 - this.stepSize) * current[id]) + (this.stepSize * next);
                maxMove = Math.max(maxMove, Math.abs(updated - current[id]));
                current[id] = this.kl.clampProbability(updated);
            }

            if (maxMove <= this.tolerance) {
                return this.buildResult("converged", request, current, iterations + 1);
            }
        }

        return this.buildResult("projected", request, current, iterations);
    }

    private evaluateLinearConstraint(
        constraint: LinearConstraint,
        lhs: number,
        tolerance: number
    ): ConstraintEvaluation {
        const residual = lhs - constraint.rhs;
        let satisfied = false;
        if (constraint.sense === "eq") satisfied = Math.abs(residual) <= tolerance;
        if (constraint.sense === "lte") satisfied = residual <= tolerance;
        if (constraint.sense === "gte") satisfied = residual >= -tolerance;

        return {
            id: constraint.id,
            status: satisfied ? "satisfied" : "violated",
            residual,
        };
    }

    private buildResult(
        status: ProjectionResult["status"],
        request: ProjectionRequest,
        probabilities: Record<string, number>,
        iterations: number
    ): ProjectionResult {
        const ids = Object.keys(probabilities).sort();
        const components = ids.map(id => this.kl.calculate({
            fairValueProbability: request.fairProbabilities[id],
            marketProbability: probabilities[id],
        }));
        const divergence = components.reduce((sum, component) => sum + component.divergence, 0);
        const maxLinearEdge = Math.max(...components.map(component => Math.abs(component.edge)));

        return {
            status,
            probabilities,
            iterations,
            divergence,
            maxLinearEdge,
        };
    }
}
