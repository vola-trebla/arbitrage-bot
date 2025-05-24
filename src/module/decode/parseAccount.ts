import { PublicKey } from "@solana/web3.js";

const parseAccount = (ix1: any, ix2: any, data1: any, data2: any) => {
    try {
        // Extract accounts from swapInstruction (fixed path)
        const accounts1 = ix1?.swapInstruction?.accounts || [];
        const accounts2 = ix2?.swapInstruction?.accounts || [];
        
        // Combine all accounts
        const allAccounts = [...accounts1, ...accounts2];
        
        // Extract unique lookup tables from ix1 and ix2
        const luts1 = ix1?.addressLookupTableAddresses || [];
        const luts2 = ix2?.addressLookupTableAddresses || [];
        const uniqueLUT = [...new Set([...luts1, ...luts2])];
        
        // Extract unique token mints from data1 and data2
        const tokens1 = [data1?.inputMint, data1?.outputMint].filter(Boolean);
        const tokens2 = [data2?.inputMint, data2?.outputMint].filter(Boolean);
        const uniqueTokens = [...new Set([...tokens1, ...tokens2])];
        
        // SKIP COMPLEX DECODING - Use Jupiter's raw data directly
        const refinedPlan = {
            swap1: {
                programId: ix1?.swapInstruction?.programId,
                accounts: accounts1,
                data: ix1?.swapInstruction?.data, // Keep as base64 string
                inputMint: data1?.inputMint,
                outputMint: data1?.outputMint,
                inAmount: data1?.inAmount,
                outAmount: data1?.outAmount,
                swapMode: data1?.swapMode || "ExactIn"
            },
            swap2: {
                programId: ix2?.swapInstruction?.programId,
                accounts: accounts2,
                data: ix2?.swapInstruction?.data, // Keep as base64 string
                inputMint: data2?.inputMint,
                outputMint: data2?.outputMint,
                inAmount: data2?.inAmount,
                outAmount: data2?.outAmount,
                swapMode: data2?.swapMode || "ExactIn"
            }
        };
        
        // Create remaining accounts array with proper deduplication
        const accountMap = new Map();
        
        // Add all accounts to map (this automatically deduplicates by pubkey)
        allAccounts.forEach((account: any) => {
            const pubkeyStr = account.pubkey.toString();
            if (!accountMap.has(pubkeyStr)) {
                accountMap.set(pubkeyStr, {
                    pubkey: new PublicKey(account.pubkey),
                    isSigner: account.isSigner || false,
                    isWritable: account.isWritable || false
                });
            } else {
                // If duplicate, ensure it's writable if any instance is writable
                const existing = accountMap.get(pubkeyStr);
                existing.isWritable = existing.isWritable || account.isWritable || false;
                existing.isSigner = existing.isSigner || account.isSigner || false;
            }
        });
        
        const uniqueRemainingAccounts = Array.from(accountMap.values());
        
        console.log(`📊 Parsed ${accounts1.length} + ${accounts2.length} accounts, ${uniqueRemainingAccounts.length} unique`);
        console.log(`🔗 Found ${uniqueLUT.length} lookup tables`);
        console.log(`🪙 Found ${uniqueTokens.length} unique tokens:`, uniqueTokens);
        
        return {
            refinedPlan,
            remainingAccounts: uniqueRemainingAccounts,
            uniqueLUT,
            uniqueTokens
        };
        
    } catch (error) {
        console.error("Error in parseAccount:", error);
        console.log("ix1 structure:", Object.keys(ix1 || {}));
        console.log("ix2 structure:", Object.keys(ix2 || {}));
        return undefined;
    }
};

export {
    parseAccount
}