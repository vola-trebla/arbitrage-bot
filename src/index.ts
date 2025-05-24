import { request } from "undici";
import { BN } from "@coral-xyz/anchor";
import {
  closeAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TransactionInstruction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { sendSolayerTx, sendTxUsingJito } from "./fast-landing-api";
import { connection, payer } from "./config/program";
import { JupiterQuoteResponse } from "./types";
import { STABLE_COIN } from "./constant/address";
import { JUPITER_PROGRAM_ADDR, JUPITER_TRANSFER_AUTH } from "./constant";
import { confirmTransaction, decodeRouteArgs } from "./module";
import { fetchSwapInstructions, getJupiterQuote } from "./module/getQuote";
import { upperAmountWithDecimal } from "./config/loadEnv";
import { SWAP_QUOTE_BASE_URL, SWAP_QUOTE_LITE_BASE_URL } from "./constant/url";
import { parseAccount } from "./module/decode";
import { buyIx } from "./module/buildTx";
import { sleep } from "./utils";

let initialBalance = 0;

// SUCCESS TRACKING VARIABLES
let totalTrades = 0;
let successfulTrades = 0;
let totalProfit = 0;

const getRoute = async (
  mintAddr1: string,
  mintAddr2: string,
  amountIn: number
) => {
  const userAta = getAssociatedTokenAddressSync(
    new PublicKey(mintAddr1),
    payer.publicKey
  );
  const beforeBalance = await connection.getTokenAccountBalance(userAta);

  try {
    console.log(`🔍 Checking arbitrage: ${mintAddr1.slice(0,4)}...${mintAddr1.slice(-4)} -> ${mintAddr2.slice(0,4)}...${mintAddr2.slice(-4)} -> ${mintAddr1.slice(0,4)}...${mintAddr1.slice(-4)}`);
    
    let arbitrageQuote;
    
    try {
      // Method 1: Try Jupiter's route with intermediate tokens (if supported)
      const multiHopUrl = `${SWAP_QUOTE_BASE_URL}?inputMint=${mintAddr1}&outputMint=${mintAddr1}&amount=${amountIn}&slippageBps=100&maxAccounts=64&platformFeeBps=0&intermediateTokens[]=${mintAddr2}`;
      
      console.log(`🛣️ Trying multi-hop route through ${mintAddr2.slice(0,8)}...`);
      
      const multiHopRes = await fetch(multiHopUrl);
      if (multiHopRes.ok) {
        arbitrageQuote = await multiHopRes.json() as any;
        console.log(`✅ Got multi-hop quote: ${arbitrageQuote.routePlan?.length || 0} steps`);
      } else {
        throw new Error(`Multi-hop failed: ${multiHopRes.status}`);
      }
      
    } catch (multiHopError) {
      console.log(`⚠️ Multi-hop failed: ${multiHopError}`);
      
      // Method 2: Manual route construction using Jupiter's route planning
      try {
        console.log(`🔧 Building manual multi-step route...`);
        
        // Get individual quotes to understand the path
        const quote1Url = `${SWAP_QUOTE_BASE_URL}?inputMint=${mintAddr1}&outputMint=${mintAddr2}&amount=${amountIn}&slippageBps=50`;
        const res1 = await fetch(quote1Url);
        if (!res1.ok) throw new Error(`Quote1 failed: ${res1.status}`);
        const quote1 = await res1.json() as any;
        
        const quote2Url = `${SWAP_QUOTE_BASE_URL}?inputMint=${mintAddr2}&outputMint=${mintAddr1}&amount=${quote1.outAmount}&slippageBps=50`;
        const res2 = await fetch(quote2Url);
        if (!res2.ok) throw new Error(`Quote2 failed: ${res2.status}`);
        const quote2 = await res2.json() as any;
        
        // IMPROVED QUOTE ANALYSIS
        console.log(`💹 Quote analysis:`);
        console.log(`   Step 1: ${amountIn} WSOL -> ${quote1.outAmount} ${mintAddr2.slice(0,8)}`);
        console.log(`   Step 2: ${quote1.outAmount} ${mintAddr2.slice(0,8)} -> ${quote2.outAmount} WSOL`);
        console.log(`   Price Impact: ${quote1.priceImpactPct}% + ${quote2.priceImpactPct}%`);

        // IMPROVED PROFITABILITY CALCULATION with safety margins
        const estimatedGasCost = 15000; // ~0.000015 SOL gas fees for 2 transactions
        const safetyMargin = 75000; // Additional 0.000075 SOL buffer for slippage
        const minimumProfitRequired = amountIn + upperAmountWithDecimal + estimatedGasCost + safetyMargin;

        if (minimumProfitRequired > Number(quote2.outAmount)) {
          const actualLoss = minimumProfitRequired - Number(quote2.outAmount);
          console.log(`💸 Not profitable after fees - IN: ${amountIn}, OUT: ${Number(quote2.outAmount)}, Loss: ${actualLoss}`);
          
          // TRACK FAILED TRADES
          totalTrades++;
          console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
          return;
        }
        
        const netProfit = Number(quote2.outAmount) - minimumProfitRequired;
        const netProfitSol = netProfit / LAMPORTS_PER_SOL;
        const netProfitPct = (netProfit / amountIn) * 100;

        console.log(`📈 NET PROFIT (after fees): ${netProfitSol.toFixed(6)} SOL (${netProfitPct.toFixed(3)}%)`);

        // Only proceed if net profit is positive
        if (netProfit <= 0) {
          console.log("💸 Insufficient profit after fees and safety margin");
          totalTrades++;
          console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
          return;
        }
        
        // EXECUTE SEQUENTIAL SWAPS
        console.log("🚀 Step 1: Execute first swap...");
        
        // Execute first swap
        const swap1Body = JSON.stringify({
          quoteResponse: quote1,
          wrapAndUnwrapSol: false,
          useSharedAccounts: false,
          userPublicKey: payer.publicKey.toBase58(),
        });
        
        const swap1Res = await request('https://quote-api.jup.ag/v6/swap-instructions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: swap1Body,
        });
        
        const swap1Data = await swap1Res.body.json() as any;
        
        if (swap1Data.error) {
          console.log("❌ Swap1 instruction error:", swap1Data.error);
          totalTrades++;
          console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
          return;
        }
        
        // Build first transaction
        const swap1Instruction = new TransactionInstruction({
          programId: new PublicKey(swap1Data.swapInstruction.programId),
          keys: swap1Data.swapInstruction.accounts.map((acc: any) => ({
            pubkey: new PublicKey(acc.pubkey),
            isSigner: acc.isSigner || false,
            isWritable: acc.isWritable || false
          })),
          data: Buffer.from(swap1Data.swapInstruction.data, 'base64')
        });
        
        // Create intermediate token ATA if needed
        const intermediateTokenMint = new PublicKey(mintAddr2);
        const intermediateATA = getAssociatedTokenAddressSync(intermediateTokenMint, payer.publicKey);
        
        const createIntermediateATA = createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          intermediateATA,
          payer.publicKey,
          intermediateTokenMint
        );
        
        // Load lookup tables for swap1
        const lookupTableAccounts1: AddressLookupTableAccount[] = [];
        for (const lut of swap1Data.addressLookupTableAddresses || []) {
          try {
            const res = await connection.getAddressLookupTable(new PublicKey(lut));
            if (res.value) lookupTableAccounts1.push(res.value);
          } catch (error) {
            console.warn("⚠️ Error loading LUT:", lut);
          }
        }
        
        // Build and send first transaction
        let latestBlockhash = await connection.getLatestBlockhash();
        
        const message1V0 = new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [createIntermediateATA, swap1Instruction],
        }).compileToV0Message(lookupTableAccounts1);
        
        const tx1 = new VersionedTransaction(message1V0);
        tx1.sign([payer]);
        
        const serializedTx1 = tx1.serialize();
        const transactionContent1 = bs58.encode(serializedTx1);
        
        const sig1 = await sendSolayerTx(transactionContent1);
        console.log("📄 Swap1 Transaction signature:", sig1.result);
        
        // Wait for first transaction to confirm
        await confirmTransaction(connection, sig1.result, 'confirmed', 20000);
        console.log("✅ First swap completed!");
        
        // Small delay to ensure blockchain state is updated
        await sleep(1500); // Increased delay for better reliability
        
        console.log("🚀 Step 2: Execute second swap...");
        
        // Get the actual balance of intermediate token
        const intermediateBalance = await connection.getTokenAccountBalance(intermediateATA);
        const actualIntermediateAmount = intermediateBalance.value.amount;
        
        console.log(`💰 Intermediate token balance: ${actualIntermediateAmount}`);
        
        // Verify we have enough intermediate tokens
        if (Number(actualIntermediateAmount) === 0) {
          console.log("❌ No intermediate tokens found - first swap may have failed");
          totalTrades++;
          console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
          return;
        }
        
        // Get fresh quote for second swap with actual amount
        const quote2FreshUrl = `${SWAP_QUOTE_BASE_URL}?inputMint=${mintAddr2}&outputMint=${mintAddr1}&amount=${actualIntermediateAmount}&slippageBps=50`;
        const res2Fresh = await fetch(quote2FreshUrl);
        if (!res2Fresh.ok) throw new Error(`Fresh quote2 failed: ${res2Fresh.status}`);
        const quote2Fresh = await res2Fresh.json() as any;
        
        console.log(`🔄 Fresh quote2: ${actualIntermediateAmount} ${mintAddr2.slice(0,8)} -> ${quote2Fresh.outAmount} WSOL`);
        
        // Execute second swap
        const swap2Body = JSON.stringify({
          quoteResponse: quote2Fresh,
          wrapAndUnwrapSol: false,
          useSharedAccounts: false,
          userPublicKey: payer.publicKey.toBase58(),
        });
        
        const swap2Res = await request('https://quote-api.jup.ag/v6/swap-instructions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: swap2Body,
        });
        
        const swap2Data = await swap2Res.body.json() as any;
        
        if (swap2Data.error) {
          console.log("❌ Swap2 instruction error:", swap2Data.error);
          totalTrades++;
          console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
          return;
        }
        
        // Build second transaction
        const swap2Instruction = new TransactionInstruction({
          programId: new PublicKey(swap2Data.swapInstruction.programId),
          keys: swap2Data.swapInstruction.accounts.map((acc: any) => ({
            pubkey: new PublicKey(acc.pubkey),
            isSigner: acc.isSigner || false,
            isWritable: acc.isWritable || false
          })),
          data: Buffer.from(swap2Data.swapInstruction.data, 'base64')
        });
        
        // Close intermediate ATA
        const closeIntermediateATA = createCloseAccountInstruction(
          intermediateATA,
          payer.publicKey,
          payer.publicKey
        );
        
        // Load lookup tables for swap2
        const lookupTableAccounts2: AddressLookupTableAccount[] = [];
        for (const lut of swap2Data.addressLookupTableAddresses || []) {
          try {
            const res = await connection.getAddressLookupTable(new PublicKey(lut));
            if (res.value) lookupTableAccounts2.push(res.value);
          } catch (error) {
            console.warn("⚠️ Error loading LUT:", lut);
          }
        }
        
        // Build and send second transaction
        latestBlockhash = await connection.getLatestBlockhash();
        
        const message2V0 = new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [swap2Instruction, closeIntermediateATA],
        }).compileToV0Message(lookupTableAccounts2);
        
        const tx2 = new VersionedTransaction(message2V0);
        tx2.sign([payer]);
        
        const serializedTx2 = tx2.serialize();
        const transactionContent2 = bs58.encode(serializedTx2);
        
        const sig2 = await sendSolayerTx(transactionContent2);
        console.log("📄 Swap2 Transaction signature:", sig2.result);
        
        // Wait for second transaction to confirm
        await confirmTransaction(connection, sig2.result, 'confirmed', 20000);
        console.log("✅ Second swap completed!");
        
        // Check final balance and calculate actual profit
        const afterBalance = await connection.getTokenAccountBalance(userAta);
        const actualProfit = (afterBalance.value.uiAmount || 0) - (beforeBalance.value.uiAmount || 0);
        const totalChange = initialBalance - (afterBalance.value.uiAmount || 0);
        
        console.log(`💰 Balance: ${beforeBalance.value.uiAmount} -> ${afterBalance.value.uiAmount}`);
        console.log(`💹 ACTUAL PROFIT: ${actualProfit.toFixed(6)} SOL ($${(actualProfit * 200).toFixed(4)})`); // Assuming $200/SOL
        console.log(`📊 Total P&L: ${totalChange > 0 ? "+" : ""}${totalChange}`);
        
        // UPDATE SUCCESS TRACKING
        successfulTrades++;
        totalTrades++;
        totalProfit += actualProfit;
        
        console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
        console.log(`💰 TOTAL PROFIT: ${totalProfit.toFixed(6)} SOL ($${(totalProfit * 200).toFixed(2)})`);
        console.log("🎉 Sequential arbitrage completed successfully!");
        
        return;
        
      } catch (manualError) {
        console.log("❌ Manual route construction failed:", manualError);
        totalTrades++;
        console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
        return;
      }
    }
    
    // Multi-hop quote path (rarely works)
    if (amountIn + upperAmountWithDecimal > Number(arbitrageQuote.outAmount)) {
      console.log("💸 Not profitable - IN:", amountIn, "=> OUT:", Number(arbitrageQuote.outAmount));
      totalTrades++;
      console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
      return;
    }
    
    const profitLamports = Number(arbitrageQuote.outAmount) - amountIn;
    const profitSol = profitLamports / LAMPORTS_PER_SOL;
    const profitPct = (profitLamports / amountIn) * 100;
    
    console.log(`📈 PROFIT: ${profitSol.toFixed(6)} SOL (${profitPct.toFixed(2)}%)`);
    console.log("📈 IN:", amountIn, "=> OUT:", Number(arbitrageQuote.outAmount));
    console.log("⚡ Running Multi-Hop Transaction...");
    
    // Execute multi-hop transaction
    const swapBody = JSON.stringify({
      quoteResponse: arbitrageQuote,
      wrapAndUnwrapSol: false,
      useSharedAccounts: false,
      userPublicKey: payer.publicKey.toBase58(),
    });
    
    const swapRes = await request('https://quote-api.jup.ag/v6/swap-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: swapBody,
    });
    
    const swapData = await swapRes.body.json() as any;
    
    if (swapData.error) {
      console.log("❌ Multi-hop swap instruction error:", swapData.error);
      totalTrades++;
      console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
      return;
    }
    
    // Continue with single transaction approach if multi-hop worked
    console.log("✅ Multi-hop route worked! Executing single transaction...");
    
  } catch (error) {
    console.error("❌ Arbitrage failed:", error);
    totalTrades++;
    console.log(`📊 SUCCESS RATE: ${successfulTrades}/${totalTrades} (${((successfulTrades/totalTrades)*100).toFixed(1)}%)`);
  }
};

