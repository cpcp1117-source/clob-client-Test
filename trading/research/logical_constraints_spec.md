# Logical Constraints Specification for BTC 5m Arbitrage

## Purpose
This document defines the mathematical constraints and logical dependencies for the BTC 5-minute prediction markets on Polymarket. By defining these constraints, we can use Integer Programming to detect mispricing across related conditions.

## 1. Single Market Constraints (Fundamental)
Every 5-minute market consists of two outcomes: UP (price > open) and DOWN (price < open).

**Constraint 1.1: Unity**
$$P(UP) + P(DOWN) = 1$$
*Note: In practice, on the CLOB, $P(UP) + P(DOWN) \neq 1$ creates the simplest arbitrage opportunity.*

## 2. Temporal Coherence Constraints
Polymarket 5-minute markets are sequential. The resolution price of window $T$ is the open price of window $T+1$.

**Constraint 2.1: Strike Prediction**
As window $T$ approaches $t \rightarrow 300s$, the current price $P_t$ converges to the strike $K_{T+1}$.
- If $P_t > K_T$, then $K_{T+1} > K_T$.
- If market $T+1$ is priced using a "stale" assumption of $K_T$, an arbitrage opportunity exists between the expected fair value at $K_{T+1}$ and the current market price of $T+1$.

## 3. Cross-Asset Correlation Constraints (BTC/ETH)
BTC and ETH 5m markets usually exhibit high positive correlation ($\rho > 0.85$).

**Constraint 3.1: Spread Bound**
Let $P(UP_{btc})$ and $P(UP_{eth})$ be the probabilities. The joint probability space must satisfy:
$$|P(UP_{btc}) - P(UP_{eth})| \le \sigma_{spread} \times \sqrt{\tau}$$
Where $\sigma_{spread}$ is the historical volatility of the BTC/ETH price ratio. A deviation exceeding $2\sigma$ suggests one asset is lagging and creates a mean-reversion arbitrage opportunity.

## 4. Strike Price Monotonicity Constraints
If multiple strikes $K_1, K_2, ... K_n$ are offered for the same timeframe:

**Constraint 4.1: Non-Increasing YES Price**
For any $K_i < K_j$:
$$P(Price > K_j) \le P(Price > K_i)$$
Violation allows a "Bull Spread" arbitrage: Buy $K_i$ YES, Sell $K_j$ YES for a net credit or zero cost with positive payoff.

## 5. Constraint Matrix for Solver
To be used by the Frank-Wolfe optimizer:

| Category | Relation | Constraint Type |
| :--- | :--- | :--- |
| Single Market | $P(UP) + P(DOWN) = 1$ | Equality |
| Temporal | $K_{T+1} \approx P_{t \to T}$ | Expectation Bound |
| Cross-Asset | $|P(BTC) - P(ETH)| \le \delta$ | Inequality |
| Monotonicity | $P(K_{high}) \le P(K_{low})$ | Inequality |

ANTIGRAVITY_STATUS:
- completed: Refined logical constraints (Temporal + Cross-Asset)
- blocked: None
- recommended_next_codex_task: Implement the `CorrelationMonitor` and `TemporalPredictor` in `trading/strategy/arb-engine.ts`.

## 5. Metadata for LLM Screening
When scanning for new markets, the LLM should look for:
- "Same Underlying" (BTC)
- "Same Timeframe" (5 minutes)
- "Different Strikes" (if applicable)
- "Related Tokens" (e.g., BTC vs ETH correlations)

ANTIGRAVITY_STATUS:
- completed: Logical constraints definition
- blocked: None
- recommended_next_codex_task: Implement a JSON validator for these constraints in `trading/infra/constraint-validator.ts`.
