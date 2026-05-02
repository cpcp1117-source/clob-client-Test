# Execution Guard: VWAP-Aware Arbitrage Execution

## Purpose
Arbitrage on Polymarket CLOB is non-atomic. This document specifies the execution logic required to prevent "leg-risk" and ensure that the "Mathematical Edge" is not lost to slippage.

## 1. VWAP vs. Mid-Price
Most bots fail because they look at the Best Bid/Ask. We must use **Volume Weighted Average Price (VWAP)** for the target size $S$.

$$VWAP(S) = \frac{\sum_{i=1}^{n} P_i \times Q_i}{S}$$
Where $Q_i$ are the quantities available at price $P_i$ until $\sum Q_i = S$.

## 2. The 5c Safety Buffer
Due to the sequential nature of CLOB orders:
1. Buy Order 1 (UP)
2. Buy Order 2 (DOWN)
The price of Order 2 may change after Order 1 is filled.

**Rule**: We only execute if:
$$1.0 - (VWAP_{UP}(S) + VWAP_{DOWN}(S)) \ge \text{Min_Profit} + \text{Slippage_Buffer}$$
- **Min_Profit**: Default $0.03$ (3 cents per dollar).
- **Slippage_Buffer**: Default $0.02$ (2 cents per dollar).

## 3. Atomic Simulation
Before sending actual orders to the API, the system must perform a **Local Orderbook Simulation**:
- Snapshot the book.
- Subtract the target size $S$ from the local book.
- Recalculate if the *remaining* arbitrage opportunity still exists for a follow-up order.

## 4. Execution Pipeline (Sequential)
1. **Fetch**: WebSocket snapshot of Orderbook A and B.
2. **Calculate**: Compute VWAP for size $S$.
3. **Validate**: If profit > 5c, proceed.
4. **Fire**: Send Limit Orders with GTC (Good Till Cancelled) but with a very short TTL (Time to Live) or FOK (Fill or Kill) if the API supports it.
5. **Monitor**: If only one leg fills, immediately attempt to hedge the remaining exposure on Binance Futures or market-sell the filled leg if loss is within tolerance.

## 5. Metrics
- **Expected Profit**: Based on VWAP at T=0.
- **Realized Profit**: Based on actual execution prices.
- **Leg Failure Rate**: Percentage of trades where only one side filled.

ANTIGRAVITY_STATUS:
- completed: Execution guard and VWAP spec
- blocked: None
- recommended_next_codex_task: Implement the `VWAPCalculator` and `OrderbookSimulator` in `trading/strategy/execution-engine.ts`.