// PHASE 1: Test with proven high-liquidity tokens first
const stables = [
  STABLE_COIN.usdc,  // Highest liquidity
  STABLE_COIN.usdt,  // Second highest
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL - very popular
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL - high liquidity
];

// PHASE 2: After success rate stabilizes above 80%, add more:
// "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH
// "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // BTC
// "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP

// QUICK FIX: Update your start() function to be much slower

const start = async () => {
  console.log("🚀 Jupiter Arbitrage Bot v2.0 (Rate Limited Mode) 🚀");
  console.log("Arbitrage Bot Addr:", payer.publicKey.toBase58());

  // ... your existing balance checking code ...

  const WSOL_MINT = "So11111111111111111111111111111111111111112";
  
  // REDUCE to only high-liquidity tokens
  const stables = [
    STABLE_COIN.usdc,     // Only USDC
    STABLE_COIN.usdt,     // Only USDT
    // Remove others to reduce API calls
  ];
  
  while (1) {
    try {
      for (const stable of stables) {
        console.log(`⏳ Checking ${stable.slice(0,8)}... (respecting rate limits)`);
        
        await getRoute(WSOL_MINT, stable, LAMPORTS_PER_SOL * 0.005);
        
        // MUCH LONGER DELAY - Respect 1 request per second limit
        console.log("😴 Waiting 3 seconds to respect Jupiter's rate limits...");
        await sleep(3000); // 3 seconds between each token check
      }
    } catch (error) {
      console.error("🚨 Main loop error:", error);
    }
    
    if (totalTrades > 0) {
      console.log(`\n📊 CYCLE STATS: ${successfulTrades}/${totalTrades} success, ${totalProfit.toFixed(6)} SOL profit\n`);
    }
    
    // EVEN LONGER DELAY between cycles
    console.log("😴 Cycle complete. Sleeping for 15 seconds...");
    await sleep(15000); // 15 seconds between cycles
  }
};

start();