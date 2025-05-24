import { Connection, PublicKey } from '@solana/web3.js';

// Simple function to get Orca price
export const getOrcaPrice = async (
  connection: Connection,
  inputMint: string,
  outputMint: string,
  amount: number
): Promise<number | null> => {
  try {
    console.log(`🐋 Checking Orca price: ${inputMint.slice(0,8)} -> ${outputMint.slice(0,8)}`);
    
    // Use Jupiter API but specify Orca DEXs only
    const orcaOnlyUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&dexes=Orca,Whirlpool,Orca%20V2&slippageBps=50`;
    
    const response = await fetch(orcaOnlyUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const orcaPrice = parseInt(data.outAmount);
    
    console.log(`   🌊 Orca price: ${amount} -> ${orcaPrice}`);
    return orcaPrice;
    
  } catch (error) {
    console.log(`   ❌ Orca check failed:`, error);
    return null;
  }
};