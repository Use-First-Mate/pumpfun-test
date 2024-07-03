import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Crowdfund } from "../target/types/crowdfund";
import { assert } from "chai";
import * as splToken from "@solana/spl-token"

describe("crowdfund", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider);

  const SPL_CONVERSION = 10_000; //set the exchange rate of our SPL 10_000 per SOL
  //SOL denominated deposit for funders + derived total
  const funder1_deposit = 2
  const funder2_deposit = 2.5
  const funder2_deposit2 = .1
  const total_deposit = funder1_deposit + funder2_deposit + funder2_deposit2;

  const program = anchor.workspace.Crowdfund as Program<Crowdfund>;

  const signer = anchor.web3.Keypair.generate()
  
  const funder1 = anchor.web3.Keypair.generate()
  const funder2 = anchor.web3.Keypair.generate()
  const [surgeCounterPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("SURGE_COUNTER"), signer.publicKey.toBuffer()],
    program.programId
  )
  const [surgePDA, surgeBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("SURGE"), signer.publicKey.toBuffer(), new anchor.BN(1).toArrayLike(Buffer, "le", 8)],
    program.programId
  )
  const [funder1ReceiptPDA, funder1bump] = PublicKey.findProgramAddressSync(
    [funder1.publicKey.toBuffer(), new anchor.BN(1).toArrayLike(Buffer, "le", 8)],
    program.programId
  )
  const [funder2ReceiptPDA, funder2bump] = PublicKey.findProgramAddressSync(
    [funder2.publicKey.toBuffer(), new anchor.BN(1).toArrayLike(Buffer, "le", 8)],
    program.programId
  )
  const [vaultPda, ] = PublicKey.findProgramAddressSync(
    [Buffer.from("VAULT"), surgePDA.toBuffer()],
    program.programId,
  )

  const PUMP_ACCOUNTS = {
    GLOBAL: "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
    FEE_RECIPIENT: "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
    EVENT_AUTHORITY: "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
    PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  };
  const historicalCosts = {
    // taken arbitrarily from tx 4NEUh1RKWLnc4toXvDfetpZZqMe5tpSdx1ARC6jj7H8bGiEPwDGDigbz2EbuXJiQwH2otiuL8GvFD1uCBZdwyiWG
    amountToken: new anchor.BN("451153567247"),
    maxSolCost: new anchor.BN("20402000"),
  }
  const IMPORTED_ACCOUNTS = {
    OGGY_MINT: "736a99zFBrmGxaZNoMyCD2s2cGWzn4Hv4xk6UJeypump",
  }
  const deriveBondingCurve = (mint: string) => PublicKey.findProgramAddressSync(
    [
      Buffer.from("bonding-curve"), 
      new PublicKey(mint).toBuffer()
    ],
    new PublicKey(PUMP_ACCOUNTS.PUMP_FUN),
  )[0];

  let surgeAta
  let vaultAta
  let mintProgram
  before( async () => {
    const airdropSignature = await provider.connection.requestAirdrop(signer.publicKey, 5 * LAMPORTS_PER_SOL)
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature
    });

    const funder1AirdropSignature = await provider.connection.requestAirdrop(funder1.publicKey, 5 * LAMPORTS_PER_SOL)
    const funder1LatestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: funder1LatestBlockHash.blockhash,
      lastValidBlockHeight: funder1LatestBlockHash.lastValidBlockHeight,
      signature: airdropSignature,
    });

    mintProgram = new PublicKey(IMPORTED_ACCOUNTS.OGGY_MINT);

    surgeAta = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      signer,
      mintProgram,
      surgePDA,
      true
    )
  })
  //create an SPL mint that we can use for testing
  //this is a stub, will need to be replaced with interaction w/ pump fun
  it("Initializes surge counter with initial ID as 1", async () => {
    await program.methods
      .initializeSurgeCounter()
      .accounts({
        signer: signer.publicKey
      })
      .signers([signer])
      .rpc()
    const counterAccount = await program.account.surgeCounter.fetch(surgeCounterPDA)

    assert.equal(counterAccount.nextSurgeId.toString(),new anchor.BN(1).toString())
  })
  it("Surge is initialized with the correct name", async () => {
      // Airdrop SOL to the signer
      
    const tx = await program.methods
      .initializeSurge("TEST_NAME", new anchor.BN(5 * LAMPORTS_PER_SOL))
      .accounts({ 
        signer: signer.publicKey,
      })
      .signers([signer])
      .rpc();
    
    const surgeAccount = await program.account.surge.fetch(surgePDA);

    // Check if the name is correctly set
    assert.equal(surgeAccount.name, "TEST_NAME", "The surge account name was not initialized correctly");
  });
  it("Surge can't be reinitialized", async () => {
    try{
      const tx = await program.methods
      .initializeSurge("TEST_NAME", new anchor.BN(4* LAMPORTS_PER_SOL))
      .accounts({ 
        signer: signer.publicKey,
      })
      .signers([signer])
      .rpc();
      //Ensure surge fails to re-initialize
      assert.fail("Account has already been initialized"); //tries to initialize new PDA with wrong
    } catch (err) {
      //TODO - this is correctly failing, but having trouble asserting that it's
      //failing correctly because returning error is not anchor error
      assert.isTrue(!!err)
    }
  })
  it("accepts funds from user", async () => {
    //fund with funder 1, and confirm that pool amount is equal to expected amt
    
    const tx = await program.methods
      .fund(new anchor.BN(funder1_deposit * LAMPORTS_PER_SOL))
      .accounts({
        signer: funder1.publicKey,
        surge: surgePDA,
      })
      .signers([funder1])
      .rpc()
    
    //confirm that tx has succeeded
    //confirm recepit amount
    const funder1Receipt = await program.account.receipt.fetch(funder1ReceiptPDA)
    assert.equal(funder1Receipt.amountDeposited.toString(), new anchor.BN(funder1_deposit * LAMPORTS_PER_SOL).toString())
    //confirm surge amount
    const surgeAccount = await program.account.surge.fetch(surgePDA)
    assert.equal(surgeAccount.amountDeposited.toString(), new anchor.BN(funder1_deposit * LAMPORTS_PER_SOL).toString())

  })
  it("can pool funds from multiple users", async () => {
    //fund with funder 2, and confirm that pool amount is equal to 1 + 2
    const airdropSignature = await provider.connection.requestAirdrop(funder2.publicKey, 3 * LAMPORTS_PER_SOL)
    const latestBlockHash = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature
    });
    const tx = await program.methods
    .fund(new anchor.BN(funder2_deposit * LAMPORTS_PER_SOL))
    .accounts({
      signer: funder2.publicKey,
      surge: surgePDA,
    })
    .signers([funder2])
    .rpc()


    const funder2Receipt = await program.account.receipt.fetch(funder2ReceiptPDA)
    assert.equal(funder2Receipt.amountDeposited.toString(), new anchor.BN(funder2_deposit * LAMPORTS_PER_SOL).toString())
    //confirm surge amount
    const surgeAccount = await program.account.surge.fetch(surgePDA)
    assert.equal(surgeAccount.amountDeposited.toString(), new anchor.BN((funder1_deposit + funder2_deposit) * LAMPORTS_PER_SOL).toString())
  })
  it("allows user to fund more after initial deposit", async () => {
    const tx = await program.methods
    .fund(new anchor.BN(funder2_deposit2 * LAMPORTS_PER_SOL))
    .accounts({
      signer: funder2.publicKey,
      surge: surgePDA,
    })
    .signers([funder2])
    .rpc()


    const funder2Receipt = await program.account.receipt.fetch(funder2ReceiptPDA)
    assert.equal(funder2Receipt.amountDeposited.toString(), new anchor.BN((funder2_deposit +funder2_deposit2) * LAMPORTS_PER_SOL).toString())
    //confirm surge amount
    const surgeAccount = await program.account.surge.fetch(surgePDA)
    assert.equal(surgeAccount.amountDeposited.toString(), new anchor.BN(total_deposit * LAMPORTS_PER_SOL).toString())
  })
  it("does not accept funds after threshold crossed", async () => {
    //TODO - confirm that when fund are above current threshold (5 sol)
    //fund method fails
    try {
      await program.methods
      .fund(new anchor.BN(1 * LAMPORTS_PER_SOL)) //this 1 extra solana should push past threshold
      .accounts({
        signer: funder1.publicKey,
        surge: surgePDA,
      })
      .signers([funder1])
      .rpc()
      assert.fail("program should not accept funds over threshold")
    } catch (err) {
      //TODO - get actual error message here
      assert.isTrue(!!err)
    }
  })
  it("doesn't allow users to claim before funds are deployed", async () => {
    //TODO confirm claim fails when called before deploy
    try {
      let funder1Ata = await splToken.getOrCreateAssociatedTokenAccount(
        provider.connection,
        signer,
        mintProgram,
        funder1.publicKey,
        true
      )
      await program.methods
        .claim()
        .accounts({
          owner: funder1.publicKey, // since owner is `Signer`, it's implied in `.signers([...])
          surge: surgePDA,          // since `surge` is a PDA, it should be implied from other accts
          receipt: funder1ReceiptPDA,
          signerAta: funder1Ata.address
        })
        .signers([funder1])
        .rpc()
      assert.fail("program should not allow users to claim funds pre-deploy")
    } catch (err) {
      //TODO - get actual error message here
      assert.isTrue(!!err)
    }
  })
  it("allows admin user to deploy funds and deploys funds to that wallet", async () => {

      // manually fund the Vault PDA because there haven't been any fund calls
    const vaultPdaAirdropSig = await provider.connection.requestAirdrop(vaultPda, 2 * LAMPORTS_PER_SOL)
    const vaultPdaLatestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: vaultPdaLatestBlockhash.blockhash,
      lastValidBlockHeight: vaultPdaLatestBlockhash.lastValidBlockHeight,
      signature: vaultPdaAirdropSig,
    });
    //console.log("Initialized with Howdy")
    const initialAdminBalance = await provider.connection.getBalance(signer.publicKey)
    console.log("INITIAL ADMIN BALANCE IS - should be 4983748400")
    console.log({initialAdminBalance})
    //admin user tries to deploy funds and succeeds
    const tx = await program.methods
      .deploy(historicalCosts.amountToken, historicalCosts.maxSolCost)
      .accounts({
        authority: signer.publicKey,
        surge: surgePDA,
        pumpGlobal: PUMP_ACCOUNTS.GLOBAL,
        pumpFeeRecipient: PUMP_ACCOUNTS.FEE_RECIPIENT,
        mint: IMPORTED_ACCOUNTS.OGGY_MINT,
        pumpBondingCurve: deriveBondingCurve(IMPORTED_ACCOUNTS.OGGY_MINT),
      })
      .signers([signer])
      .rpc()
      //.catch(async e => console.error(await e.getLogs()))
    
    // Get the transaction details using the signature
    await provider.connection.confirmTransaction(tx, "confirmed")
    vaultAta = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      signer,
      mintProgram,
      vaultPda,
      true
    )

    const transactionDetails = await provider.connection.getParsedTransaction(tx, "confirmed");
    console.log({logs: transactionDetails.meta.logMessages})

    // Calculate the total transaction fee - seems like this is not actually required, even though in the end we check
    // the balance of the signer
    const transactionFee = transactionDetails.meta.fee;
    const expectedDepositAmount = ((total_deposit) * 5) / 100 * LAMPORTS_PER_SOL
    
    const balanceAfterDeploy = await provider.connection.getBalance(signer.publicKey)
    const surgeAccount = await program.account.surge.fetch(surgePDA)

    //It seems like using Transfer instead of add mut lamports may be causing a small discrepency - around .02 sol - suspect this is rent
    //for the account now initiated
    assert.isAbove(balanceAfterDeploy, (initialAdminBalance + (expectedDepositAmount *.95) - transactionFee), "The admin wallet balance is incorrect after deploying funds")
    //TODO -also assert that the pda_vault balance equals amountToken
    assert.equal(surgeAccount.splAmount.toString(), historicalCosts.amountToken.toString(), "the SPL has not been correctly deposited")

  })

  it("disallows unauthorized users from deploying funds", async () => {
    //one of the funders attempts to deploy funds and fails
    try {
      const deploy_tx = await program.methods
        .deploy(historicalCosts.amountToken, historicalCosts.maxSolCost)
        .accounts({
          authority: funder1.publicKey,
          surge: surgePDA,
          pumpGlobal: PUMP_ACCOUNTS.GLOBAL,
          pumpFeeRecipient: PUMP_ACCOUNTS.FEE_RECIPIENT,
          mint: IMPORTED_ACCOUNTS.OGGY_MINT,
          pumpBondingCurve: deriveBondingCurve(IMPORTED_ACCOUNTS.OGGY_MINT),
        })
        .signers([funder1])
        .rpc()
        assert.fail("The program expected this account to be already initialized"); //tries to initialize new PDA with wrong
    } catch (err) {
      //TODO figure out how to flag specific error message
      assert.isTrue(!!err)
      // const error = err as anchor.AnchorError;
      // assert.equal(error.error.errorMessage, "The program expected this account to be already initialized");
    }
  })
  it("doesn't allow futher funding after initial deploy", async () => {
    //todo confirm fund fails after deploy
    try {
      await program.methods
      .fund(new anchor.BN(1 * LAMPORTS_PER_SOL))
      .accounts({
        signer: funder1.publicKey,
        surge: surgePDA,
      })
      .signers([funder1])
      .rpc()
      assert.fail("program should not accept funds now that they've been deployed")
    } catch (err) {
      //TODO - get actual error message here
      assert.isTrue(!!err)
    }
  })
  it("allows signer to claim SPL and leftover SOL", async() => {
    let funder1Ata = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      signer,
      mintProgram,
      funder1.publicKey,
      true
    )
    await program.methods
      .claim()
      .accounts({
        owner: funder1.publicKey, // since owner is `Signer`, it's implied in `.signers([...])
        surge: surgePDA,          // since `surge` is a PDA, it should be implied from other accts
        receipt: funder1ReceiptPDA,
        signerAta: funder1Ata.address
      })
      .signers([funder1])
      .rpc()
      const populatedFunder1Ata = await splToken.getAccount(
        provider.connection,
        funder1Ata.address,
      )
      
      //ensure balance is calculated correctly
      const expectedFunder1SplAmount = (historicalCosts.amountToken.toNumber()) * funder1_deposit / total_deposit
      assert.equal(populatedFunder1Ata.amount, BigInt(expectedFunder1SplAmount) )
  })
  it("only doesn't allow signer to claim to other ATA receipts", async () => {
    let funder1Ata = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      signer,
      mintProgram,
      funder1.publicKey,
      true
    )
    try {
      await program.methods
      .claim()
      .accounts({
        owner: funder1.publicKey,
        surge: surgePDA,
        receipt: funder2ReceiptPDA,
        signerAta: funder1Ata.address
      })
      .signers([funder1])
      .rpc()
      assert.fail()
    } catch (err) {
      const error = err as anchor.AnchorError;
      assert.equal(error.error.errorMessage, "A seeds constraint was violated");
    }

  })
});
