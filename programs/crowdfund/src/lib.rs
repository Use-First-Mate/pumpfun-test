use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::solana_program::pubkey::Pubkey;
use anchor_spl::{associated_token::AssociatedToken, token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer }};
use pump_fun::{BondingCurve, Global, program::Pump};
use pump_fun::cpi::accounts::Buy;

declare_id!("85oFXf2BbhwsdwP4kbrdxhg5f9gBamehgiL8dFCDAAxg");

#[program]
pub mod crowdfund {

    use anchor_lang::system_program::Transfer;

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

    pub fn deploy(ctx: Context<Deploy>, amount_token: u64, max_sol_cost: u64,) -> Result<()> {
        // Calculate the creator fee and deploy amount
        let creator_fee = ctx.accounts.surge.amount_deposited * 5 / 100;
        let deploy_amount = ctx.accounts.surge.amount_deposited - creator_fee;

        let vault_sol_before = ctx.accounts.pda_vault.lamports();
        let vault_token_before = ctx.accounts.pda_vault_ata.amount;
        msg!("vault sol {} ; vault token {}", vault_sol_before, vault_token_before);
        let surge_key = ctx.accounts.surge.key();
        let vault_pda_signer: &[&[u8]] = &[
          b"VAULT",
          surge_key.as_ref(),
          &[ctx.bumps.pda_vault],
        ];
        let all_signers = &[vault_pda_signer];

        let cpi_accounts = Buy {
          user: ctx.accounts.pda_vault.to_account_info(),
          associated_user: ctx.accounts.pda_vault_ata.to_account_info(),

          program: ctx.accounts.pump_program.to_account_info(),

          global: ctx.accounts.pump_global.to_account_info(),
          fee_recipient: ctx.accounts.pump_fee_recipient.to_account_info(),
          mint: ctx.accounts.mint.to_account_info(),
          bonding_curve: ctx.accounts.pump_bonding_curve.to_account_info(),
          associated_bonding_curve: ctx.accounts.pump_bonding_ata.to_account_info(),
          system_program: ctx.accounts.system_program.to_account_info(),
          token_program: ctx.accounts.token_program.to_account_info(),
          rent: ctx.accounts.rent.to_account_info(),
          event_authority: ctx.accounts.pump_event_authority.to_account_info(),
        };

        let cpi_context = CpiContext::new_with_signer(
          ctx.accounts.pump_program.to_account_info(), 
          cpi_accounts, 
          all_signers,
        );
        msg!("about to call out");
        pump_fun::cpi::buy(
          cpi_context, 
          amount_token, 
          max_sol_cost,
        )?;

        msg!(
          "just called out. pda vault bal pre reload {}", 
          ctx.accounts.pda_vault_ata.amount
        );

        // Check balances after
        ctx.accounts.pda_vault_ata.reload()?;

        let vault_sol_after = ctx.accounts.pda_vault.lamports();
        let vault_token_after = ctx.accounts.pda_vault_ata.amount;

        msg!(
          "Sol: {} before, {} after. Token: {} before, {} after. Params: {} token, {} sol",
          vault_sol_before,
          vault_sol_after,
          vault_token_before,
          vault_token_after,
          amount_token,
          max_sol_cost,
        );

        ctx.accounts.surge.spl_amount = vault_token_after;
        ctx.accounts.surge.leftover_sol = vault_sol_after;
        ctx.accounts.surge.mint = ctx.accounts.mint.key();

        // TODO write the mint address into Surge for claims
        Ok(())
    }
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let surge_key = ctx.accounts.surge.key();
        let surge = &mut ctx.accounts.surge;
        let signer = &mut ctx.accounts.owner;
        let receipt = &mut ctx.accounts.receipt;
        let surge_escrow_ata = &ctx.accounts.surge_escrow_ata;
        let user_ata = &ctx.accounts.signer_ata;
        let token_program = &ctx.accounts.token_program;
        let surge_info = surge.to_account_info();
        let signer_info = signer.to_account_info();

        let pda_vault_signer: &[&[u8]] = &[
          b"VAULT",
          surge_key.as_ref(),
          &[ctx.bumps.pda_vault]
        ];
        
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
        let receipt_amt_deposited_128 = u128::from(receipt.amount_deposited);
        let surge_spl_amt_128 = u128::from(surge.spl_amount);
        let surge_total_deposits_128 = u128::from(surge.amount_deposited);
        let surge_leftover_128 = u128::from(surge.leftover_sol);

        let claim_amount_128 = (receipt_amt_deposited_128 * surge_spl_amt_128) / surge_total_deposits_128;
        let sol_claim_amount_128 = (receipt_amt_deposited_128 * surge_leftover_128) / surge_total_deposits_128;

        let claim_amount = u64::try_from(claim_amount_128)?;
        let sol_claim_amount = u64::try_from(sol_claim_amount_128)?;
        //determine entitlement based on claim
        let cpi_accounts = SplTransfer {
            from: ctx.accounts.pda_vault_ata.to_account_info(),
            to: user_ata.to_account_info().clone(),
            authority: ctx.accounts.pda_vault.to_account_info().clone(),
        };

        let cpi_program = token_program.to_account_info();

        token::transfer(
            CpiContext::new_with_signer(
                cpi_program, 
                cpi_accounts, 
                &[pda_vault_signer]
              ),
            claim_amount)?;
        
        //transfer sol share
        anchor_lang::system_program::transfer(
          CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(), 
            Transfer {
              from: ctx.accounts.pda_vault.to_account_info(),
              to: ctx.accounts.owner.to_account_info(),
            }, 
            &[pda_vault_signer]
          ), 
          sol_claim_amount,
        )?;
        
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
    pub pump_global: Account<'info, Global>,
    #[account(mut, /* address = CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM */)]
    pub pump_fee_recipient: SystemAccount<'info>,
    #[account()]
    pub mint: Account<'info, anchor_spl::token::Mint>,
    #[account(mut)]
    pub pump_bonding_curve: Account<'info, BondingCurve>,
    #[account(mut, seeds=[b"VAULT".as_ref(), surge.key().as_ref()], bump)]
    pub pda_vault: SystemAccount<'info>,
    #[account(
      init,
      payer = authority,
      associated_token::mint = mint,
      associated_token::authority = pda_vault,
    )]
    pub pda_vault_ata: Account<'info, TokenAccount>,
    #[account(
      mut,
      associated_token::mint = mint,
      associated_token::authority = pump_bonding_curve,
    )]
    pub pump_bonding_ata: Account<'info, TokenAccount>,
    #[account()]
    pub token_program: Program<'info, Token>,
    #[account()]
    pub associated_token_program: Program<'info, AssociatedToken>,
    #[account()]
    pub rent: Sysvar<'info, Rent>,
    /// CHECK: only used within pumpfun program
    #[account( address= pubkey!("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"))]
    pub pump_event_authority: UncheckedAccount<'info>,
    #[account(address = pump_fun::ID)]
    pub pump_program: Program<'info, Pump>,
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
    #[account(mut, seeds=[b"VAULT".as_ref(), surge.key().as_ref()], bump)]
    pub pda_vault: SystemAccount<'info>,
    #[account(
      mut,
      associated_token::mint = surge.mint,
      associated_token::authority = pda_vault,
    )]
    pub pda_vault_ata: Account<'info, TokenAccount>,
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
    pub system_program: Program<'info, System>,

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
    pub spl_address: Pubkey, // todo make this Account<'info, Mint>
    pub mint: Pubkey,
    pub leftover_sol: u64,
    pub bump: u8,
}

#[error_code]
pub enum ErrorCode {
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