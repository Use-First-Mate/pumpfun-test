use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("85oFXf2BbhwsdwP4kbrdxhg5f9gBamehgiL8dFCDAAxg");

#[program]
pub mod crowdfund {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, name: String) -> Result<()> {
        let surge = &mut ctx.accounts.surge;
        surge.name = name;
        surge.amount_deposited = 0;
        surge.admin = *ctx.accounts.signer.key; //equals data, not reference (I think)
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }

    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        let from_account = &ctx.accounts.signer;
        let to_account = &ctx.accounts.surge;
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
        (&mut ctx.accounts.receipt).lamports += amount;
        (&mut ctx.accounts.receipt).claimed = false;
        msg!("User funded program with { } lamports", amount);
        Ok(())
    }

    pub fn deploy(ctx: Context<Deploy>) -> Result<()> {
        let surge = &mut ctx.accounts.surge;
        let signer = &mut ctx.accounts.signer;
        if surge.admin != *signer.key {
            return Err(ErrorCode::NotAdmin.into());
        }
        msg!("Admin deploying program");
        Ok(())
    }
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let surge = &mut ctx.accounts.surge;
        let signer = &mut ctx.accounts.signer;
        let receipt = &mut ctx.accounts.receipt;
        let surge_ata = &ctx.accounts.surge_ata;
        let user_ata = &ctx.accounts.signer_ata;

        if receipt.claimed {
            return Err(ErrorCode::AlreadyClaimed.into());
        }
        //Calculate amount of purchased SPL a user is entitled to
        let total_pool = surge.amount_deposited * 0.95;
        let percentage_share = receipt.lamports / total_pool;
        let claim_amount = percentage_share * total_pool;
        
        //Does signer need to be the surge_ata, since it's the from
        //if so, how do we ensure that surge private key isn't exposed to user
        //seems that a program can sign from PDAs but other programs can't

        //do I need to explicitly check that receipt is tied to the to_account somehow?
        
        //determine entitlement based on claim
        let cpi_accounts = SplTransfer {
            from: surge_ata.to_account_info().clone(),
            to: user_ata.to_account_info().clone(),
            authority: surge.to_account_info().clone(),
        };

        let cpi_program = token_program.to_account_info();

        token::transfer(
            CpiContext::new(cpi_program, cpi_accounts),
            claim_amount)?;
        
        (&mut receipt).claimed = true;
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
        seeds= [b"SURGE".as_ref(), signer.key().as_ref()],
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
        init_if_needed,
        payer = signer,
        space = 8 + 8 + 200,
        seeds = [signer.key().as_ref()],
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
    //What accounts need to be here, signer + surge + whatever is required to interact wit hcontract
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub surge: Account<'info, Surge>
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub signer: Signer<'info>,
    pub surge: Account<'info, Surge>,
    pub receipt: Account<'info, Receipt>,
    #[account(mut)]
    pub surge_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub signer_ata: Account<'info, TokenAccount>
}

#[account]
pub struct Receipt {
    lamports: u64,
    vote: String,
    claimed: bool,
    //does this need an owner - probably not, it's a PDA
}
#[account]
pub struct Surge {
    pub admin: Pubkey,
    pub name: String,
    pub amount_deposited: u64
}

#[error_code]
pub enum ErrorCode {
    #[msg("The signer is not the admin of this surge account.")]
    NotAdmin,
}
pub enum ErrorCode {
    #[msg("The signer has already claimed funds.")]
    AlreadyClaimed,
}