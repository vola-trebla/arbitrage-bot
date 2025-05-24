import { BN } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

const buyIx = async (
    refinedPlan: any, 
    amountIn: any, 
    minAmountOut: any, 
    remainingAccounts: any[]
): Promise<TransactionInstruction[]> => {
    try {
        const instructions: TransactionInstruction[] = [];
        
        // Create swap1 instruction
        const swap1 = refinedPlan.swap1;
        if (!swap1 || !swap1.programId) {
            throw new Error("Invalid swap1 in refined plan");
        }
        
        const formattedAccounts1 = swap1.accounts.map((account: any) => ({
            pubkey: account.pubkey instanceof PublicKey ? account.pubkey : new PublicKey(account.pubkey),
            isSigner: account.isSigner || false,
            isWritable: account.isWritable || false
        }));
        
        const instruction1 = new TransactionInstruction({
            programId: new PublicKey(swap1.programId),
            keys: formattedAccounts1,
            data: Buffer.from(swap1.data, 'base64') // Decode from base64
        });
        
        instructions.push(instruction1);
        
        // Create swap2 instruction
        const swap2 = refinedPlan.swap2;
        if (!swap2 || !swap2.programId) {
            throw new Error("Invalid swap2 in refined plan");
        }
        
        const formattedAccounts2 = swap2.accounts.map((account: any) => ({
            pubkey: account.pubkey instanceof PublicKey ? account.pubkey : new PublicKey(account.pubkey),
            isSigner: account.isSigner || false,
            isWritable: account.isWritable || false
        }));
        
        const instruction2 = new TransactionInstruction({
            programId: new PublicKey(swap2.programId),
            keys: formattedAccounts2,
            data: Buffer.from(swap2.data, 'base64') // Decode from base64
        });
        
        instructions.push(instruction2);
        
        console.log(`✅ Created ${instructions.length} swap instructions`);
        return instructions;
        
    } catch (error) {
        console.error("Error creating buyIx instructions:", error);
        throw error;
    }
};

export {
    buyIx
}