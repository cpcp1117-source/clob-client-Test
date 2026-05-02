# Bregman Pricing Model: KL Divergence for Probability Arbitrage

## Overview
Traditional arbitrage calculations use Euclidean distance (linear difference). However, for prediction markets (probabilities), distance is non-linear. This document specifies the use of KL Divergence to weight arbitrage opportunities, prioritizing mispricing at the boundaries (0.01-0.1 and 0.9-0.99).

## 1. The Math: KL Divergence
Given the Market Probability ($P_{m}$) and the Fair Value Probability ($P_{f}$), the information-theoretic distance (Bregman Divergence for the log-loss scoring rule) is:

$$D_{KL}(P_{f} || P_{m}) = P_{f} \ln\left(\frac{P_{f}}{P_{m}}\right) + (1 - P_{f}) \ln\left(\frac{1 - P_{f}}{1 - P_{m}}\right)$$

### Why this matters:
- If $P_{m} = 0.5 \rightarrow 0.6$, $D_{KL} \approx 0.02$.
- If $P_{m} = 0.05 \rightarrow 0.15$, $D_{KL} \approx 0.06$.
- Even though both are a 10% change, the movement near 0 is 3x more "significant" in terms of information impact.

## 2. Optimization: Frank-Wolfe Algorithm
Instead of brute-forcing the entire probability space, we use the Frank-Wolfe algorithm to project the market state back onto the "No-Arbitrage Polytope".

### Step-by-Step for Execution:
1. **Initialize**: Start with current market prices $\theta_0$.
2. **Gradient**: Calculate the gradient of the KL Divergence at $\theta_t$.
3. **Linear Subproblem**: Find the vertex $v_t$ of the No-Arb Polytope that minimizes the linear approximation (using the Gurobi/IP solver).
4. **Update**: Move a step towards $v_t$: $\theta_{t+1} = (1 - \gamma) \theta_t + \gamma v_t$.
5. **Stop**: Stop when the "Edge" is less than the execution cost.

## 3. Barrier Method for Stability
To prevent "Gradient Explosion" when $P \rightarrow 0$, we implement a Barrier Frank-Wolfe:
- Add a small epsilon $\epsilon = 10^{-4}$ to all probability inputs.
- Shrink the polytope boundaries slightly to avoid the absolute 0/1 limits where log-loss goes to infinity.

## 4. Implementation Requirements
- **Input**: `polymarket_orderbook`, `fair_value_estimate`.
- **Output**: `arbitrage_vector` (which tokens to buy and in what quantity).
- **Constraints**: Defined in `logical_constraints_spec.md`.

ANTIGRAVITY_STATUS:
- completed: Bregman/KL Divergence pricing model spec
- blocked: None
- recommended_next_codex_task: Implement the `KLDivergenceCalculator` in `trading/strategy/math-utils.ts`.
