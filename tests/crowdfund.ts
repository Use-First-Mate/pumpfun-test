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
  const funder1_deposit = 1
  const funder2_deposit = 1.5
  const total_deposit = funder1_deposit + funder2_deposit

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

  const PUMP_ACCOUNTS = {
    GLOBAL: "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
    FEE_RECIPIENT: "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
    EVENT_AUTHORITY: "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
    PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  };
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

  const mintKeyPair = anchor.web3.Keypair.generate()

  let surgeAta
  let mintProgram
  before( async () => {
    const airdropSignature = await provider.connection.requestAirdrop(signer.publicKey, 5 * LAMPORTS_PER_SOL)
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature
    });

    const funder1AirdropSignature = await provider.connection.requestAirdrop(funder1.publicKey, 2 * LAMPORTS_PER_SOL)
    const funder1LatestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: funder1LatestBlockHash.blockhash,
      lastValidBlockHeight: funder1LatestBlockHash.lastValidBlockHeight,
      signature: airdropSignature,
    });

    //This is stub out for allowing surge to purchase tokens directly
    //It is going to "mintTo" a surge ATA a fixed amount of an SPL
    //which will later be claimed by receipt owner
    mintProgram = await splToken.createMint(
      provider.connection,
      signer,
      mintKeyPair.publicKey,
      null,
      9,
      undefined,
      {},
      splToken.TOKEN_PROGRAM_ID
    )
    //create ATA for surge account
    surgeAta = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      signer,
      mintProgram,
      surgePDA,
      true
    )

    console.log("SURGE ATA IS " + surgeAta.address)
    const mint = await splToken.mintTo(
      provider.connection,
      signer,
      mintProgram,
      surgeAta.address,
      mintKeyPair,
      total_deposit * SPL_CONVERSION,
      [],
      undefined,
      splToken.TOKEN_PROGRAM_ID
    )
    const populatedAta = await splToken.getAccount(
      provider.connection,
      surgeAta.address,
    )
    console.log(populatedAta)
  })
  //create an SPL mint that we can use for testing
  //this is a stub, will need to be replaced with interaction w/ pump fun

  it("Is initialized with the correct name", async () => {
      // Airdrop SOL to the signer
      
    const tx = await program.methods
      .initialize("TEST_NAME", new anchor.BN(5 * LAMPORTS_PER_SOL))
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
    const airdropSignature = await provider.connection.requestAirdrop(funder2.publicKey, 2 * LAMPORTS_PER_SOL)
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
    assert.equal(surgeAccount.amountDeposited.toString(), new anchor.BN(total_deposit * LAMPORTS_PER_SOL).toString())
  })
  it("does not accept funds above threshold", async () => {
    //TODO - confirm that when fund are above current threshold (5 sol)
    //fund method fails
  })
  it("doesn't allow users to claim before funds are deployed", async () => {
    //TODO confirm claim fails when called before deploy
  })
  it("allows admin user to deploy funds and deploys funds to that wallet", async () => {
    console.log("Starting allowsadmin test")
    /* await program.methods
      .initialize("Howdy", new anchor.BN(10000))
      .accounts({
        signer: signer.publicKey,
        surge: surgePDA,
      })
      .signers([ signer ])
      .rpc(); */
    console.log("Initialized with Howdy")
    const initialAdminBalance = await provider.connection.getBalance(signer.publicKey)
    //admin user tries to deploy funds and succeeds
    const tx = await program.methods
      .deploy()
      .accounts({
        authority: signer.publicKey,
        pumpGlobal: PUMP_ACCOUNTS.GLOBAL,
        pumpFeeRecipient: PUMP_ACCOUNTS.FEE_RECIPIENT,
        mint: IMPORTED_ACCOUNTS.OGGY_MINT,
        pumpBondingCurve: deriveBondingCurve(IMPORTED_ACCOUNTS.OGGY_MINT),
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
    const surgeAccount = await program.account.surge.fetch(surgePDA)


    /* assert.equal(balanceAfterDeploy, (initialAdminBalance + expectedDepositAmount), "The admin wallet balance in incorrect after deploying funds")
    assert.equal(surgeAccount.splAmount.toString(), (total_deposit * SPL_CONVERSION).toString(), "the SPL has not been correctly deposited") */
  })

  it("disallows unauthorized users from deploying funds", async () => {
    //one of the funders attempts to deploy funds and fails
    try {
      await program.methods
        .deploy()
        .accounts({
          authority: funder1.publicKey,
          pumpGlobal: PUMP_ACCOUNTS.GLOBAL,
          pumpFeeRecipient: PUMP_ACCOUNTS.FEE_RECIPIENT,
          mint: IMPORTED_ACCOUNTS.OGGY_MINT,
          pumpBondingCurve: deriveBondingCurve(IMPORTED_ACCOUNTS.OGGY_MINT),
        })
        .signers([funder1])
        .rpc()
        assert.fail("The program expected this account to be already initialized"); //tries to initialize new PDA with wrong
    } catch (err) {
      console.error(err);
      const error = err as anchor.AnchorError;
      assert.equal(error.error.errorMessage, "The program expected this account to be already initialized");
    }
  })
  it("doesn't allow futher funding after initial deploy", async () => {
    //todo confirm fund fails after deploy
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
        surgeEscrowAta: surgeAta.address,
        signerAta: funder1Ata.address
      })
      .signers([funder1])
      .rpc()
      const populatedFunder1Ata = await splToken.getAccount(
        provider.connection,
        funder1Ata.address,
      )
      console.log(populatedFunder1Ata)
      //TODO - make sure populatedFunder1Ata balance is what is expected
      //
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
        surgeEscrowAta: surgeAta.address,
        signerAta: funder1Ata.address
      })
      .signers([funder1])
      .rpc()
      assert.fail()
    } catch (err) {
      const error = err as anchor.AnchorError;
      assert.equal(error.error.errorMessage, "A has one constraint was violated");
    }

  })
});
