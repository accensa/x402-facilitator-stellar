//! Minimal Soroban account contract used by the x402 smart-account payer
//! conformance run (`npm run e2e:smart-account`, issue #13).
//!
//! An *account contract* is a contract that can act as the source of a
//! payment. When a transaction contains an authorization whose credential
//! address is this contract, the Soroban host calls the contract's
//! `__check_auth` and only lets the call through if it returns `Ok(())`.
//! That is the hook an agent wallet uses to carry a spending policy — the
//! shape this fixture exists to prove works against the facilitator.
//!
//! The interface implemented here is `CustomAccountInterface` from
//! soroban-sdk (the upgraded account interface used by protocol 22+ and the
//! only one current testnet dispatches): the host calls
//! `__check_auth(signature_payload, signatures, auth_context)` regardless of
//! whether the authorization entry in the transaction uses legacy or
//! upgraded credentials. The x402 client and facilitator both speak the
//! legacy `sorobanCredentialsAddress` entry type (see
//! `@x402/stellar`'s `authorizeEntry` and `validateAuthEntries`), which the
//! host converts into this same three-argument call.
//!
//! The structure follows the published reference — the "account" example in
//! `stellar/soroban-examples` (Apache-2.0) — trimmed to the two behaviours
//! this repo needs proof of:
//!
//!   1. a single ed25519 owner key authenticates the account
//!   2. an optional per-authorization spend cap on token `transfer`s
//!
//! The spend cap is deliberately a *per-authorization* cap, matching the
//! published example's documented limitation: a production wallet would
//! want a time-windowed cumulative cap instead. See
//! `test/fixtures/smart-account/README.md` for build/deploy steps.
#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    symbol_short, BytesN, Env, Symbol, TryIntoVal, Vec,
};

#[contract]
struct SmartAccountContract;

/// One ed25519 signature, as carried in a `Credential::Signed` entry.
///
/// The host passes the credential's signature ScVal straight through, so
/// this struct must match the XDR shape `{ public_key: BytesN<32>,
/// signature: BytesN<64> }` exactly.
#[contracttype]
#[derive(Clone)]
pub struct AccSignature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The single ed25519 public key allowed to authenticate this account.
    Owner,
    /// Per-authorization spend cap in stroops; negative means unlimited.
    SpendCap,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SmartAccountError {
    /// The signatures are not exactly the one owner signature.
    UnknownSigner = 1,
    /// The authorized transfer total exceeds the configured spend cap.
    SpendCapExceeded = 2,
    /// A transfer with a negative amount was authorized.
    NegativeAmount = 3,
}

const TRANSFER_FN: Symbol = symbol_short!("transfer");

#[contractimpl]
impl SmartAccountContract {
    /// Deploy-time initialisation (constructor args of `create_custom_contract`).
    ///
    /// `owner` is the raw 32-byte ed25519 public key. `spend_cap` is in
    /// stroops — the same unit x402 prices in; a negative value disables the
    /// cap entirely.
    pub fn __constructor(env: Env, owner: BytesN<32>, spend_cap: i128) {
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::SpendCap, &spend_cap);
    }

    /// Read-only introspection helpers used by the conformance harness to
    /// verify a deployed instance was initialised.
    pub fn owner(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::Owner)
    }

    pub fn spend_cap(env: Env) -> Option<i128> {
        env.storage().instance().get(&DataKey::SpendCap)
    }
}

#[contractimpl]
impl CustomAccountInterface for SmartAccountContract {
    type Signature = Vec<AccSignature>;
    type Error = SmartAccountError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Vec<AccSignature>,
        auth_context: Vec<Context>,
    ) -> Result<(), SmartAccountError> {
        // 1. Authenticate: exactly one signature, and it must be the owner's.
        let owner: BytesN<32> = env.storage().instance().get(&DataKey::Owner).unwrap();
        if signatures.len() != 1 {
            return Err(SmartAccountError::UnknownSigner);
        }
        let signature = signatures.get_unchecked(0);
        if signature.public_key != owner {
            return Err(SmartAccountError::UnknownSigner);
        }
        env.crypto().ed25519_verify(
            &signature.public_key,
            &signature_payload.clone().into(),
            &signature.signature,
        );

        // 2. Spend cap: sum every token transfer the authorization permits
        //    and reject the whole authorization when the total exceeds the
        //    cap. The x402 payment authorizes exactly one `transfer`, but
        //    summing over all contexts keeps the policy honest if the
        //    authorization ever grows sub-invocations.
        let cap: i128 = env.storage().instance().get(&DataKey::SpendCap).unwrap();
        if cap >= 0 {
            let mut total: i128 = 0;
            for context in auth_context.iter() {
                if let Context::Contract(c) = context {
                    if c.fn_name == TRANSFER_FN {
                        // 'amount' is the third argument of the standard
                        // token transfer interface (from, to, amount).
                        let amount: i128 = c
                            .args
                            .get(2)
                            .unwrap()
                            .try_into_val(&env)
                            .unwrap();
                        if amount < 0 {
                            return Err(SmartAccountError::NegativeAmount);
                        }
                        total += amount;
                    }
                }
            }
            if total > cap {
                return Err(SmartAccountError::SpendCapExceeded);
            }
        }
        Ok(())
    }
}

mod test;