import WebSocket from "ws";

const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

ws.on("open", () => {
    console.log("Connected to WS");
    ws.send(JSON.stringify({
        assets_ids: ["21742633143463906290569050155826241533067272736897614950488156847949938836455"], // Sample token ID
        type: "market"
    }));
});

let msgCount = 0;
ws.on("message", (data) => {
    console.log("Message:", data.toString());
    msgCount++;
    if (msgCount > 3) {
        process.exit(0);
    }
});

ws.on("error", (error) => {
    console.error("WS Error:", error);
    process.exit(1);
});

// timeout
setTimeout(() => {
    console.log("Timeout");
    process.exit(1);
}, 60000);
