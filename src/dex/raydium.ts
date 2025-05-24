import { Connection, PublicKey } from '@solana/web3.js';

// Simple function to get Raydium price  
export const getRaydiumPrice = async (
  connection: Connection,
  inputMint: string,
  outputMint: string,
  amount: number
): Promise<number | null> => {
  try {
    console.log(`🔍 Checking Raydium price: ${inputMint.slice(0,8)} -> ${outputMint.slice(0,8)}`);
    
    // SIMPLE APPROACH: Use Jupiter API but specify Raydium only
    const raydiumOnlyUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&dexes=Raydium,Raydium%20CLMM,Raydium%20CP&slippageBps=50`;
    
    const response = await fetch(raydiumOnlyUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const raydiumPrice = parseInt(data.outAmount);
    
    console.log(`   💰 Raydium price: ${amount} -> ${raydiumPrice}`);
    return raydiumPrice;
    
  } catch (error) {
    console.log(`   ❌ Raydium check failed:`, error);
    return null;
  }
};