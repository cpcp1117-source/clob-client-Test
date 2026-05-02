# BTC 5m Dataset Schema

Status: Codex draft, pending Antigravity review.

Purpose: define a stable dataset shape for testing BTC 5 minute Polymarket strategy ideas without depending on live WebSocket timing.

## Grain

One row represents one candidate decision timestamp inside one BTC 5 minute Polymarket market window.

Do not use future values at decision time. Fields such as `binance_close`, `resolved_side`, `exit_value`, and `pnl` are label/result fields and must only be used after signal generation.

## Required Columns

| Column | Type | Source | Timing | Notes |
| --- | --- | --- | --- | --- |
| `window_id` | string | derived | pre-trade | Stable id for the 5 minute market window. |
| `market_slug` | string | Polymarket | pre-trade | Polymarket market identifier. |
| `timestamp` | ISO string | collector | pre-trade | Decision timestamp. |
| `window_start` | ISO string | Polymarket/Binance | pre-trade | 5 minute candle open time. |
| `window_end` | ISO string | Polymarket/Binance | pre-trade | 5 minute candle close time. |
| `seconds_to_close` | number | derived | pre-trade | `window_end - timestamp`. |
| `up_token_id` | string | Polymarket | pre-trade | UP outcome token id. |
| `down_token_id` | string | Polymarket | pre-trade | DOWN outcome token id. |
| `polymarket_up_bid` | number | Polymarket order book | pre-trade | Best bid at decision time. |
| `polymarket_up_ask` | number | Polymarket order book | pre-trade | Best ask at decision time. |
| `polymarket_down_bid` | number | Polymarket order book | pre-trade | Best bid at decision time. |
| `polymarket_down_ask` | number | Polymarket order book | pre-trade | Best ask at decision time. |
| `up_ask_size` | number | Polymarket order book | pre-trade | Size available at best ask. |
| `down_ask_size` | number | Polymarket order book | pre-trade | Size available at best ask. |
| `orderbook_timestamp` | ISO string | collector | pre-trade | Time the order book snapshot was observed. |
| `binance_symbol` | string | Binance | pre-trade | Expected `BTCUSDT`. |
| `binance_open` | number | Binance kline | pre-trade | Current 5 minute candle open. |
| `binance_current` | number | Binance ticker/kline | pre-trade | Price at decision timestamp. |
| `binance_high_so_far` | number | Binance kline/ticker | pre-trade | High observed up to decision time only. |
| `binance_low_so_far` | number | Binance kline/ticker | pre-trade | Low observed up to decision time only. |
| `binance_close` | number | Binance kline | post-trade label | Final 5 minute close. Never use as feature. |
| `distance_from_open` | number | derived | pre-trade | `(binance_current - binance_open) / binance_open`. |
| `realized_volatility_lookback` | number | derived | pre-trade | From completed candles only. |
| `momentum_feature` | number | derived | pre-trade | Short momentum from data available at timestamp. |
| `model_name` | string | strategy | pre-trade | Example: `normal_v1`, `empirical_bins_v1`. |
| `chosen_side` | string | strategy | pre-trade | `UP`, `DOWN`, or `SKIP`. |
| `model_probability` | number | strategy | pre-trade | Probability chosen side resolves true. |
| `market_implied_probability` | number | derived | pre-trade | Usually chosen side ask price before costs. |
| `edge_before_costs` | number | derived | pre-trade | `model_probability - market_implied_probability`. |
| `estimated_spread_cost` | number | derived | pre-trade | Configurable execution assumption. |
| `estimated_fee_cost` | number | derived | pre-trade | Include if any fee applies. |
| `edge_after_costs` | number | derived | pre-trade | Expected edge after costs. |
| `intended_entry_price` | number | strategy | pre-trade | Limit or simulated fill price. |
| `filled` | boolean | simulator/execution | post-trade | Whether order filled under assumptions. |
| `entry_price` | number | simulator/execution | post-trade | Actual or simulated fill. |
| `entry_size` | number | simulator/execution | post-trade | USDC or contracts, specify in metadata. |
| `exit_value` | number | settlement/simulator | post-trade | Settlement value or simulated liquidation. |
| `resolved_side` | string | Polymarket | post-trade label | `UP` or `DOWN`. |
| `pnl` | number | simulator/execution | post-trade | Net PnL after costs. |

## Metadata

Each dataset file should include a sidecar JSON metadata file:

```json
{
  "schema_version": "btc_5m_v1",
  "created_at": "ISO_TIMESTAMP",
  "polymarket_source": "TBD",
  "binance_source": "BTCUSDT klines/ticker",
  "timezone": "UTC",
  "notes": []
}
```

## Known Blockers For Antigravity

- Confirm the exact Polymarket resolution price source and timestamp.
- Confirm whether historical order book snapshots are available or must be collected going forward.
- Confirm whether API rate limits allow near-close snapshots.
- Confirm whether last trade price is reliable enough or whether bid/ask must be mandatory.

ANTIGRAVITY_STATUS:
- completed: Codex drafted initial dataset schema.
- blocked: Needs Antigravity validation against real Polymarket data availability.
- recommended_next_codex_task: Implement a CSV validator once Antigravity confirms the final schema.
