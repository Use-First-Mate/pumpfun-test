use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer };

declare_id!("85oFXf2BbhwsdwP4kbrdxhg5f9gBamehgiL8dFCDAAxg");

#[program]
pub mod crowdfund {

    use super::*;

    pub fn initialize(ctx: Context<Initialize>, name: String, threshold: u64) -> Result<()> {
        let surge = &mut ctx.accounts.surge;
        surge.name = name;
        surge.amount_deposited = 0;
        surge.authority = *ctx.accounts.signer.key; //equals data, not reference (I think)
        surge.bump = ctx.bumps.surge;
        surge.threshold = threshold; 
        Ok(())
    }

    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        let from_account = &ctx.accounts.signer;
        let to_account = &ctx.accounts.surge;
        if to_account.spl_amount > 0 {
            return Err(ErrorCode::DepositsClosed.into())
        }
        //if surge is already above threshold - then stop
        //I wonder if there's an issue here if threshold is
        //
        if to_account.amount_deposited > to_account.threshold {
            return Err(ErrorCode::DepositsClosed.into())
        }
        //add explicit check that .claimed is false and not true
        let transfer_instruction = system_instruction::transfer(
            &from_account.key(), 
            &to_account.key(), amount
        );
        
        let result = anchor_lang::solana_program::program::invoke(
            &transfer_instruction, 
            &[
             from_account.to_account_info(),
             to_account.to_account_info()
            ]);
        if let Err(e) = result {
            return Err(e.into())
        }

        //Update total campaign value
        //Update individual account amount
        (&mut ctx.accounts.surge).amount_deposited += amount;
        (&mut ctx.accounts.receipt).amount_deposited += amount;
        (&mut ctx.accounts.receipt).claimed = false;
        (&mut ctx.accounts.receipt).owner = from_account.key().clone();

        msg!("User funded program with { } lamports", amount);
        Ok(())
    }

    pub fn deploy(ctx: Context<Deploy>) -> Result<()> {
        // Calculate the creator fee and deploy amount
        let creator_fee = ctx.accounts.surge.amount_deposited * 5 / 100;
        let deploy_amount = ctx.accounts.surge.amount_deposited - creator_fee;

        // Perform the transfer
        let surge_info = ctx.accounts.surge.to_account_info();
        let signer_info = ctx.accounts.authority.to_account_info();

        **surge_info.try_borrow_mut_lamports()? -= creator_fee;
        **signer_info.try_borrow_mut_lamports()? += creator_fee;

        // Update the SPL_amount field - hardcoded based on what is
        // deployed in "mint_to"
        //TODO use deploy amount to buy token, and update spl_amount based on purchased token
        ctx.accounts.surge.spl_amount = 45_000;
        //Stub out setting remaining solana amount after deploy
        ctx.accounts.surge.leftover_sol = deploy_amount; //in future this will be a lot less
        msg!("Admin deploying program");
        Ok(())
    }
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let surge = &mut ctx.accounts.surge;
        let signer = &mut ctx.accounts.owner;
        let receipt = &mut ctx.accounts.receipt;
        let surge_escrow_ata = &ctx.accounts.surge_escrow_ata;
        let user_ata = &ctx.accounts.signer_ata;
        let token_program = &ctx.accounts.token_program;
        let surge_info = surge.to_account_info();
        let signer_info = signer.to_account_info();
        
        if surge.spl_amount <= 0 {
            return Err(ErrorCode::ClaimNotOpen.into())
        }
        //do I need to explicitly check that receipt is tied to the to_account somehow?
        //yeah probably - need someway to secure that when tokens are claimed, they can only be claimed to the entitled account
        if receipt.claimed {
            return Err(ErrorCode::AlreadyClaimed.into());
        }

        //Do I additionally need to confirm that the user_ata is linked to the signer
        //i.e. is it currently an attack vector that anyone could pass in any user_ata
        //right now, given that the person who triggers via signing has to have their pubkey on the receipt it's fine
        //basically, only the "owner" of the funds could take advantage by passing in a different ata

        //Calculate amount of purchased SPL a user is entitled to
        let claim_amount = (receipt.amount_deposited * surge.spl_amount) / surge.amount_deposited;
        let sol_claim_amount = (receipt.amount_deposited * surge.leftover_sol) / surge.amount_deposited;
        //determine entitlement based on claim
        let cpi_accounts = SplTransfer {
            from: surge_escrow_ata.to_account_info().clone(),
            to: user_ata.to_account_info().clone(),
            authority: surge.to_account_info().clone(),
        };

        let cpi_program = token_program.to_account_info();

        token::transfer(
            CpiContext::new_with_signer(
                cpi_program, 
                cpi_accounts, 
                &[&["SURGE".as_bytes(), ctx.accounts.surge.authority.as_ref(), &[ctx.accounts.surge.bump]]]),
            claim_amount)?;
        
        //transfer sol share
        **surge_info.try_borrow_mut_lamports()? -= sol_claim_amount;
        **signer_info.try_borrow_mut_lamports()? += sol_claim_amount;
        
        receipt.claimed = true;
        msg!("user claiming token");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = signer,
        space = 500,
        seeds= [b"SURGE".as_ref(), signer.key().as_ref()], //kind of wonder if this should be unique - i.e. just surge
        bump
    )]
    pub surge: Account<'info, Surge>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>, //To allow the campaign account to be created
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(
        init,
        payer = signer,
        space = 8 + 8 + 200,
        seeds = [signer.key().as_ref()], //if we do multiple surge's per contract the surge should have a receipt
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub surge: Account<'info, Surge>,
    pub system_program: Program<'info, System>, //To allow the recepit account to be created
}

#[derive(Accounts)]
pub struct Deploy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"SURGE".as_ref(), authority.key().as_ref()], //ensures signer is linked to surge
        bump,
        has_one = authority //ensures that the authority field matches authority.publicKey
    )]
    pub surge: Account<'info, Surge>,
    //pub mint: Account<'info, Mint>,
    //an escrow token account needs to be created here - this is where SPLs will be claimed to
    //it's owned by the Surge account, which is owned by the program - surge will need to be the authority
    //when transferring from the surge escrow ata
    // #[account(
    //     init,
    //     payer = signer,
    //     token::mint = mint,
    //     token::authority = surge
    // )]
    // pub surge_escrow_ata: Account<'info, TokenAccount>,
    //need account to transfer 5% of sol to
    //pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds=[b"SURGE".as_ref(), surge.authority.as_ref()],
        bump=surge.bump
    )]
    pub surge: Account<'info, Surge>,
    #[account(
        mut,
        has_one = owner
    )]
    pub receipt: Account<'info, Receipt>,
    #[account(mut)]
    pub surge_escrow_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub signer_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,

}

#[account]
pub struct Receipt {
    amount_deposited: u64,
    vote: Pubkey,
    claimed: bool,
    owner: Pubkey,
}
#[account]
pub struct Surge {
    pub authority: Pubkey,
    pub name: String,
    pub amount_deposited: u64,
    pub threshold: u64,
    pub spl_amount: u64,
    pub spl_address: Pubkey,
    pub leftover_sol: u64,
    pub bump: u8,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Account has already been initialized")]
    AlreadyInitialized,
    #[msg("The signer is not the authority of this surge account.")]
    NotAuthority,
    #[msg("The signer has already claimed funds.")]
    AlreadyClaimed,
    #[msg("Not authorized to claim.")]
    NotAuthorizedToClaim,
    #[msg("deposits closed")]
    DepositsClosed,
    #[msg("Funds not deployed yet")]
    ClaimNotOpen
}