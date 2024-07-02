use anchor_lang::prelude::*;

declare_id!("7Ff787g7SPANts3km5dRKFDo8ytqJVHe5n8GQCdpV9Do");

#[program]
pub mod pump_fun {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
