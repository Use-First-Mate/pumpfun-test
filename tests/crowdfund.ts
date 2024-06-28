import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Crowdfund } from "../target/types/crowdfund";
import { assert } from "chai";

describe("crowdfund", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider);

  const program = anchor.workspace.Crowdfund as Program<Crowdfund>;

  const signer = anchor.web3.Keypair.generate()
  
  const funder1 = anchor.web3.Keypair.generate()
  const funder2 = anchor.web3.Keypair.generate()

  const [surgePDA, surgeBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("SURGE"), signer.publicKey.toBuffer()],
    program.programId
  )
  const [funder1ReceiptPDA, funder1bump] = PublicKey.findProgramAddressSync(
    [funder1.publicKey.toBuffer()],
    program.programId
  )
  const [funder2ReceiptPDA, funder2bump] = PublicKey.findProgramAddressSync(
    [funder2.publicKey.toBuffer()],
    program.programId
  )
  it("Is initialized with the correct name", async () => {
        // Airdrop SOL to the signer

      const airdropSignature = await provider.connection.requestAirdrop(signer.publicKey, 2 * LAMPORTS_PER_SOL)
      const latestBlockHash = await provider.connection.getLatestBlockhash();

      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: airdropSignature
      });
      
    const tx = await program.methods
      .initialize("TEST_NAME")
      .accounts({ 
        signer: signer.publicKey,
      })
      .signers([signer])
      .rpc();
        
    const surgeAccount = await program.account.surge.fetch(surgePDA);

    // Check if the name is correctly set
    assert.equal(surgeAccount.name, "TEST_NAME", "The surge account name was not initialized correctly");
    console.log("Your transaction signature", tx);
    console.log(surgeAccount.amountDeposited)
  });

  it("accepts funds from user", async () => {
    //fund with funder 1, and confirm that pool amount is equal to expected amt
    const airdropSignature = await provider.connection.requestAirdrop(funder1.publicKey, 2 * LAMPORTS_PER_SOL)
    const latestBlockHash = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature
    });
    
    const tx = await program.methods
      .fund(new anchor.BN(1 * LAMPORTS_PER_SOL))
      .accounts({
        signer: funder1.publicKey,
        surge: surgePDA,
      })
      .signers([funder1])
      .rpc()
    
    //confirm that tx has succeeded
    //confirm recepit amount
    const funder1Receipt = await program.account.receipt.fetch(funder1ReceiptPDA)
    assert.equal(funder1Receipt.lamports.toString(), new anchor.BN(1 * LAMPORTS_PER_SOL).toString())
    //confirm surge amount
    const surgeAccount = await program.account.surge.fetch(surgePDA)
    assert.equal(surgeAccount.amountDeposited.toString(), new anchor.BN(1 * LAMPORTS_PER_SOL).toString())

  })
  it("can pool funds from multiple users", async () => {
    //fund with funder 2, and confirm that pool amount is equal to 1 + 2
    const airdropSignature = await provider.connection.requestAirdrop(funder2.publicKey, 2 * LAMPORTS_PER_SOL)
    const latestBlockHash = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature
    });
    const tx = await program.methods
    .fund(new anchor.BN(1.5 * LAMPORTS_PER_SOL))
    .accounts({
      signer: funder2.publicKey,
      surge: surgePDA,
    })
    .signers([funder2])
    .rpc()


    const funder2Receipt = await program.account.receipt.fetch(funder2ReceiptPDA)
    assert.equal(funder2Receipt.lamports.toString(), new anchor.BN(1.5 * LAMPORTS_PER_SOL).toString())
    //confirm surge amount
    const surgeAccount = await program.account.surge.fetch(surgePDA)
    assert.equal(surgeAccount.amountDeposited.toString(), new anchor.BN(2.5 * LAMPORTS_PER_SOL).toString())
  })
  it("allows admin user to deploy funds and deploys funds to that wallet", async () => {
    const initialAdminBalance = await provider.connection.getBalance(signer.publicKey)
    //admin user tries to deploy funds and succeeds
    const tx = await program.methods
      .deploy()
      .accounts({
        surge: surgePDA,
        signer: signer.publicKey
      })
      .signers([signer])
      .rpc()
    // Get the transaction details using the signature
    await new Promise(resolve => setTimeout(resolve, 1000));

    const transactionDetails = await provider.connection.getParsedTransaction(tx, "confirmed");

    // Calculate the total transaction fee - seems like this is not actually required, even though in the end we check
    // the balance of the signer
    //const transactionFee = transactionDetails.meta.fee;
    const expectedDepositAmount = .125 * LAMPORTS_PER_SOL
    const balanceAfterDeploy = await provider.connection.getBalance(signer.publicKey)
   
    assert.equal(balanceAfterDeploy, (initialAdminBalance + expectedDepositAmount), "The admin wallet balance in incorrect after deploying funds")
  }),

  it("disallows unauthorized users from deploying funds", async () => {
    //one of the funders attempts to deploy funds and fails
    try {
      await program.methods
        .deploy()
        .accounts({
            surge: surgePDA,
            signer: funder1.publicKey
        })
        .signers([funder1])
        .rpc()
        assert.fail("The deployment should have failed due to NotAdmin error.");
    } catch (err) {
      const error = err as anchor.AnchorError;
      assert.equal(error.error.errorMessage, "A seeds constraint was violated");
    }
  })
  it("allows signer to claim to their own ATA", async() => {

  })
  it("only doesn't allow signer to claim to other ATAf", async () => {

  })
});
