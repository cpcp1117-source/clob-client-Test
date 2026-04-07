/**
 * 🎁 Safe 代理錢包領獎工具 (方案 B) - 正式認證版
 * 
 * 使用 Polymarket 官方 Relayer SDK 透過 Safe 錢包領取已結算的獎勵。
 * 新增特色: 優先使用 .env 中的 Builder API Key 進行認證，解決 401 錯誤。
 */

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { ethers } from "ethers";
import { createWalletClient, http, type Hex, encodeFunctionData, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { ClobClient } from "@polymarket/clob-client";
import { getContractConfig } from "../../lib/config.ts";

dotenvConfig({ path: resolve(import.meta.dirname, "../../../.env") });

const RELAYER_URL = "https://relayer-v2.polymarket.com";
const DATA_API_URL = "https://data-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const CHAIN_ID = 137;

// CTF redeemPositions ABI (viem format)
const ctfRedeemAbi = [
    {
        constant: false,
        inputs: [
            { name: "collateralToken", type: "address" },
            { name: "parentCollectionId", type: "bytes32" },
            { name: "conditionId", type: "bytes32" },
            { name: "indexSets", type: "uint256[]" }
        ],
        name: "redeemPositions",
        outputs: [],
        payable: false,
        stateMutability: "nonpayable",
        type: "function"
    }
] as const;

async function testRedeem() {
    const pk = process.env.PK;
    const funderAddress = process.env.FUNDER_ADDRESS;
    
    if (!pk) {
        console.error("❌ 缺少 PK 環境變數");
        return;
    }
    
    console.log("=".repeat(50));
    console.log("🎁 Safe 代理錢包領獎工具 (開發者認證版)");
    console.log("=".repeat(50));
    
    // 1. 初始化
    const account = privateKeyToAccount(pk as Hex);
    const viemWallet = createWalletClient({
        account,
        chain: polygon,
        transport: http(process.env.RPC_URL || "https://polygon-rpc.com")
    });
    
    const userAddress = funderAddress || account.address;
    console.log(`\n📋 錢包設定:`);
    console.log(`   EOA 地址: ${account.address}`);
    console.log(`   目標錢包: ${userAddress} ${funderAddress ? "(代理錢包)" : ""}`);

    // 2. 獲取 Builder API 認證
    let builderConfig: BuilderConfig | undefined;
    
    const bKey = process.env.BUILDER_API_KEY;
    const bSecret = process.env.BUILDER_SECRET;
    const bPass = process.env.BUILDER_PASS_PHRASE;

    if (bKey && bSecret && bPass) {
        console.log(`\n🔐 使用 .env 中的 Builder 金鑰進行認證:`);
        console.log(`   Key: ${bKey.slice(0, 8)}...`);
        builderConfig = new BuilderConfig({
            localBuilderCreds: {
                key: bKey,
                secret: bSecret,
                passphrase: bPass
            }
        });
        console.log(`   ✅ 已載入開發者認證配置`);
    } else {
        console.log(`\n🕵️ .env 未發現 Builder 金鑰，嘗試自動衍生 (可能遭遇 401)...`);
        try {
            const ethersWallet = new ethers.Wallet(pk);
            const clobClient = new ClobClient(CLOB_API_URL, CHAIN_ID, ethersWallet);
            const creds = await clobClient.createOrDeriveApiKey();
            const authClobClient = new ClobClient(CLOB_API_URL, CHAIN_ID, ethersWallet, creds);
            const builderKeys = await authClobClient.createBuilderApiKey();
            
            builderConfig = new BuilderConfig({
                localBuilderCreds: {
                    key: builderKeys.key,
                    secret: builderKeys.secret,
                    passphrase: builderKeys.passphrase
                }
            });
            console.log(`   ✅ 已自動衍生認證`);
        } catch (err: any) {
            console.error(`   ❌ 自動衍生失敗: ${err.message}`);
        }
    }
    
    // 3. 初始化 RelayClient
    console.log(`\n🔧 初始化 Relayer 客戶端...`);
    const relayClient = new RelayClient(
        RELAYER_URL,
        CHAIN_ID,
        viemWallet,
        builderConfig,
        RelayerTxType.SAFE
    );
    console.log(`   ✅ Relayer 客戶端就緒`);

    // 4. 掃描未領取獎勵
    let conditionId = process.argv[2];
    if (!conditionId) {
        console.log(`\n🔍 正在掃描錢包中的未領取獎勵...`);
        try {
            const resp = await fetch(`${DATA_API_URL}/positions?user=${userAddress}`);
            const positions: any[] = await resp.json();
            
            // 過濾出已結算且獲勝的持倉 (curPrice === 1 表示已結算為 $1)
            const rewards = positions.filter(p => p.size > 0 && p.curPrice === 1);
            
            if (rewards.length === 0) {
                console.log(`   ℹ️ 未發現任何可領取的獎勵持倉。`);
                return;
            }
            
            console.log(`\n✨ 發現 ${rewards.length} 筆可領取獎勵:`);
            console.log("-".repeat(50));
            rewards.forEach((r, idx) => {
                console.log(`${idx + 1}. [${r.title || r.asset}]`);
                console.log(`   Condition ID: ${r.conditionId}`);
                console.log(`   持有量: ${r.size} 股`);
                console.log("-".repeat(50));
            });
            
            console.log(`\n🚀 準備開始「批量」領取共 ${rewards.length} 筆獎勵...`);
            
            let successCount = 0;
            for (let i = 0; i < rewards.length; i++) {
                const r = rewards[i];
                console.log(`\n🎯 [${i + 1}/${rewards.length}] 執行領獎: ${r.title || r.asset}`);
                
                const success = await performRedeem(r.conditionId, relayClient, CHAIN_ID);
                if (success) successCount++;
                
                if (i < rewards.length - 1) {
                    console.log(`   ⏳ 等待 3 秒後處理下一筆...`);
                    await new Promise(res => setTimeout(res, 3000));
                }
            }
            
            console.log(`\n${"=".repeat(50)}`);
            console.log(`🏁 批量任務完成! 成功: ${successCount} | 失敗: ${rewards.length - successCount}`);
            console.log(`${"=".repeat(50)}`);
            return;
            
        } catch (err) {
            console.error(`   ❌ 掃描失敗:`, err);
            return;
        }
    } else {
        // 手動指定 Condition ID 模式
        console.log(`\n🎯 執行手動指定領獎:`);
        await performRedeem(conditionId, relayClient, CHAIN_ID);
    }
}

/**
 * 封裝單次領獎邏輯
 */
async function performRedeem(conditionId: string, relayClient: RelayClient, chainId: number): Promise<boolean> {
    const contractConfig = getContractConfig(chainId);
    const calldata = encodeFunctionData({
        abi: ctfRedeemAbi,
        functionName: "redeemPositions",
        args: [
            contractConfig.collateral as Hex,
            zeroHash,
            conditionId as Hex,
            [BigInt(1), BigInt(2)]
        ]
    });
    
    const redeemTx = {
        to: contractConfig.conditionalTokens,
        data: calldata,
        value: "0"
    };
    
    try {
        console.log(`   📤 發送 Relayer 交易...`);
        const response = await relayClient.execute([redeemTx], `redeem ${conditionId.slice(0, 10)}`);
        // console.log(`   ✅ 交易已提交! ID: ${response.transactionID}`);
        
        console.log(`   ⏳ 等待鏈上確認...`);
        const result = await response.wait();
        
        if (result && result.transactionHash) {
            console.log(`   ✅ 領取成功! Hash: ${result.transactionHash.slice(0, 10)}...`);
            return true;
        }
    } catch (error: any) {
        console.error(`   ❌ 領取異常:`);
        const errorData = error.response?.data || error.message;
        const errorStr = typeof errorData === "object" ? JSON.stringify(errorData) : errorData;
        
        if (errorStr.includes("revert") || errorStr.includes("insufficient") || errorStr.includes("already redeemed")) {
            console.warn(`   ℹ️ 提示: 可能已領取過，或該持倉目前無法領取。`);
        } else {
            console.error(`   原因: ${errorStr.slice(0, 200)}`);
        }
    }
    return false;
}

testRedeem().catch(console.error);
